import type { EncryptedUploadRequest, LoginResult, RegistrationRequest } from "../api/client";
import type { DecryptedLibrarySnapshot, EncryptedAlbumDescriptor, EncryptedFileDescriptor, PreparedAlbum, Vault } from "./vault-core";
import type { OpenedFileHeader } from "../crypto/file";
import type { SyncCursors, SyncUpdates } from "../sync/model";

export interface AuthSession {
  email: string;
  userId: string;
  homeFolder: string;
  isKeyBackedUp: boolean;
  addons: string[];
}

interface PrivateSession extends AuthSession {
  token: string;
}

export type SessionListener = (session: AuthSession | undefined) => void;

export interface AccountCreationResult {
  session: AuthSession;
  recoveryPhrase: string;
}

export interface AuthApi {
  preLogin(email: string): Promise<string>;
  login(email: string, passwordHash: string): Promise<LoginResult>;
  createAccount(input: RegistrationRequest): Promise<void>;
  logout(token: string): Promise<void>;
  getUpdates(token: string, cursors: SyncCursors): Promise<SyncUpdates>;
  downloadEncrypted(token: string, file: string, set: number, isThumb: boolean, signal?: AbortSignal): Promise<Uint8Array>;
  getDownloadUrl(token: string, file: string, set: number): Promise<string>;
  addAlbum(token: string, params: string): Promise<void>;
  moveFiles(token: string, params: string): Promise<void>;
  deleteFiles(token: string, params: string): Promise<void>;
  emptyTrash(token: string, params: string): Promise<void>;
  deleteAlbum(token: string, params: string): Promise<void>;
  changeAlbumCover(token: string, params: string): Promise<void>;
  uploadEncrypted(token: string, input: EncryptedUploadRequest): Promise<void>;
}

export interface MutationFile {
  file: string;
  headers: string;
  isRemote: boolean;
}

export interface MoveFilesInput {
  files: MutationFile[];
  setFrom: 0 | 1 | 2;
  setTo: 0 | 1 | 2;
  sourceAlbum?: EncryptedAlbumDescriptor;
  targetAlbum?: EncryptedAlbumDescriptor;
  isMoving: boolean;
}

export interface UploadedFileRef {
  file: string;
  headers: string;
  version: number;
  dateCreated: number;
  dateModified: number;
  albumId?: string;
}

function publicSession(session: PrivateSession): AuthSession {
  return {
    email: session.email,
    userId: session.userId,
    homeFolder: session.homeFolder,
    isKeyBackedUp: session.isKeyBackedUp,
    addons: [...session.addons],
  };
}

export class AuthService {
  private session: PrivateSession | undefined;
  private readonly listeners = new Set<SessionListener>();

  constructor(
    private readonly api: AuthApi,
    private readonly vault: Vault,
  ) {}

  get currentSession(): AuthSession | undefined {
    return this.session ? publicSession(this.session) : undefined;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    listener(this.currentSession);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    const snapshot = this.currentSession;
    for (const listener of this.listeners) listener(snapshot);
  }

  private async acceptLogin(email: string, password: string, result: LoginResult): Promise<AuthSession> {
    try {
      await this.vault.unlockSession(password, result.keyBundle, result.serverPublicKey);
    } catch (error) {
      await this.api.logout(result.token).catch(() => undefined);
      await this.vault.clear();
      throw error;
    }
    this.session = {
      token: result.token,
      email,
      userId: result.userId,
      homeFolder: result.homeFolder,
      isKeyBackedUp: result.isKeyBackedUp,
      addons: [...result.addons],
    };
    try {
      await this.vault.persistSession(this.session);
    } catch {
      this.session = undefined;
      await this.api.logout(result.token).catch(() => undefined);
      await this.vault.clear().catch(() => undefined);
      throw new Error("This browser could not securely save the encrypted session. Check that site storage is enabled and try again.");
    }
    this.publish();
    return publicSession(this.session);
  }

