import { describe, expect, test } from "vitest";

import { VaultCore } from "../../src/auth/vault-core";
import { fromBase64Url } from "../../src/crypto/encoding";
import { parseOuterHeader } from "../../src/crypto/file";

describe("upload encryption", () => {
  test("encrypts an original and thumbnail with one file id and decryptable dual headers", async () => {
    const vault = new VaultCore();
    await vault.prepareRegistration("upload-test-password");
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const thumbnail = new Uint8Array([8, 7, 6]);
    const prepared = await vault.prepareUpload(original, thumbnail, "photo.jpg", 2, 0);
    expect(prepared.file).toMatch(/^[a-f0-9]{32}\.sp$/u);
    const [fileHeader, thumbHeader] = prepared.headers.split("*");
    expect(parseOuterHeader(await fromBase64Url(fileHeader ?? "")).fileId)
      .toEqual(parseOuterHeader(await fromBase64Url(thumbHeader ?? "")).fileId);
    await expect(vault.decryptFileBlob(prepared.encryptedFile, prepared.headers, false)).resolves.toEqual(original);
    await expect(vault.decryptFileBlob(prepared.encryptedThumb, prepared.headers, true)).resolves.toEqual(thumbnail);
    await vault.clear();
  });
});
