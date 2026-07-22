import {
  assertEnvelopeOk,
  parseEnvelope,
  partArray,
  partString,
  requiredPart,
  type ApiEnvelope,
} from "./envelope";
import { ApiError, SecondFactorUnsupportedError, SessionExpiredError } from "./errors";
import { parseSyncUpdates } from "../sync/parse";
import type { SyncCursors, SyncUpdates } from "../sync/model";

export const API_VERSION = 2;
export const DEFAULT_API_BASE = `/api/v${API_VERSION}/`;

export const apiPaths = Object.freeze({
  preLogin: "login/preLogin",
  login: "login/login",
  register: "register/createAccount",
  logout: "login/logout",
  getServerPublicKey: "keys/getServerPK",
  getUpdates: "sync/getUpdates",
  download: "sync/download",
  getDownloadUrl: "sync/getUrl",
  moveFile: "sync/moveFile",
  deleteFiles: "sync/delete",
  emptyTrash: "sync/emptyTrash",
  addAlbum: "sync/addAlbum",
  deleteAlbum: "sync/deleteAlbum",
  changeAlbumCover: "sync/changeAlbumCover",
  upload: "sync/upload",
});

export interface EncryptedUploadRequest {
  file: string;
  set: 0 | 2;
  albumId?: string;
  version: number;
  dateCreated: number;
  dateModified: number;
  headers: string;
  encryptedFile: Uint8Array;
  encryptedThumb: Uint8Array;
}

export interface LoginResult {
  token: string;
  userId: string;
  keyBundle: string;
  serverPublicKey: string;
  isKeyBackedUp: boolean;
  homeFolder: string;
  addons: string[];
}

export interface RegistrationRequest {
  email: string;
  passwordHash: string;
  accountSaltHex: string;
  keyBundleBase64: string;
}

