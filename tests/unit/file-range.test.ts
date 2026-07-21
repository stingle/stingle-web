import { describe, expect, test } from "vitest";

import { equalBytes } from "../../src/crypto/bytes";
import { DEFAULT_CHUNK_SIZE } from "../../src/crypto/constants";
import { CryptoAuthenticationError, CryptoFormatError } from "../../src/crypto/errors";
import {
  decryptPlaintextRange,
  encryptFileBytes,
  MemoryByteSource,
  openFileHeader,
  parseOuterHeader,
} from "../../src/crypto/file";
import { generateKeyPair } from "../../src/crypto/keys";

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 47 + 13) % 251);
}

describe("chunked .sp range decryption", () => {
  test("decrypts ranges before, across, and after a chunk boundary", async () => {
    const keyPair = await generateKeyPair();
    const plaintext = pattern(DEFAULT_CHUNK_SIZE + 12_345);
    const encrypted = await encryptFileBytes(plaintext, {
      filename: "two-chunks.mp4",
      fileType: 3,
      recipientPublicKey: keyPair.publicKey,
      videoDuration: 60,
    });
    const header = await openFileHeader(encrypted.outerHeader, keyPair.publicKey, keyPair.privateKey);
    const source = new MemoryByteSource(encrypted.blob);
    const ranges: Array<[number, number]> = [
      [0, 1],
      [123, 9_999],
      [DEFAULT_CHUNK_SIZE - 31, DEFAULT_CHUNK_SIZE + 47],
      [DEFAULT_CHUNK_SIZE + 1_000, plaintext.byteLength - 1],
    ];
    for (const [start, end] of ranges) {
      const decrypted = await decryptPlaintextRange(source, header, BigInt(start), BigInt(end));
      expect(equalBytes(decrypted, plaintext.slice(start, end + 1)), `${start}-${end}`).toBe(true);
    }
  });

  test("supports exact-multiple and zero-byte files", async () => {
    const keyPair = await generateKeyPair();
    const exact = await encryptFileBytes(pattern(DEFAULT_CHUNK_SIZE), {
      filename: "exact.mp4",
      fileType: 3,
      recipientPublicKey: keyPair.publicKey,
    });
    const header = await openFileHeader(exact.outerHeader, keyPair.publicKey, keyPair.privateKey);
    const tail = await decryptPlaintextRange(
      new MemoryByteSource(exact.blob),
      header,
      BigInt(DEFAULT_CHUNK_SIZE - 17),
      BigInt(DEFAULT_CHUNK_SIZE - 1),
    );
    expect(equalBytes(tail, pattern(DEFAULT_CHUNK_SIZE).slice(-17))).toBe(true);

    const empty = await encryptFileBytes(new Uint8Array(), {
      filename: "empty.bin",
      fileType: 1,
      recipientPublicKey: keyPair.publicKey,
    });
    const emptyHeader = await openFileHeader(empty.outerHeader, keyPair.publicKey, keyPair.privateKey);
    expect(emptyHeader.dataSize).toBe(0n);
    await expect(
      decryptPlaintextRange(new MemoryByteSource(empty.blob), emptyHeader, 0n, 0n),
    ).rejects.toBeInstanceOf(CryptoFormatError);
  });

  test("rejects malformed headers, mismatched file IDs, and corrupted chunks", async () => {
    const keyPair = await generateKeyPair();
    const plaintext = pattern(8_000);
    const encrypted = await encryptFileBytes(plaintext, {
      filename: "corrupt.mp4",
      fileType: 3,
      recipientPublicKey: keyPair.publicKey,
    });
    const header = await openFileHeader(encrypted.outerHeader, keyPair.publicKey, keyPair.privateKey);

    const badMagic = encrypted.outerHeader.slice();
    badMagic[0] = 0;
    expect(() => parseOuterHeader(badMagic)).toThrow(CryptoFormatError);

    const badFileId = encrypted.blob.slice();
    badFileId[3] = badFileId[3]! ^ 1;
    await expect(
      decryptPlaintextRange(new MemoryByteSource(badFileId), header, 0n, 10n),
    ).rejects.toBeInstanceOf(CryptoAuthenticationError);

    const badChunk = encrypted.blob.slice();
    badChunk[badChunk.byteLength - 1] = badChunk[badChunk.byteLength - 1]! ^ 1;
    await expect(
      decryptPlaintextRange(
        new MemoryByteSource(badChunk),
        header,
        0n,
        BigInt(plaintext.byteLength - 1),
      ),
    ).rejects.toBeInstanceOf(CryptoAuthenticationError);
  });
});
