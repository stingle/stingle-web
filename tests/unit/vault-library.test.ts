import { describe, expect, test } from "vitest";

import { VaultCore } from "../../src/auth/vault-core";
import { equalBytes } from "../../src/crypto/bytes";
import { fromBase64 } from "../../src/crypto/encoding";
import { fixture } from "./fixture";

describe("vault library metadata", () => {
  test("decrypts Desktop gallery and album metadata without exposing identity keys", async () => {
    const vault = new VaultCore();
    await vault.unlockSession(fixture.password, fixture.keyBundleBase64, fixture.params.serverPublicKeyBase64);

    const snapshot = await vault.decryptLibrary(
      [{
        albumId: "album-1",
        publicKey: fixture.album.publicKeyBase64,
        encPrivateKey: fixture.album.encryptedPrivateKeyBase64,
        metadata: fixture.album.metadataBase64,
      }],
      [
        { id: "gallery", headers: fixture.galleryFile.outerHeaderBase64Url },
        { id: "album-file", albumId: "album-1", headers: fixture.album.file.outerHeaderBase64Url },
      ],
    );

    expect(snapshot.albums).toEqual([{ albumId: "album-1", name: fixture.album.name }]);
    expect(snapshot.files).toMatchObject([
      { id: "gallery", filename: fixture.galleryFile.filename, fileType: fixture.galleryFile.fileType },
      { id: "album-file", filename: fixture.album.file.filename, fileType: fixture.album.file.fileType },
    ]);
    await vault.clear();
  });

  test("isolates corrupt records instead of failing the whole library", async () => {
    const vault = new VaultCore();
    await vault.unlockSession(fixture.password, fixture.keyBundleBase64, fixture.params.serverPublicKeyBase64);
    const snapshot = await vault.decryptLibrary([], [
      { id: "bad", headers: "not-base64" },
      { id: "good", headers: fixture.galleryFile.outerHeaderBase64Url },
    ]);
    expect(snapshot.files[0]).toEqual({ id: "bad", error: true });
    expect(snapshot.files[1]?.filename).toBe(fixture.galleryFile.filename);
    await vault.clear();
  });

  test("opens a disposable playback header and decrypts a complete stored blob", async () => {
    const vault = new VaultCore();
    await vault.unlockSession(fixture.password, fixture.keyBundleBase64, fixture.params.serverPublicKeyBase64);
    const header = await vault.openMediaHeader(fixture.galleryFile.outerHeaderBase64Url, false);
    expect(header.filename).toBe(fixture.galleryFile.filename);
    const plaintext = await vault.decryptFileBlob(
      await fromBase64(fixture.galleryFile.blobBase64),
      fixture.galleryFile.outerHeaderBase64Url,
      false,
    );
    expect(equalBytes(plaintext, await fromBase64(fixture.galleryFile.plaintextBase64))).toBe(true);
    await vault.clear();
  });
});
