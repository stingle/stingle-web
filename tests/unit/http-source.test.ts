import { describe, expect, test, vi } from "vitest";

import { equalBytes } from "../../src/crypto/bytes";
import { decryptPlaintextRange, encryptFileBytes, openFileHeader } from "../../src/crypto/file";
import { generateKeyPair } from "../../src/crypto/keys";
import { HttpRangeSource } from "../../src/media/http-source";

describe("remote encrypted range source", () => {
  test("range-decrypts and caches authenticated chunks without a full download", async () => {
    const keyPair = await generateKeyPair();
    const plaintext = new Uint8Array(12_000).map((_, index) => index % 251);
    const encrypted = await encryptFileBytes(plaintext, { filename: "stream.mp4", fileType: 3, recipientPublicKey: keyPair.publicKey });
    const header = await openFileHeader(encrypted.outerHeader, keyPair.publicKey, keyPair.privateKey);
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(new Headers(init?.headers).get("range") ?? "");
      if (!match) return new Response(null, { status: 416 });
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(encrypted.blob.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${encrypted.blob.byteLength}` },
      });
    });
    const source = new HttpRangeSource("https://storage.example/file", header, fetchMock);
    const first = await decryptPlaintextRange(source, header, 100n, 5_000n);
    expect(equalBytes(first, plaintext.slice(100, 5_001))).toBe(true);
    const requestCount = fetchMock.mock.calls.length;
    const second = await decryptPlaintextRange(source, header, 100n, 5_000n);
    expect(equalBytes(second, first)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  });

  test("rejects storage that ignores Range", async () => {
    const keyPair = await generateKeyPair();
    const encrypted = await encryptFileBytes(new Uint8Array([1, 2, 3]), { filename: "x.mp4", fileType: 3, recipientPublicKey: keyPair.publicKey });
    const header = await openFileHeader(encrypted.outerHeader, keyPair.publicKey, keyPair.privateKey);
    const source = new HttpRangeSource(
      "https://storage.example/file",
      header,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(new Blob([encrypted.blob.slice().buffer]), { status: 200 })),
    );
    await expect(source.read(0n, 2n)).rejects.toThrow(/did not honor/u);
  });
});
