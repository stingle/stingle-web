import { CryptoFormatError } from "./errors";

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function readU32BE(bytes: Uint8Array, offset: number): number {
  requireAvailable(bytes, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

export function readU64BE(bytes: Uint8Array, offset: number): bigint {
  requireAvailable(bytes, offset, 8);
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false);
}

export function writeU32BE(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

export function writeU64BE(value: bigint): Uint8Array {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value, false);
  return output;
}

export function requireAvailable(bytes: Uint8Array, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new CryptoFormatError("invalid byte range");
  }
  if (offset + length > bytes.byteLength) {
    throw new CryptoFormatError("unexpected end of data");
  }
}

export class ByteReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.#offset;
  }

  read(length: number): Uint8Array {
    requireAvailable(this.bytes, this.#offset, length);
    const value = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  readU8(): number {
    return this.read(1)[0]!;
  }

  readU32(): number {
    const value = readU32BE(this.bytes, this.#offset);
    this.#offset += 4;
    return value;
  }

  readU64(): bigint {
    const value = readU64BE(this.bytes, this.#offset);
    this.#offset += 8;
    return value;
  }
}