export interface ApiClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  fetch?: typeof fetch;
  onSessionExpired?: () => void;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("/")) return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError("Invalid API base URL.", "protocol");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ApiError("The API URL must use HTTPS (HTTP is allowed only for loopback).", "protocol");
  }
  return url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly uploadTimeoutMs: number;
  private readonly onSessionExpired: (() => void) | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_API_BASE);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 30 * 60_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onSessionExpired = options.onSessionExpired;
  }

  async postForm(path: string, fields: Record<string, string>): Promise<ApiEnvelope> {
    if (!/^[a-zA-Z0-9/_-]+$/u.test(path) || path.startsWith("/")) {
      throw new ApiError("Invalid API endpoint path.", "protocol");
    }
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: new URLSearchParams(fields).toString(),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError("The API request timed out.", "timeout");
      throw new ApiError(error instanceof Error ? error.message : "Network request failed.", "network");
    } finally {
      globalThis.clearTimeout(timeout);
    }

    const text = await response.text();
    let envelope: ApiEnvelope | undefined;
    try {
      envelope = parseEnvelope(JSON.parse(text) as unknown);
    } catch (error) {
      if (!response.ok) throw new ApiError(`API returned HTTP ${response.status}.`, "http", response.status);
      throw error;
    }

    const logout = partString(envelope, "logout");
    if (logout !== undefined && logout !== "" && logout !== "0") {
      this.onSessionExpired?.();
      throw new SessionExpiredError();
    }
    if (!response.ok) {
      throw new ApiError(
        envelope.errors[0] ?? `API returned HTTP ${response.status}.`,
        "http",
        response.status,
      );
    }
    return envelope;
  }

  async preLogin(email: string): Promise<string> {
    const envelope = assertEnvelopeOk(await this.postForm(apiPaths.preLogin, { email }));
    const salt = requiredPart(envelope, "salt");
    if (!/^[0-9a-fA-F]{32}$/u.test(salt)) throw new ApiError("Server returned an invalid account salt.", "protocol");
    return salt;
  }

  async login(email: string, passwordHash: string): Promise<LoginResult> {
    const envelope = await this.postForm(apiPaths.login, { email, password: passwordHash });
    if (partString(envelope, "needSecondFactor") === "1") throw new SecondFactorUnsupportedError();
    assertEnvelopeOk(envelope);
    return {
      token: requiredPart(envelope, "token"),
      userId: requiredPart(envelope, "userId"),
      keyBundle: requiredPart(envelope, "keyBundle"),
      serverPublicKey: requiredPart(envelope, "serverPublicKey"),
      isKeyBackedUp: partString(envelope, "isKeyBackedUp") === "1",
      homeFolder: requiredPart(envelope, "homeFolder"),
      addons: partArray(envelope, "addons").map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      ),
    };
  }

  async createAccount(input: RegistrationRequest): Promise<void> {
    assertEnvelopeOk(
      await this.postForm(apiPaths.register, {
        email: input.email,
        password: input.passwordHash,
        salt: input.accountSaltHex,
        keyBundle: input.keyBundleBase64,
      }),
    );
  }

  async logout(token: string): Promise<void> {
    assertEnvelopeOk(await this.postForm(apiPaths.logout, { token }));
  }

  async getServerPublicKey(token: string): Promise<string> {
    return requiredPart(
      assertEnvelopeOk(await this.postForm(apiPaths.getServerPublicKey, { token })),
      "serverPK",
    );
  }

  async getUpdates(token: string, cursors: SyncCursors): Promise<SyncUpdates> {
    const envelope = assertEnvelopeOk(
      await this.postForm(apiPaths.getUpdates, {
        token,
        filesST: String(cursors.files),
        trashST: String(cursors.trash),
        albumsST: String(cursors.albums),
        albumFilesST: String(cursors.albumFiles),
        delST: String(cursors.deletes),
        cntST: String(cursors.contacts),
      }),
    );
    return parseSyncUpdates(envelope);
  }

  async downloadEncrypted(token: string, file: string, set: number, isThumb: boolean, signal?: AbortSignal): Promise<Uint8Array> {
    if (![0, 1, 2].includes(set)) throw new ApiError("Invalid file set.", "protocol");
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${apiPaths.download}`, {
        method: "POST",
        headers: { Accept: "application/octet-stream", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ token, file, set: String(set), ...(isThumb ? { thumb: "1" } : {}) }).toString(),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) throw new ApiError("The download timed out.", "timeout");
      if (signal?.aborted) throw new ApiError("The download was cancelled.", "network");
      throw new ApiError(error instanceof Error ? error.message : "Download failed.", "network");
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    if (!response.ok) throw new ApiError(`Download returned HTTP ${response.status}.`, "http", response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength >= 3 && bytes[0] === 0x53 && bytes[1] === 0x50 && bytes[2] === 1) return bytes;
    try {
      const envelope = parseEnvelope(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      const logout = partString(envelope, "logout");
      if (logout !== undefined && logout !== "" && logout !== "0") {
        this.onSessionExpired?.();
        throw new SessionExpiredError();
      }
      assertEnvelopeOk(envelope);
    } catch (error) {
      if (error instanceof ApiError) throw error;
    }
    throw new ApiError("Download did not return an authenticated Stingle file.", "protocol");
  }

  async getDownloadUrl(token: string, file: string, set: number): Promise<string> {
    if (![0, 1, 2].includes(set)) throw new ApiError("Invalid file set.", "protocol");
    const value = requiredPart(
      assertEnvelopeOk(await this.postForm(apiPaths.getDownloadUrl, { token, file, set: String(set) })),
      "url",
    );
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ApiError("Server returned an invalid media URL.", "protocol");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new ApiError("Server returned an unsafe media URL.", "protocol");
    }
    return url.toString();
  }

  async uploadEncrypted(token: string, input: EncryptedUploadRequest): Promise<void> {
    if (!token || !/^[a-f0-9]{32}\.sp$/u.test(input.file)) throw new ApiError("Invalid encrypted upload name.", "protocol");
    if (input.set === 2 && !input.albumId) throw new ApiError("Album upload is missing its album.", "protocol");
    const body = new FormData();
    body.append("token", token);
    body.append("set", String(input.set));
    body.append("albumId", input.albumId ?? "");
    body.append("version", String(input.version));
    body.append("dateCreated", String(input.dateCreated));
    body.append("dateModified", String(input.dateModified));
    body.append("headers", input.headers);
    body.append("file", new Blob([input.encryptedFile.buffer as ArrayBuffer], { type: "application/stinglephoto" }), input.file);
    body.append("thumb", new Blob([input.encryptedThumb.buffer as ArrayBuffer], { type: "application/stinglephoto" }), input.file);
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.uploadTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${apiPaths.upload}`, {
        method: "POST",
        headers: { Accept: "application/json" },
        body,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError("The upload timed out.", "timeout");
      throw new ApiError(error instanceof Error ? error.message : "Upload failed.", "network");
    } finally {
      globalThis.clearTimeout(timeout);
    }
    let envelope: ApiEnvelope;
    try {
      envelope = parseEnvelope(JSON.parse(await response.text()) as unknown);
    } catch (error) {
      if (!response.ok) throw new ApiError(`Upload returned HTTP ${response.status}.`, "http", response.status);
      throw error;
    }
    const logout = partString(envelope, "logout");
    if (logout !== undefined && logout !== "" && logout !== "0") {
      this.onSessionExpired?.();
      throw new SessionExpiredError();
    }
    if (!response.ok) throw new ApiError(envelope.errors[0] ?? `Upload returned HTTP ${response.status}.`, "http", response.status);
    assertEnvelopeOk(envelope);
  }

  private async postEncrypted(path: string, token: string, params: string): Promise<void> {
    if (!token || !params) throw new ApiError("Encrypted mutation request is incomplete.", "protocol");
    assertEnvelopeOk(await this.postForm(path, { token, params }));
  }

  async addAlbum(token: string, params: string): Promise<void> {
    await this.postEncrypted(apiPaths.addAlbum, token, params);
  }

  async moveFiles(token: string, params: string): Promise<void> {
    await this.postEncrypted(apiPaths.moveFile, token, params);
  }

  async deleteFiles(token: string, params: string): Promise<void> {
    await this.postEncrypted(apiPaths.deleteFiles, token, params);
  }

  async emptyTrash(token: string, params: string): Promise<void> {
    await this.postEncrypted(apiPaths.emptyTrash, token, params);
  }

  async deleteAlbum(token: string, params: string): Promise<void> {
    await this.postEncrypted(apiPaths.deleteAlbum, token, params);
  }

  async changeAlbumCover(token: string, params: string): Promise<void> {
    await this.postEncrypted(apiPaths.changeAlbumCover, token, params);
  }
}
