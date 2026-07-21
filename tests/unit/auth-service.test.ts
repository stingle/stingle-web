import { beforeEach, describe, expect, test, vi } from "vitest";

import type { LoginResult, RegistrationRequest } from "../../src/api/client";
import { AuthService, type AuthApi } from "../../src/auth/auth-service";
import type { PreparedRegistration, Vault } from "../../src/auth/vault-core";

const loginResult: LoginResult = {
  token: "opaque-token",
  userId: "42",
  keyBundle: "bundle",
  serverPublicKey: "server-pk",
  isKeyBackedUp: true,
  homeFolder: "home",
  addons: ["one"],
};

let api: AuthApi;
let vault: Vault;

beforeEach(() => {
  api = {
    preLogin: vi.fn().mockResolvedValue("000102030405060708090A0B0C0D0E0F"),
    login: vi.fn().mockResolvedValue(loginResult),
    createAccount: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    getUpdates: vi.fn().mockResolvedValue({
      files: [], trash: [], albums: [], albumFiles: [], contacts: [], deletes: [],
    }),
    downloadEncrypted: vi.fn().mockResolvedValue(new Uint8Array([0x53, 0x50, 1])),
    getDownloadUrl: vi.fn().mockResolvedValue("https://storage.example/file"),
    addAlbum: vi.fn().mockResolvedValue(undefined),
    moveFiles: vi.fn().mockResolvedValue(undefined),
    deleteFiles: vi.fn().mockResolvedValue(undefined),
    emptyTrash: vi.fn().mockResolvedValue(undefined),
    deleteAlbum: vi.fn().mockResolvedValue(undefined),
    changeAlbumCover: vi.fn().mockResolvedValue(undefined),
    uploadEncrypted: vi.fn().mockResolvedValue(undefined),
  };
  const registration: PreparedRegistration = {
    accountSaltHex: "000102030405060708090A0B0C0D0E0F",
    passwordHash: "HASH",
    keyBundleBase64: "bundle",
    publicKeyBase64: "public",
    recoveryPhrase: "one two three",
  };
  vault = {
    deriveLoginHash: vi.fn().mockResolvedValue("HASH"),
    prepareRegistration: vi.fn().mockResolvedValue(registration),
    unlockSession: vi.fn().mockResolvedValue(undefined),
    encryptParams: vi.fn().mockResolvedValue("params"),
    decryptLibrary: vi.fn().mockResolvedValue({ albums: [], files: [] }),
    openMediaHeader: vi.fn(),
    decryptFileBlob: vi.fn(),
    createAlbum: vi.fn().mockResolvedValue({
      albumId: "album-id",
      encPrivateKey: "enc-sk",
      publicKey: "album-pk",
      metadata: "metadata",
      dateCreated: 123,
      dateModified: 123,
    }),
    resealFileHeaders: vi.fn().mockResolvedValue("new-file-header*new-thumb-header"),
    prepareUpload: vi.fn().mockResolvedValue({
      file: "00112233445566778899aabbccddeeff.sp",
      headers: "file-header*thumb-header",
      encryptedFile: new Uint8Array([1, 2]),
      encryptedThumb: new Uint8Array([3, 4]),
    }),
    persistSession: vi.fn().mockResolvedValue(undefined),
    restoreSession: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
});

describe("authentication lifecycle", () => {
  test("performs preLogin, local hashing, login, and key unlock in order", async () => {
    const service = new AuthService(api, vault);
    await expect(service.login("person@example.test", "secret-password")).resolves.toMatchObject({
      email: "person@example.test",
      userId: "42",
    });
    expect(api.preLogin).toHaveBeenCalledWith("person@example.test");
    expect(vault.deriveLoginHash).toHaveBeenCalledWith(
      "secret-password",
      "000102030405060708090A0B0C0D0E0F",
    );
    expect(api.login).toHaveBeenCalledWith("person@example.test", "HASH");
    expect(vault.unlockSession).toHaveBeenCalledWith("secret-password", "bundle", "server-pk");
    expect(vault.persistSession).toHaveBeenCalledWith(expect.objectContaining({ token: "opaque-token" }));
  });

  test("restores an encrypted local session without calling the login API", async () => {
    vi.mocked(vault.restoreSession).mockResolvedValue({
      token: "saved-token", email: "person@example.test", userId: "42", homeFolder: "home",
      isKeyBackedUp: true, addons: ["one"],
    });
    const service = new AuthService(api, vault);
    await expect(service.restoreSession()).resolves.toMatchObject({ email: "person@example.test" });
    expect(api.preLogin).not.toHaveBeenCalled();
    expect(api.login).not.toHaveBeenCalled();
  });

  test("revokes a newly issued token when key-bundle unlock fails", async () => {
    vi.mocked(vault.unlockSession).mockRejectedValue(new Error("bad bundle"));
    const service = new AuthService(api, vault);
    await expect(service.login("person@example.test", "wrong")).rejects.toThrow("bad bundle");
    expect(api.logout).toHaveBeenCalledWith("opaque-token");
    expect(service.currentSession).toBeUndefined();
  });

  test("revokes a newly issued token when secure browser persistence fails", async () => {
    vi.mocked(vault.persistSession).mockRejectedValue(new Error("storage disabled"));
    const service = new AuthService(api, vault);
    await expect(service.login("person@example.test", "secret-password")).rejects.toThrow("site storage");
    expect(api.logout).toHaveBeenCalledWith("opaque-token");
    expect(vault.clear).toHaveBeenCalled();
    expect(service.currentSession).toBeUndefined();
  });

  test("creates an account without sending a plaintext password", async () => {
    const service = new AuthService(api, vault);
    const result = await service.createAccount("new@example.test", "local-secret");
    expect(result.recoveryPhrase).toBe("one two three");
    const sent = vi.mocked(api.createAccount).mock.calls[0]?.[0] as RegistrationRequest;
    expect(sent).toEqual({
      email: "new@example.test",
      passwordHash: "HASH",
      accountSaltHex: "000102030405060708090A0B0C0D0E0F",
      keyBundleBase64: "bundle",
    });
    expect(JSON.stringify(sent)).not.toContain("local-secret");
  });

  test("clears the token and vault even when remote logout fails", async () => {
    const service = new AuthService(api, vault);
    await service.login("person@example.test", "secret-password");
    vi.mocked(api.logout).mockRejectedValue(new Error("offline"));
    await expect(service.logout()).rejects.toThrow("offline");
    expect(vault.clear).toHaveBeenCalled();
    expect(service.currentSession).toBeUndefined();
  });
});

describe("authenticated mutations", () => {
  test("creates an encrypted album and sends only opaque params", async () => {
    const service = new AuthService(api, vault);
    await service.login("person@example.test", "secret-password");
    await service.createAlbum("  Private album  ", 123);
    expect(vault.createAlbum).toHaveBeenCalledWith("Private album", 123);
    expect(api.addAlbum).toHaveBeenCalledWith("opaque-token", "params");
  });

  test("re-seals both headers for an album move before calling moveFile", async () => {
    const service = new AuthService(api, vault);
    await service.login("person@example.test", "secret-password");
    const targetAlbum = { albumId: "target", publicKey: "pk", encPrivateKey: "sk", metadata: "meta" };
    vi.mocked(vault.encryptParams).mockImplementation(async (value) => JSON.stringify(value));
    await service.moveFiles({
      files: [{ file: "one.sp", headers: "file*thumb", isRemote: true }],
      setFrom: 0,
      setTo: 2,
      targetAlbum,
      isMoving: false,
    });
    expect(vault.resealFileHeaders).toHaveBeenCalledWith("file*thumb", undefined, targetAlbum);
    const params = JSON.parse(vi.mocked(api.moveFiles).mock.calls[0]?.[1] ?? "{}") as Record<string, string>;
    expect(params).toMatchObject({
      setFrom: "0", setTo: "2", albumIdFrom: "", albumIdTo: "target",
      isMoving: "0", count: "1", filename0: "one.sp",
      headers0: "new-file-header*new-thumb-header",
    });
  });

  test("uses moveFile without re-sealing for trash and restore", async () => {
    const service = new AuthService(api, vault);
    await service.login("person@example.test", "secret-password");
    await service.moveFiles({
      files: [{ file: "one.sp", headers: "file*thumb", isRemote: true }],
      setFrom: 0,
      setTo: 1,
      isMoving: true,
    });
    expect(vault.resealFileHeaders).not.toHaveBeenCalled();
    expect(api.moveFiles).toHaveBeenCalledWith("opaque-token", "params");
  });

  test("encrypts permanent delete, empty-trash clock guard, and album deletion", async () => {
    const service = new AuthService(api, vault);
    await service.login("person@example.test", "secret-password");
    vi.mocked(vault.encryptParams).mockImplementation(async (value) => JSON.stringify(value));
    await service.deleteFiles([
      { file: "remote.sp", headers: "file*thumb", isRemote: true },
      { file: "local.sp", headers: "file*thumb", isRemote: false },
    ]);
    await service.emptyTrash(456);
    await service.deleteAlbum("album-id");
    expect(api.deleteFiles).toHaveBeenCalledWith("opaque-token", JSON.stringify({ count: "1", filename0: "remote.sp" }));
    expect(api.emptyTrash).toHaveBeenCalledWith("opaque-token", JSON.stringify({ time: "456" }));
    expect(api.deleteAlbum).toHaveBeenCalledWith("opaque-token", JSON.stringify({ albumId: "album-id" }));
  });

  test("changes an album cover using the interoperable item and blank values", async () => {
    vi.mocked(vault.encryptParams).mockImplementation(async (value) => JSON.stringify(value));
    const service = new AuthService(api, vault);
    await service.login("person@example.test", "secret-password");
    await service.changeAlbumCover("album-id", "cover.sp");
    await service.changeAlbumCover("album-id", "__b__");
    expect(api.changeAlbumCover).toHaveBeenNthCalledWith(1, "opaque-token", JSON.stringify({ albumId: "album-id", cover: "cover.sp" }));
    expect(api.changeAlbumCover).toHaveBeenNthCalledWith(2, "opaque-token", JSON.stringify({ albumId: "album-id", cover: "__b__" }));
    await expect(service.changeAlbumCover("album-id", "../bad.sp")).rejects.toThrow(/invalid album cover/u);
  });

  test("rejects invalid album movement before contacting the API", async () => {
    const service = new AuthService(api, vault);
    await service.login("person@example.test", "secret-password");
    await expect(service.moveFiles({
      files: [{ file: "one.sp", headers: "file*thumb", isRemote: true }],
      setFrom: 2,
      setTo: 0,
      isMoving: true,
    })).rejects.toThrow("source album");
    expect(api.moveFiles).not.toHaveBeenCalled();
  });

  test("encrypts and uploads browser media, then erases returned ciphertext buffers", async () => {
    const service = new AuthService(api, vault);
    await service.login("person@example.test", "secret-password");
    const original = new Uint8Array([9, 8, 7]);
    const thumb = new Uint8Array([6, 5]);
    const album = { albumId: "album-id", publicKey: "pk", encPrivateKey: "sk", metadata: "meta" };
    await service.upload(original, thumb, "photo.jpg", 2, 0, 123, album);
    expect(vault.prepareUpload).toHaveBeenCalledWith(original, thumb, "photo.jpg", 2, 0, album);
    expect(api.uploadEncrypted).toHaveBeenCalledWith("opaque-token", expect.objectContaining({
      file: "00112233445566778899aabbccddeeff.sp",
      set: 2,
      albumId: "album-id",
      dateCreated: 123,
      headers: "file-header*thumb-header",
    }));
    const sent = vi.mocked(api.uploadEncrypted).mock.calls[0]?.[1];
    expect(sent?.encryptedFile).toEqual(new Uint8Array([0, 0]));
    expect(sent?.encryptedThumb).toEqual(new Uint8Array([0, 0]));
  });
});
