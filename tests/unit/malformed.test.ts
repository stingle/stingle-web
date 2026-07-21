import { describe, expect, test } from "vitest";

import { CryptoFormatError } from "../../src/crypto/errors";
import { mnemonicToEntropy } from "../../src/crypto/mnemonic";

describe("malformed untrusted input", () => {
  test("rejects unknown mnemonic words", async () => {
    await expect(
      mnemonicToEntropy("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon nope"),
    ).rejects.toBeInstanceOf(CryptoFormatError);
  });

  test("rejects a bad mnemonic checksum", async () => {
    await expect(
      mnemonicToEntropy("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zoo"),
    ).rejects.toBeInstanceOf(CryptoFormatError);
  });
});
