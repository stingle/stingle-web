import { describe, expect, test } from "vitest";

import { VaultCore } from "../../src/auth/vault-core";
import { openAlbumName, openAlbumPrivateKey } from "../../src/crypto/album";
import { equalBytes } from "../../src/crypto/bytes";
import { fromBase64, fromBase64Flexible } from "../../src/crypto/encoding";
import { openFileHeader } from "../../src/crypto/file";
import { fixture } from "./fixture";

describe("mutation cryptography", () => {
  test("creates owner-openable album material with a random URL-safe id", async () => {
    const vault = new VaultCore();
    await vault.unlockSession(fixture.password, fixture.keyBundleBase64, fixture.params.serverPublicKeyBase64);
    const created = await vault.createAlbum("Browser album", 1234);
    const userPk = await fromBase64(fixture.userPublicKeyBase64);
    const userSk = await fromBase64(fixture.userPrivateKeyBase64);
    const albumPk = await fromBase64(created.publicKey);
    const albumSk = await openAlbumPrivateKey(await fromBase64(created.encPrivateKey), userPk, userSk);
    expect(created.albumId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.dateCreated).toBe(1234);
    expect(await openAlbumName(await fromBase64(created.metadata), albumPk, albumSk)).toBe("Browser album");
    albumSk.fill(0);
    await vault.clear();
  });

  test("re-seals original and thumbnail headers to an album without changing file metadata", async () => {
    const vault = new VaultCore();
    await vault.unlockSession(fixture.password, fixture.keyBundleBase64, fixture.params.serverPublicKeyBase64);
    const created = await vault.createAlbum("Target", 1);
    const album = { albumId: created.albumId, publicKey: created.publicKey, encPrivateKey: created.encPrivateKey, metadata: created.metadata };
    const source = `${fixture.galleryFile.outerHeaderBase64Url}*${fixture.galleryFile.outerHeaderBase64Url}`;
    const resealed = await vault.resealFileHeaders(source, undefined, album);
    const userPk = await fromBase64(fixture.userPublicKeyBase64);
    const userSk = await fromBase64(fixture.userPrivateKeyBase64);
    const albumPk = await fromBase64(created.publicKey);
    const albumSk = await openAlbumPrivateKey(await fromBase64(created.encPrivateKey), userPk, userSk);
    const parts = resealed.split("*");
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      const opened = await openFileHeader(await fromBase64Flexible(part!), albumPk, albumSk);
      expect(opened.filename).toBe(fixture.galleryFile.filename);
      expect(equalBytes(opened.fileId, await fromBase64Flexible(fixture.galleryFile.fileIdBase64Url))).toBe(true);
      await expect(openFileHeader(await fromBase64Flexible(part!), userPk, userSk)).rejects.toThrow();
      opened.symmetricKey.fill(0);
    }
    albumSk.fill(0);
    await vault.clear();
  });

  test("re-seals album headers back to the user key", async () => {
    const vault = new VaultCore();
    await vault.unlockSession(fixture.password, fixture.keyBundleBase64, fixture.params.serverPublicKeyBase64);
    const sourceAlbum = {
      albumId: "source",
      publicKey: fixture.album.publicKeyBase64,
      encPrivateKey: fixture.album.encryptedPrivateKeyBase64,
      metadata: fixture.album.metadataBase64,
    };
    const resealed = await vault.resealFileHeaders(
      `${fixture.album.file.outerHeaderBase64Url}*${fixture.album.file.outerHeaderBase64Url}`,
      sourceAlbum,
    );
    const opened = await openFileHeader(
      await fromBase64Flexible(resealed.split("*")[0]!),
      await fromBase64(fixture.userPublicKeyBase64),
      await fromBase64(fixture.userPrivateKeyBase64),
    );
    expect(opened.filename).toBe(fixture.album.file.filename);
    opened.symmetricKey.fill(0);
    await vault.clear();
  });
});
