import { PWHASH_SALT_BYTES, PUBLIC_KEY_BYTES, SECRET_KEY_BYTES } from "../crypto/constants";
import { fromBase64, fromBase64Flexible, fromHex, toBase64, toBase64Url, toHexUpper } from "../crypto/encoding";
import { createAlbumMaterial, openAlbumName, openAlbumPrivateKey } from "../crypto/album";
import { decryptPlaintextRange, encryptFileBytes, MemoryByteSource, openFileHeader, sealOpenedFileHeader, type OpenedFileHeader } from "../crypto/file";
import {
  createEncryptedKeyBundle,
  encryptParamsForServer,
  generateKeyPair,
  parseEncryptedKeyBundleBase64,
  unlockKeyBundle,
  type KeyPair,
} from "../crypto/keys";
import { passwordHashForStorage } from "../crypto/pwhash";
import { entropyToMnemonic } from "../crypto/mnemonic";
import { ready } from "../crypto/sodium";

export interface PreparedRegistration {
  accountSaltHex: string;
  passwordHash: string;
  keyBundleBase64: string;
  publicKeyBase64: string;
  recoveryPhrase: string;
}

export interface PersistedAuthSession {
  token: string;
  email: string;
  userId: string;
  homeFolder: string;
  isKeyBackedUp: boolean;
  addons: string[];
}

interface StoredVaultSession {
  version: 1;
  key: CryptoKey;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

const SESSION_DB = "stingle-secure-session-v1";
const SESSION_STORE = "vault";
const SESSION_KEY = "current";
const SESSION_AAD = new TextEncoder().encode("stingle-web-session-v1");

function sessionDatabase(): Promise<IDBDatabase | undefined> {
  if (!("indexedDB" in globalThis) || !globalThis.indexedDB) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(SESSION_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SESSION_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("session database could not be opened"));
  });
}

async function readStoredSession(): Promise<StoredVaultSession | undefined> {
  const database = await sessionDatabase();
  if (!database) return undefined;
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(SESSION_STORE, "readonly").objectStore(SESSION_STORE).get(SESSION_KEY);
      request.onsuccess = () => resolve(request.result as StoredVaultSession | undefined);
      request.onerror = () => reject(request.error ?? new Error("session could not be read"));
    });
  } finally {
    database.close();
  }
}

async function writeStoredSession(record: StoredVaultSession): Promise<void> {
  const database = await sessionDatabase();
  if (!database) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readwrite");
      transaction.objectStore(SESSION_STORE).put(record, SESSION_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("session could not be stored"));
      transaction.onabort = () => reject(transaction.error ?? new Error("session storage was aborted"));
    });
  } finally {
    database.close();
  }
}

async function deleteStoredSession(): Promise<void> {
  const database = await sessionDatabase();
  if (!database) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readwrite");
      transaction.objectStore(SESSION_STORE).delete(SESSION_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("session could not be cleared"));
      transaction.onabort = () => reject(transaction.error ?? new Error("session clearing was aborted"));
    });
  } finally {
    database.close();
  }
}

export interface EncryptedAlbumDescriptor {
  albumId: string;
  publicKey: string;
  encPrivateKey: string;
  metadata: string;
}

export interface EncryptedFileDescriptor {
  id: string;
  headers: string;
  albumId?: string;
}

export interface DecryptedAlbumSummary {
  albumId: string;
  name?: string;
  error?: true;
}

export interface DecryptedFileSummary {
  id: string;
  filename?: string;
  fileType?: number;
  dataSize?: string;
  videoDuration?: number;
  error?: true;
}

export interface DecryptedLibrarySnapshot {
  albums: DecryptedAlbumSummary[];
  files: DecryptedFileSummary[];
}

export interface PreparedAlbum {
  albumId: string;
  encPrivateKey: string;
  publicKey: string;
  metadata: string;
  dateCreated: number;
  dateModified: number;
}

export interface PreparedUpload {
  file: string;
  headers: string;
  encryptedFile: Uint8Array;
  encryptedThumb: Uint8Array;
}

