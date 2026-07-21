import type { DecryptedLibrarySnapshot, EncryptedAlbumDescriptor, EncryptedFileDescriptor, PersistedAuthSession, PreparedAlbum, PreparedRegistration, PreparedUpload, Vault } from "./vault-core";
import type { OpenedFileHeader } from "../crypto/file";
import type { VaultOperation, VaultReply, VaultResult } from "./vault-protocol";

interface PendingRequest {
  resolve(value: VaultResult): void;
  reject(reason: Error): void;
}

export class WorkerVault implements Vault {
  private readonly worker = new Worker(new URL("./vault.worker.ts", import.meta.url), {
    type: "module",
    name: "stingle-crypto-vault",
  });
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;

  constructor() {
    this.worker.addEventListener("message", (event: MessageEvent<VaultReply>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) request.resolve(event.data.result);
      else request.reject(new Error(event.data.error));
    });
    this.worker.addEventListener("error", () => {
      for (const request of this.pending.values()) request.reject(new Error("Crypto worker crashed."));
      this.pending.clear();
    });
  }

  private request(operation: VaultOperation, transfer: Transferable[] = []): Promise<VaultResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation }, transfer);
    });
  }

  async deriveLoginHash(password: string, accountSaltHex: string): Promise<string> {
    return (await this.request({ type: "derive-login-hash", password, accountSaltHex })) as string;
  }

  async prepareRegistration(password: string): Promise<PreparedRegistration> {
    return (await this.request({ type: "prepare-registration", password })) as PreparedRegistration;
  }

  async unlockSession(
    password: string,
    keyBundleBase64: string,
    serverPublicKeyBase64: string,
  ): Promise<void> {
    await this.request({ type: "unlock-session", password, keyBundleBase64, serverPublicKeyBase64 });
  }

  async encryptParams(params: unknown): Promise<string> {
    return (await this.request({ type: "encrypt-params", params })) as string;
  }

  async decryptLibrary(
    albums: EncryptedAlbumDescriptor[],
    files: EncryptedFileDescriptor[],
  ): Promise<DecryptedLibrarySnapshot> {
    return (await this.request({ type: "decrypt-library", albums, files })) as DecryptedLibrarySnapshot;
  }

  async openMediaHeader(
    headers: string,
    isThumb: boolean,
    album?: EncryptedAlbumDescriptor,
  ): Promise<OpenedFileHeader> {
    return (await this.request({ type: "open-media-header", headers, isThumb, ...(album ? { album } : {}) })) as OpenedFileHeader;
  }

  async decryptFileBlob(
    encryptedBlob: Uint8Array,
    headers: string,
    isThumb: boolean,
    album?: EncryptedAlbumDescriptor,
  ): Promise<Uint8Array> {
    return (await this.request({
      type: "decrypt-file-blob",
      encryptedBlob,
      headers,
      isThumb,
      ...(album ? { album } : {}),
    })) as Uint8Array;
  }

  async createAlbum(name: string, timestamp: number): Promise<PreparedAlbum> {
    return (await this.request({ type: "create-album", name, timestamp })) as PreparedAlbum;
  }

  async resealFileHeaders(
    headers: string,
    sourceAlbum?: EncryptedAlbumDescriptor,
    targetAlbum?: EncryptedAlbumDescriptor,
  ): Promise<string> {
    return (await this.request({
      type: "reseal-file-headers",
      headers,
      ...(sourceAlbum ? { sourceAlbum } : {}),
      ...(targetAlbum ? { targetAlbum } : {}),
    })) as string;
  }

  async persistSession(session: PersistedAuthSession): Promise<void> {
    await this.request({ type: "persist-session", session });
  }

  async prepareUpload(
    original: Uint8Array,
    thumbnail: Uint8Array,
    filename: string,
    fileType: 2 | 3,
    videoDuration: number,
    album?: EncryptedAlbumDescriptor,
  ): Promise<PreparedUpload> {
    return (await this.request({
      type: "prepare-upload", original, thumbnail, filename, fileType, videoDuration,
      ...(album ? { album } : {}),
    }, [original.buffer, thumbnail.buffer])) as PreparedUpload;
  }

  async restoreSession(): Promise<PersistedAuthSession | undefined> {
    return (await this.request({ type: "restore-session" })) as PersistedAuthSession | undefined;
  }

  async clear(): Promise<void> {
    await this.request({ type: "clear" });
  }

  terminate(): void {
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(new Error("Crypto vault terminated."));
    this.pending.clear();
  }
}