  async restoreSession(): Promise<AuthSession | undefined> {
    const restored = await this.vault.restoreSession();
    if (!restored) return undefined;
    this.session = { ...restored, addons: [...restored.addons] };
    this.publish();
    return publicSession(this.session);
  }

  async login(email: string, password: string): Promise<AuthSession> {
    await this.clearLocalSession();
    const accountSaltHex = await this.api.preLogin(email);
    const passwordHash = await this.vault.deriveLoginHash(password, accountSaltHex);
    const result = await this.api.login(email, passwordHash);
    return this.acceptLogin(email, password, result);
  }

  async createAccount(email: string, password: string): Promise<AccountCreationResult> {
    await this.clearLocalSession();
    const prepared = await this.vault.prepareRegistration(password);
    try {
      await this.api.createAccount({
        email,
        passwordHash: prepared.passwordHash,
        accountSaltHex: prepared.accountSaltHex,
        keyBundleBase64: prepared.keyBundleBase64,
      });
      const result = await this.api.login(email, prepared.passwordHash);
      const session = await this.acceptLogin(email, password, result);
      return { session, recoveryPhrase: prepared.recoveryPhrase };
    } catch (error) {
      await this.vault.clear();
      throw error;
    }
  }

  async logout(): Promise<void> {
    const token = this.session?.token;
    this.session = undefined;
    this.publish();
    try {
      if (token) await this.api.logout(token);
    } finally {
      await this.vault.clear();
    }
  }

  async getUpdates(cursors: SyncCursors): Promise<SyncUpdates> {
    if (!this.session) throw new Error("not authenticated");
    return this.api.getUpdates(this.session.token, cursors);
  }

  async decryptLibrary(
    albums: EncryptedAlbumDescriptor[],
    files: EncryptedFileDescriptor[],
  ): Promise<DecryptedLibrarySnapshot> {
    if (!this.session) throw new Error("not authenticated");
    return this.vault.decryptLibrary(albums, files);
  }