export interface Vault {
  deriveLoginHash(password: string, accountSaltHex: string): Promise<string>;
  prepareRegistration(password: string): Promise<PreparedRegistration>;
  unlockSession(password: string, keyBundleBase64: string, serverPublicKeyBase64: string): Promise<void>;
  encryptParams(params: unknown): Promise<string>;
  decryptLibrary(albums: EncryptedAlbumDescriptor[], files: EncryptedFileDescriptor[]): Promise<DecryptedLibrarySnapshot>;
  openMediaHeader(headers: string, isThumb: boolean, album?: EncryptedAlbumDescriptor): Promise<OpenedFileHeader>;
  decryptFileBlob(encryptedBlob: Uint8Array, headers: string, isThumb: boolean, album?: EncryptedAlbumDescriptor): Promise<Uint8Array>;
  createAlbum(name: string, timestamp: number): Promise<PreparedAlbum>;
  resealFileHeaders(headers: string, sourceAlbum?: EncryptedAlbumDescriptor, targetAlbum?: EncryptedAlbumDescriptor): Promise<string>;
  prepareUpload(original: Uint8Array, thumbnail: Uint8Array, filename: string, fileType: 2 | 3, videoDuration: number, album?: EncryptedAlbumDescriptor): Promise<PreparedUpload>;
  persistSession(session: PersistedAuthSession): Promise<void>;
  restoreSession(): Promise<PersistedAuthSession | undefined>;
  clear(): Promise<void>;
  terminate?(): void;
}

export class VaultCore implements Vault {
  private keyPair: KeyPair | undefined;
  private serverPublicKey: Uint8Array | undefined;

  async deriveLoginHash(password: string, accountSaltHex: string): Promise<string> {
    const salt = await fromHex(accountSaltHex);
    return passwordHashForStorage(password, salt);
  }

  async prepareRegistration(password: string): Promise<PreparedRegistration> {
    await this.clear();
    const sodium = await ready();
    const keyPair = await generateKeyPair();
    const accountSalt = sodium.randombytes_buf(PWHASH_SALT_BYTES);
    try {
      // Both password operations use the 256 MiB MODERATE profile. Keep them
      // sequential so registration does not transiently allocate ~512 MiB.
      const passwordHash = await passwordHashForStorage(password, accountSalt);
      const keyBundleBase64 = await createEncryptedKeyBundle(keyPair, password);
      const accountSaltHex = await toHexUpper(accountSalt);
      const publicKeyBase64 = await toBase64(keyPair.publicKey);
      const recoveryPhrase = await entropyToMnemonic(keyPair.privateKey);
      this.keyPair = keyPair;
      return { accountSaltHex, passwordHash, keyBundleBase64, publicKeyBase64, recoveryPhrase };
    } catch (error) {
      sodium.memzero(keyPair.privateKey);
      throw error;
    } finally {
      sodium.memzero(accountSalt);
    }
  }

  async unlockSession(
    password: string,
    keyBundleBase64: string,
    serverPublicKeyBase64: string,
  ): Promise<void> {
    const bundle = await parseEncryptedKeyBundleBase64(keyBundleBase64);
    const nextKeyPair = await unlockKeyBundle(bundle, password);
    const nextServerPublicKey = await fromBase64(serverPublicKeyBase64);
    if (nextServerPublicKey.byteLength !== PUBLIC_KEY_BYTES) {
      (await ready()).memzero(nextKeyPair.privateKey);
      throw new Error("server public key must be 32 bytes");
    }
    await this.clear();
    this.keyPair = nextKeyPair;
    this.serverPublicKey = nextServerPublicKey;
  }

  async encryptParams(params: unknown): Promise<string> {
    if (!this.keyPair || !this.serverPublicKey) throw new Error("crypto vault is locked");
    return encryptParamsForServer(params, this.serverPublicKey, this.keyPair.privateKey);
  }

