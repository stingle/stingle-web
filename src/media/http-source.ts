import { expectedEncryptedSize, type EncryptedByteSource, type OpenedFileHeader } from "../crypto/file";

export class HttpRangeSource implements EncryptedByteSource {
  readonly size: bigint;
  private readonly cache = new Map<string, Uint8Array>();
  private cachedBytes = 0;

  constructor(
    private readonly url: string,
    header: OpenedFileHeader,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.size = expectedEncryptedSize(header, header.byteLength);
  }

  async read(start: bigint, endInclusive: bigint): Promise<Uint8Array> {
    if (start < 0n || endInclusive < start || endInclusive >= this.size) throw new Error("remote encrypted range is invalid");
    const key = `${start}-${endInclusive}`;
    const cached = this.cache.get(key);
    if (cached) return cached.slice();
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        headers: { Range: `bytes=${start}-${endInclusive}` },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } finally {
      globalThis.clearTimeout(timeout);
    }
    if (response.status !== 206) throw new Error("remote storage did not honor encrypted range request");
    const expectedContentRange = `bytes ${start}-${endInclusive}/${this.size}`;
    if (response.headers.get("content-range") !== expectedContentRange) throw new Error("remote storage returned the wrong encrypted range");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expectedLength = Number(endInclusive - start + 1n);
    if (bytes.byteLength !== expectedLength) throw new Error("remote encrypted range is truncated");
    if (bytes.byteLength <= 2 * 1024 * 1024) {
      while (this.cachedBytes + bytes.byteLength > 16 * 1024 * 1024 && this.cache.size) {
        const oldest = this.cache.keys().next().value as string;
        this.cachedBytes -= this.cache.get(oldest)?.byteLength ?? 0;
        this.cache.delete(oldest);
      }
      this.cache.set(key, bytes.slice());
      this.cachedBytes += bytes.byteLength;
    }
    return bytes;
  }
}