  async downloadEncrypted(file: string, set: number, isThumb: boolean, signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.session) throw new Error("not authenticated");
    return this.api.downloadEncrypted(this.session.token, file, set, isThumb, signal);
  }

  async getDownloadUrl(file: string, set: number): Promise<string> {
    if (!this.session) throw new Error("not authenticated");
    return this.api.getDownloadUrl(this.session.token, file, set);
  }

  async openMediaHeader(
    headers: string,
    isThumb: boolean,
    album?: EncryptedAlbumDescriptor,
  ): Promise<OpenedFileHeader> {
    if (!this.session) throw new Error("not authenticated");
    return this.vault.openMediaHeader(headers, isThumb, album);
  }

  async decryptFileBlob(
    encryptedBlob: Uint8Array,
    headers: string,
    isThumb: boolean,
    album?: EncryptedAlbumDescriptor,
  ): Promise<Uint8Array> {
    if (!this.session) throw new Error("not authenticated");
    return this.vault.decryptFileBlob(encryptedBlob, headers, isThumb, album);
  }

  async createAlbum(name: string, timestamp = Date.now()): Promise<PreparedAlbum> {
    if (!this.session) throw new Error("not authenticated");
    const normalized = name.trim();
    if (!normalized) throw new Error("album name is required");
    const album = await this.vault.createAlbum(normalized, timestamp);
    await this.api.addAlbum(this.session.token, await this.vault.encryptParams({
      albumId: album.albumId,
      encPrivateKey: album.encPrivateKey,
      publicKey: album.publicKey,
      metadata: album.metadata,
      dateCreated: String(album.dateCreated),
      dateModified: String(album.dateModified),
    }));
    return album;
  }

  async moveFiles(input: MoveFilesInput): Promise<void> {
    if (!this.session) throw new Error("not authenticated");
    if (!input.files.length) throw new Error("at least one file is required");
    if (input.setFrom === input.setTo && input.setFrom !== 2) throw new Error("source and destination are identical");
    if (input.setFrom === 2 && !input.sourceAlbum) throw new Error("source album is required");
    if (input.setTo === 2 && !input.targetAlbum) throw new Error("target album is required");
    if (input.setFrom === 2 && input.setTo === 2 && input.sourceAlbum?.albumId === input.targetAlbum?.albumId) {
      throw new Error("source and destination albums are identical");
    }
    const remote = input.files.filter((file) => file.isRemote);
    if (!remote.length) return;
    const needsReseal = input.setFrom === 2 || input.setTo === 2;
    const params: Record<string, string> = {
      setFrom: String(input.setFrom),
      setTo: String(input.setTo),
      albumIdFrom: input.sourceAlbum?.albumId ?? "",
      albumIdTo: input.targetAlbum?.albumId ?? "",
      isMoving: input.isMoving ? "1" : "0",
      count: String(remote.length),
    };
    for (const [index, file] of remote.entries()) {
      params[`filename${index}`] = file.file;
      if (needsReseal) {
        params[`headers${index}`] = await this.vault.resealFileHeaders(
          file.headers,
          input.sourceAlbum,
          input.targetAlbum,
        );
      }
    }
    await this.api.moveFiles(this.session.token, await this.vault.encryptParams(params));
  }

  async deleteFiles(files: MutationFile[]): Promise<void> {
    if (!this.session) throw new Error("not authenticated");
    const remote = files.filter((file) => file.isRemote);
    if (!remote.length) return;
    const params: Record<string, string> = { count: String(remote.length) };
    remote.forEach((file, index) => { params[`filename${index}`] = file.file; });
    await this.api.deleteFiles(this.session.token, await this.vault.encryptParams(params));
  }

  async emptyTrash(timestamp = Date.now()): Promise<void> {
    if (!this.session) throw new Error("not authenticated");
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("invalid trash timestamp");
    await this.api.emptyTrash(this.session.token, await this.vault.encryptParams({ time: String(timestamp) }));
  }

  async deleteAlbum(albumId: string): Promise<void> {
    if (!this.session) throw new Error("not authenticated");
    if (!albumId) throw new Error("album id is required");
    await this.api.deleteAlbum(this.session.token, await this.vault.encryptParams({ albumId }));
  }

  async changeAlbumCover(albumId: string, cover: string): Promise<void> {
    if (!this.session) throw new Error("not authenticated");
    if (!albumId) throw new Error("album id is required");
    if (cover !== "__b__" && (!cover || cover.includes("/") || cover.includes("\\") || cover === "." || cover === "..")) {
      throw new Error("invalid album cover");
    }
    await this.api.changeAlbumCover(this.session.token, await this.vault.encryptParams({ albumId, cover }));
  }

  async upload(
    original: Uint8Array,
    thumbnail: Uint8Array,
    filename: string,
    fileType: 2 | 3,
    videoDuration: number,
    dateCreated: number,
    album?: EncryptedAlbumDescriptor,
  ): Promise<UploadedFileRef> {
    if (!this.session) throw new Error("not authenticated");
    const prepared = await this.vault.prepareUpload(original, thumbnail, filename, fileType, videoDuration, album);
    const dateModified = Date.now();
    try {
      await this.api.uploadEncrypted(this.session.token, {
        file: prepared.file,
        set: album ? 2 : 0,
        ...(album ? { albumId: album.albumId } : {}),
        version: 1,
        dateCreated,
        dateModified,
        headers: prepared.headers,
        encryptedFile: prepared.encryptedFile,
        encryptedThumb: prepared.encryptedThumb,
      });
      return {
        file: prepared.file,
        headers: prepared.headers,
        version: 1,
        dateCreated,
        dateModified,
        ...(album ? { albumId: album.albumId } : {}),
      };
    } finally {
      prepared.encryptedFile.fill(0);
      prepared.encryptedThumb.fill(0);
    }
  }

  async expireSession(): Promise<void> {
    await this.clearLocalSession();
  }

  private async clearLocalSession(): Promise<void> {
    const hadSession = this.session !== undefined;
    this.session = undefined;
    await this.vault.clear();
    if (hadSession) this.publish();
  }
}