  async decryptLibrary(
    albums: EncryptedAlbumDescriptor[],
    files: EncryptedFileDescriptor[],
  ): Promise<DecryptedLibrarySnapshot> {
    if (!this.keyPair) throw new Error("crypto vault is locked");
    if (albums.length > 100_000 || files.length > 1_000_000) throw new Error("library snapshot is too large");
    const sodium = await ready();
    const albumKeys = new Map<string, KeyPair>();
    const albumResults: DecryptedAlbumSummary[] = [];
    try {
      for (const album of albums) {
        try {
          const publicKey = await fromBase64Flexible(album.publicKey);
          const privateKey = await openAlbumPrivateKey(
            await fromBase64Flexible(album.encPrivateKey),
            this.keyPair.publicKey,
            this.keyPair.privateKey,
          );
          albumKeys.set(album.albumId, { publicKey, privateKey });
          albumResults.push({
            albumId: album.albumId,
            name: await openAlbumName(await fromBase64Flexible(album.metadata), publicKey, privateKey),
          });
        } catch {
          albumResults.push({ albumId: album.albumId, error: true });
        }
      }

      const fileResults: DecryptedFileSummary[] = [];
      for (const file of files) {
        try {
          const keyPair = file.albumId ? albumKeys.get(file.albumId) : this.keyPair;
          if (!keyPair) throw new Error("album key is unavailable");
          const encodedHeader = file.headers.split("*", 1)[0]?.trim();
          if (!encodedHeader) throw new Error("file header is missing");
          const header = await openFileHeader(
            await fromBase64Flexible(encodedHeader),
            keyPair.publicKey,
            keyPair.privateKey,
          );
          fileResults.push({
            id: file.id,
            filename: header.filename,
            fileType: header.fileType,
            dataSize: header.dataSize.toString(),
            videoDuration: header.videoDuration,
          });
        } catch {
          fileResults.push({ id: file.id, error: true });
        }
      }
      return { albums: albumResults, files: fileResults };
    } finally {
      for (const keyPair of albumKeys.values()) sodium.memzero(keyPair.privateKey);
      albumKeys.clear();
    }
  }

  private async openStoredHeader(
    headers: string,
    isThumb: boolean,
    album?: EncryptedAlbumDescriptor,
  ): Promise<{ header: OpenedFileHeader; temporaryPrivateKey?: Uint8Array }> {
    if (!this.keyPair) throw new Error("crypto vault is locked");
    let recipient = this.keyPair;
    let temporaryPrivateKey: Uint8Array | undefined;
    if (album) {
      const publicKey = await fromBase64Flexible(album.publicKey);
      temporaryPrivateKey = await openAlbumPrivateKey(
        await fromBase64Flexible(album.encPrivateKey),
        this.keyPair.publicKey,
        this.keyPair.privateKey,
      );
      recipient = { publicKey, privateKey: temporaryPrivateKey };
    }
    try {
      const parts = headers.split("*");
      const encoded = parts[isThumb ? 1 : 0]?.trim();
      if (!encoded) throw new Error(isThumb ? "thumbnail header is missing" : "file header is missing");
      const header = await openFileHeader(await fromBase64Flexible(encoded), recipient.publicKey, recipient.privateKey);
      return temporaryPrivateKey ? { header, temporaryPrivateKey } : { header };
    } catch (error) {
      if (temporaryPrivateKey) (await ready()).memzero(temporaryPrivateKey);
      throw error;
    }
  }

  async openMediaHeader(
    headers: string,
    isThumb: boolean,
    album?: EncryptedAlbumDescriptor,
  ): Promise<OpenedFileHeader> {
    const opened = await this.openStoredHeader(headers, isThumb, album);
    if (opened.temporaryPrivateKey) (await ready()).memzero(opened.temporaryPrivateKey);
    return opened.header;
  }

