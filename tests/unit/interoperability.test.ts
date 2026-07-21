import { describe, expect, test } from "vitest";

import { openAlbumName, openAlbumPrivateKey } from "../../src/crypto/album";
import { equalBytes } from "../../src/crypto/bytes";
import { BOX_NONCE_BYTES } from "../../src/crypto/constants";
import { fromBase64, fromBase64Url, fromHex } from "../../src/crypto/encoding";
import { decryptPlaintextRange, MemoryByteSource, openFileHeader } from "../../src/crypto/file";
import { parseEncryptedKeyBundleBase64, unlockKeyBundle } from "../../src/crypto/keys";
import { entropyToMnemonic, mnemonicToEntropy } from "../../src/crypto/mnemonic";
import { passwordHashForStorage } from "../../src/crypto/pwhash";
import { ready } from "../../src/crypto/sodium";
import { fixture } from "./fixture";

describe("Desktop-generated interoperability fixture", () => {
  test("matches the frozen Argon2id login hash", async () => {
    const salt = await fromHex(fixture.accountSaltHex);
    await expect(passwordHashForStorage(fixture.password, salt)).resolves.toBe(fixture.loginHashHex);
  });

  test("unlocks the Desktop SPK key bundle", async () => {
    const bundle = await parseEncryptedKeyBundleBase64(fixture.keyBundleBase64);
    const keyPair = await unlockKeyBundle(bundle, fixture.password);
    expect(equalBytes(keyPair.publicKey, await fromBase64(fixture.userPublicKeyBase64))).toBe(true);
    expect(equalBytes(keyPair.privateKey, await fromBase64(fixture.userPrivateKeyBase64))).toBe(true);
    (await ready()).memzero(keyPair.privateKey);
  });

  test("reproduces the recovery mnemonic and decodes it losslessly", async () => {
    const privateKey = await fromBase64(fixture.userPrivateKeyBase64);
    await expect(entropyToMnemonic(privateKey)).resolves.toBe(fixture.mnemonic);
    expect(equalBytes(await mnemonicToEntropy(fixture.mnemonic), privateKey)).toBe(true);
  });

  test("opens and range-decrypts a Desktop gallery .sp file", async () => {
    const publicKey = await fromBase64(fixture.userPublicKeyBase64);
    const privateKey = await fromBase64(fixture.userPrivateKeyBase64);
    const outerHeader = await fromBase64Url(fixture.galleryFile.outerHeaderBase64Url);
    const plaintext = await fromBase64(fixture.galleryFile.plaintextBase64);
    const blob = await fromBase64(fixture.galleryFile.blobBase64);
    const header = await openFileHeader(outerHeader, publicKey, privateKey);

    expect(header.filename).toBe(fixture.galleryFile.filename);
    expect(header.fileType).toBe(fixture.galleryFile.fileType);
    expect(header.videoDuration).toBe(fixture.galleryFile.videoDuration);
    expect(header.dataSize).toBe(BigInt(plaintext.byteLength));
    expect(equalBytes(header.fileId, await fromBase64Url(fixture.galleryFile.fileIdBase64Url))).toBe(true);

    const source = new MemoryByteSource(blob);
    const decrypted = await decryptPlaintextRange(source, header, 123n, 4_000n);
    expect(equalBytes(decrypted, plaintext.slice(123, 4_001))).toBe(true);
  });

  test("opens Desktop album material and album-sealed file headers", async () => {
    const userPublicKey = await fromBase64(fixture.userPublicKeyBase64);
    const userPrivateKey = await fromBase64(fixture.userPrivateKeyBase64);
    const albumPublicKey = await fromBase64(fixture.album.publicKeyBase64);
    const albumPrivateKey = await openAlbumPrivateKey(
      await fromBase64(fixture.album.encryptedPrivateKeyBase64),
      userPublicKey,
      userPrivateKey,
    );
    expect(equalBytes(albumPrivateKey, await fromBase64(fixture.album.privateKeyBase64))).toBe(true);
    await expect(
      openAlbumName(await fromBase64(fixture.album.metadataBase64), albumPublicKey, albumPrivateKey),
    ).resolves.toBe(fixture.album.name);

    const outerHeader = await fromBase64Url(fixture.album.file.outerHeaderBase64Url);
    const header = await openFileHeader(outerHeader, albumPublicKey, albumPrivateKey);
    const plaintext = await fromBase64(fixture.album.file.plaintextBase64);
    const blob = await fromBase64(fixture.album.file.blobBase64);
    const decrypted = await decryptPlaintextRange(
      new MemoryByteSource(blob),
      header,
      7n,
      BigInt(plaintext.byteLength - 9),
    );
    expect(equalBytes(decrypted, plaintext.slice(7, -8))).toBe(true);
  });

  test("opens Desktop-produced encrypted server params", async () => {
    const sodium = await ready();
    const encrypted = await fromBase64(fixture.params.encryptedBase64);
    const nonce = encrypted.slice(0, BOX_NONCE_BYTES);
    const ciphertext = encrypted.slice(BOX_NONCE_BYTES);
    const plaintext = sodium.crypto_box_open_easy(
      ciphertext,
      nonce,
      await fromBase64(fixture.userPublicKeyBase64),
      await fromBase64(fixture.params.serverPrivateKeyBase64),
    );
    expect(new TextDecoder().decode(plaintext)).toBe(fixture.params.json);
  });
});