  async decryptFileBlob(
    encryptedBlob: Uint8Array,
    headers: string,
    isThumb: boolean,
    album?: EncryptedAlbumDescriptor,
  ): Promise<Uint8Array> {
    const opened = await this.openStoredHeader(headers, isThumb, album);
    try {
      if (opened.header.dataSize === 0n) return new Uint8Array();
      return await decryptPlaintextRange(
        new MemoryByteSource(encryptedBlob),
        opened.header,
        0n,
        opened.header.dataSize - 1n,
      );
    } finally {
      const sodium = await ready();
      sodium.memzero(opened.header.symmetricKey);
      if (opened.temporaryPrivateKey) sodium.memzero(opened.temporaryPrivateKey);
    }
  }

  async createAlbum(name: string, timestamp: number): Promise<PreparedAlbum> {
    if (!this.keyPair) throw new Error("crypto vault is locked");
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("invalid album timestamp");
    const album = await createAlbumMaterial(name, this.keyPair.publicKey);
    return { ...album, dateCreated: timestamp, dateModified: timestamp };
  }

  async resealFileHeaders(
    headers: string,
    sourceAlbum?: EncryptedAlbumDescriptor,
    targetAlbum?: EncryptedAlbumDescriptor,
  ): Promise<string> {
    if (!this.keyPair) throw new Error("crypto vault is locked");
    const sodium = await ready();
    let sourcePrivateKey: Uint8Array | undefined;
    let sourcePublicKey = this.keyPair.publicKey;
    try {
      if (sourceAlbum) {
        sourcePublicKey = await fromBase64Flexible(sourceAlbum.publicKey);
        sourcePrivateKey = await openAlbumPrivateKey(
          await fromBase64Flexible(sourceAlbum.encPrivateKey),
          this.keyPair.publicKey,
          this.keyPair.privateKey,
        );
      }
      const targetPublicKey = targetAlbum
        ? await fromBase64Flexible(targetAlbum.publicKey)
        : this.keyPair.publicKey;
      const parts = headers.split("*");
      if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
        throw new Error("file and thumbnail headers are required");
      }
      const resealed: string[] = [];
      for (const encoded of parts) {
        const opened = await openFileHeader(
          await fromBase64Flexible(encoded),
          sourcePublicKey,
          sourcePrivateKey ?? this.keyPair.privateKey,
        );
        try {
          resealed.push(await toBase64Url(await sealOpenedFileHeader(opened, targetPublicKey)));
        } finally {
          sodium.memzero(opened.symmetricKey);
        }
      }
      return resealed.join("*");
    } finally {
      if (sourcePrivateKey) sodium.memzero(sourcePrivateKey);
    }
  }

  async prepareUpload(
    original: Uint8Array,
    thumbnail: Uint8Array,
    filename: string,
    fileType: 2 | 3,
    videoDuration: number,
    album?: EncryptedAlbumDescriptor,
  ): Promise<PreparedUpload> {
    if (!this.keyPair) throw new Error("crypto vault is locked");
    if (!filename || new TextEncoder().encode(filename).byteLength > 16_384) throw new Error("invalid upload filename");
    if (!Number.isSafeInteger(videoDuration) || videoDuration < 0 || videoDuration > 0xffff_ffff) {
      throw new Error("invalid video duration");
    }
    const sodium = await ready();
    const fileId = sodium.randombytes_buf(32);
    const recipientPublicKey = album ? await fromBase64Flexible(album.publicKey) : this.keyPair.publicKey;
    const encryptedFile = await encryptFileBytes(original, { filename, fileType, recipientPublicKey, fileId, videoDuration });
    const encryptedThumb = await encryptFileBytes(thumbnail, { filename, fileType, recipientPublicKey, fileId, videoDuration });
    try {
      return {
        file: `${sodium.to_hex(sodium.randombytes_buf(16))}.sp`,
        headers: `${await toBase64Url(encryptedFile.outerHeader)}*${await toBase64Url(encryptedThumb.outerHeader)}`,
        encryptedFile: encryptedFile.blob,
        encryptedThumb: encryptedThumb.blob,
      };
    } finally {
      sodium.memzero(encryptedFile.header.symmetricKey);
      sodium.memzero(encryptedThumb.header.symmetricKey);
      sodium.memzero(fileId);
    }
  }

  async persistSession(session: PersistedAuthSession): Promise<void> {
    if (!this.keyPair || !this.serverPublicKey) throw new Error("crypto vault is locked");
    if (!("indexedDB" in globalThis) || !globalThis.indexedDB) return;
    const metadata = new TextEncoder().encode(JSON.stringify(session));
    const plaintext = new Uint8Array(SECRET_KEY_BYTES + PUBLIC_KEY_BYTES + PUBLIC_KEY_BYTES + 4 + metadata.byteLength);
    plaintext.set(this.keyPair.privateKey, 0);
    plaintext.set(this.keyPair.publicKey, SECRET_KEY_BYTES);
    plaintext.set(this.serverPublicKey, SECRET_KEY_BYTES + PUBLIC_KEY_BYTES);
    new DataView(plaintext.buffer).setUint32(SECRET_KEY_BYTES + PUBLIC_KEY_BYTES * 2, metadata.byteLength, false);
    plaintext.set(metadata, SECRET_KEY_BYTES + PUBLIC_KEY_BYTES * 2 + 4);
    try {
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: SESSION_AAD }, key, plaintext);
      await writeStoredSession({ version: 1, key, iv: iv.buffer.slice(0), ciphertext });
    } finally {
      (await ready()).memzero(plaintext);
    }
  }

  async restoreSession(): Promise<PersistedAuthSession | undefined> {
    const record = await readStoredSession();
    if (!record) return undefined;
    let plaintext: Uint8Array | undefined;
    try {
      if (record.version !== 1 || !(record.key instanceof CryptoKey)) throw new Error("unsupported saved session");
      plaintext = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: record.iv, additionalData: SESSION_AAD },
        record.key,
        record.ciphertext,
      ));
      const fixedSize = SECRET_KEY_BYTES + PUBLIC_KEY_BYTES * 2 + 4;
      if (plaintext.byteLength < fixedSize) throw new Error("saved session is truncated");
      const privateKey = plaintext.slice(0, SECRET_KEY_BYTES);
      const publicKey = plaintext.slice(SECRET_KEY_BYTES, SECRET_KEY_BYTES + PUBLIC_KEY_BYTES);
      const serverPublicKey = plaintext.slice(SECRET_KEY_BYTES + PUBLIC_KEY_BYTES, SECRET_KEY_BYTES + PUBLIC_KEY_BYTES * 2);
      const metadataLength = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(SECRET_KEY_BYTES + PUBLIC_KEY_BYTES * 2, false);
      if (metadataLength !== plaintext.byteLength - fixedSize) throw new Error("saved session metadata is invalid");
      const derivedPublicKey = (await ready()).crypto_scalarmult_base(privateKey);
      if (!derivedPublicKey.every((value, index) => value === publicKey[index])) throw new Error("saved identity key is invalid");
      const session = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext.subarray(fixedSize))) as PersistedAuthSession;
      if (!session || typeof session.token !== "string" || typeof session.email !== "string" ||
        typeof session.userId !== "string" || typeof session.homeFolder !== "string" ||
        typeof session.isKeyBackedUp !== "boolean" || !Array.isArray(session.addons) ||
        !session.addons.every((addon) => typeof addon === "string")) {
        throw new Error("saved session fields are invalid");
      }
      const sodium = await ready();
      if (this.keyPair) sodium.memzero(this.keyPair.privateKey);
      if (this.serverPublicKey) sodium.memzero(this.serverPublicKey);
      this.keyPair = { privateKey, publicKey };
      this.serverPublicKey = serverPublicKey;
      return session;
    } catch {
      await deleteStoredSession().catch(() => undefined);
      return undefined;
    } finally {
      if (plaintext) (await ready()).memzero(plaintext);
    }
  }

  async clear(): Promise<void> {
    const sodium = await ready();
    if (this.keyPair) sodium.memzero(this.keyPair.privateKey);
    if (this.serverPublicKey) sodium.memzero(this.serverPublicKey);
    this.keyPair = undefined;
    this.serverPublicKey = undefined;
    await deleteStoredSession();
  }
}
