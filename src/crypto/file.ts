import {
  AEAD_MAC_BYTES,
  AEAD_NONCE_BYTES,
  DATA_KDF_CONTEXT,
  DEFAULT_CHUNK_SIZE,
  FILE_ID_BYTES,
  FILE_MAGIC,
  FILE_VERSION,
  HEADER_VERSION,
  MAX_BUFFER_LENGTH,
  OUTER_HEADER_PREFIX_BYTES,
  PUBLIC_KEY_BYTES,
  SECRET_KEY_BYTES,
} from "./constants";
import { ByteReader, concatBytes, equalBytes, readU32BE, writeU32BE, writeU64BE } from "./bytes";
import { CryptoAuthenticationError, CryptoFormatError, CryptoVersionError } from "./errors";
import { ready } from "./sodium";

export interface OuterHeader {
  fileVersion: number;
  fileId: Uint8Array;
  sealedHeader: Uint8Array;
  byteLength: number;
}

export interface OpenedFileHeader extends OuterHeader {
  headerVersion: number;
  chunkSize: number;
  dataSize: bigint;
  symmetricKey: Uint8Array;
  fileType: number;
  filename: string;
  videoDuration: number;
}

export interface EncryptFileOptions {
  filename: string;
  fileType: number;
  recipientPublicKey: Uint8Array;
  fileId?: Uint8Array;
  videoDuration?: number;
}

export function parseOuterHeader(bytes: Uint8Array): OuterHeader {
  if (bytes.byteLength < OUTER_HEADER_PREFIX_BYTES) {
    throw new CryptoFormatError("file outer header is truncated");
  }
  const reader = new ByteReader(bytes);
  if (!equalBytes(reader.read(2), FILE_MAGIC)) {
    throw new CryptoFormatError("not an SP file");
  }
  const fileVersion = reader.readU8();
  if (fileVersion !== FILE_VERSION) {
    throw new CryptoVersionError(`unsupported file version ${fileVersion}`);
  }
  const fileId = reader.read(FILE_ID_BYTES);
  const sealedLength = reader.readU32();
  if (sealedLength < 1 || sealedLength > MAX_BUFFER_LENGTH) {
    throw new CryptoFormatError("invalid sealed header length");
  }
  if (reader.remaining < sealedLength) {
    throw new CryptoFormatError("sealed header is truncated");
  }
  return {
    fileVersion,
    fileId,
    sealedHeader: reader.read(sealedLength),
    byteLength: OUTER_HEADER_PREFIX_BYTES + sealedLength,
  };
}

export async function openFileHeader(
  outerHeaderBytes: Uint8Array,
  recipientPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<OpenedFileHeader> {
  if (
    recipientPublicKey.byteLength !== PUBLIC_KEY_BYTES ||
    recipientPrivateKey.byteLength !== SECRET_KEY_BYTES
  ) {
    throw new CryptoFormatError("invalid header recipient keypair");
  }
  const outer = parseOuterHeader(outerHeaderBytes);
  const sodium = await ready();
  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_box_seal_open(
      outer.sealedHeader,
      recipientPublicKey,
      recipientPrivateKey,
    );
  } catch {
    throw new CryptoAuthenticationError("cannot open file header");
  }
  const reader = new ByteReader(plaintext);
  const headerVersion = reader.readU8();
  if (headerVersion !== HEADER_VERSION) {
    throw new CryptoVersionError(`unsupported inner header version ${headerVersion}`);
  }
  const chunkSize = reader.readU32();
  if (chunkSize < 1 || chunkSize > MAX_BUFFER_LENGTH) {
    throw new CryptoFormatError("invalid chunk size");
  }
  const dataSize = reader.readU64();
  const symmetricKey = reader.read(32);
  const fileType = reader.readU8();
  const filenameLength = reader.readU32();
  if (filenameLength > MAX_BUFFER_LENGTH || filenameLength > reader.remaining - 4) {
    throw new CryptoFormatError("invalid filename length");
  }
  const filename = new TextDecoder().decode(reader.read(filenameLength));
  const videoDuration = reader.readU32();
  return {
    ...outer,
    headerVersion,
    chunkSize,
    dataSize,
    symmetricKey,
    fileType,
    filename,
    videoDuration,
  };
}

/** Re-seal an already authenticated header to a different recipient. */
export async function sealOpenedFileHeader(
  header: OpenedFileHeader,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  if (recipientPublicKey.byteLength !== PUBLIC_KEY_BYTES) {
    throw new CryptoFormatError("invalid header recipient public key");
  }
  const filename = new TextEncoder().encode(header.filename);
  if (filename.byteLength > MAX_BUFFER_LENGTH) throw new CryptoFormatError("filename is too long");
  const inner = concatBytes(
    new Uint8Array([header.headerVersion]),
    writeU32BE(header.chunkSize),
    writeU64BE(header.dataSize),
    header.symmetricKey,
    new Uint8Array([header.fileType]),
    writeU32BE(filename.byteLength),
    filename,
    writeU32BE(header.videoDuration),
  );
  const sealedHeader = (await ready()).crypto_box_seal(inner, recipientPublicKey);
  return concatBytes(
    FILE_MAGIC,
    new Uint8Array([header.fileVersion]),
    header.fileId,
    writeU32BE(sealedHeader.byteLength),
    sealedHeader,
  );
}

export async function encryptFileBytes(
  plaintext: Uint8Array,
  options: EncryptFileOptions,
): Promise<{ blob: Uint8Array; header: OpenedFileHeader; outerHeader: Uint8Array }> {
  const sodium = await ready();
  const fileId = options.fileId?.slice() ?? sodium.randombytes_buf(FILE_ID_BYTES);
  if (fileId.byteLength !== FILE_ID_BYTES) throw new CryptoFormatError("file ID must be 32 bytes");
  const symmetricKey = sodium.crypto_kdf_keygen();
  const filename = new TextEncoder().encode(options.filename);
  const inner = concatBytes(
    new Uint8Array([HEADER_VERSION]),
    writeU32BE(DEFAULT_CHUNK_SIZE),
    writeU64BE(BigInt(plaintext.byteLength)),
    symmetricKey,
    new Uint8Array([options.fileType]),
    writeU32BE(filename.byteLength),
    filename,
    writeU32BE(options.videoDuration ?? 0),
  );
  const sealedHeader = sodium.crypto_box_seal(inner, options.recipientPublicKey);
  const outerHeader = concatBytes(
    FILE_MAGIC,
    new Uint8Array([FILE_VERSION]),
    fileId,
    writeU32BE(sealedHeader.byteLength),
    sealedHeader,
  );
  const records: Uint8Array[] = [outerHeader];
  let chunkNumber = 1;
  for (let offset = 0; offset < plaintext.byteLength; offset += DEFAULT_CHUNK_SIZE) {
    const chunk = plaintext.subarray(offset, Math.min(offset + DEFAULT_CHUNK_SIZE, plaintext.byteLength));
    const nonce = sodium.randombytes_buf(AEAD_NONCE_BYTES);
    const chunkKey = sodium.crypto_kdf_derive_from_key(32, chunkNumber, DATA_KDF_CONTEXT, symmetricKey);
    try {
      records.push(
        nonce,
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(chunk, null, null, nonce, chunkKey),
      );
    } finally {
      sodium.memzero(chunkKey);
    }
    chunkNumber += 1;
  }
  return {
    blob: concatBytes(...records),
    outerHeader,
    header: {
      fileVersion: FILE_VERSION,
      fileId,
      sealedHeader,
      byteLength: outerHeader.byteLength,
      headerVersion: HEADER_VERSION,
      chunkSize: DEFAULT_CHUNK_SIZE,
      dataSize: BigInt(plaintext.byteLength),
      symmetricKey,
      fileType: options.fileType,
      filename: options.filename,
      videoDuration: options.videoDuration ?? 0,
    },
  };
}

export interface EncryptedByteSource {
  readonly size?: bigint;
  read(start: bigint, endInclusive: bigint): Promise<Uint8Array>;
}

export class MemoryByteSource implements EncryptedByteSource {
  readonly size: bigint;

  constructor(private readonly bytes: Uint8Array) {
    this.size = BigInt(bytes.byteLength);
  }

  async read(start: bigint, endInclusive: bigint): Promise<Uint8Array> {
    if (start < 0n || endInclusive < start || endInclusive >= this.size) {
      throw new CryptoFormatError("encrypted source range is invalid");
    }
    return this.bytes.slice(Number(start), Number(endInclusive + 1n));
  }
}

function chunkPlaintextLength(header: OpenedFileHeader, chunkIndex: bigint): bigint {
  const chunkSize = BigInt(header.chunkSize);
  const offset = chunkIndex * chunkSize;
  const remaining = header.dataSize - offset;
  return remaining < chunkSize ? remaining : chunkSize;
}

export function expectedEncryptedSize(header: OpenedFileHeader, blobOuterHeaderLength: number): bigint {
  if (header.dataSize === 0n) return BigInt(blobOuterHeaderLength);
  const chunkSize = BigInt(header.chunkSize);
  const chunkCount = (header.dataSize + chunkSize - 1n) / chunkSize;
  return (
    BigInt(blobOuterHeaderLength) +
    header.dataSize +
    chunkCount * BigInt(AEAD_NONCE_BYTES + AEAD_MAC_BYTES)
  );
}

export async function decryptPlaintextRange(
  source: EncryptedByteSource,
  externalHeader: OpenedFileHeader,
  start: bigint,
  endInclusive: bigint,
): Promise<Uint8Array> {
  if (externalHeader.dataSize === 0n || start < 0n || endInclusive < start || endInclusive >= externalHeader.dataSize) {
    throw new CryptoFormatError("plaintext range is not satisfiable");
  }
  const prefix = await source.read(0n, BigInt(OUTER_HEADER_PREFIX_BYTES - 1));
  if (!equalBytes(prefix.subarray(0, 2), FILE_MAGIC)) throw new CryptoFormatError("not an SP file");
  if (prefix[2] !== FILE_VERSION) throw new CryptoVersionError(`unsupported file version ${prefix[2]}`);
  const blobFileId = prefix.slice(3, 3 + FILE_ID_BYTES);
  if (!equalBytes(blobFileId, externalHeader.fileId)) {
    throw new CryptoAuthenticationError("external header does not belong to encrypted blob");
  }
  const sealedLength = readU32BE(prefix, OUTER_HEADER_PREFIX_BYTES - 4);
  if (sealedLength < 1 || sealedLength > MAX_BUFFER_LENGTH) {
    throw new CryptoFormatError("invalid blob header length");
  }
  const blobOuterHeaderLength = OUTER_HEADER_PREFIX_BYTES + sealedLength;
  const expectedSize = expectedEncryptedSize(externalHeader, blobOuterHeaderLength);
  if (source.size !== undefined && source.size !== expectedSize) {
    throw new CryptoFormatError("encrypted blob length does not match authenticated header");
  }

  const sodium = await ready();
  const chunkSize = BigInt(externalHeader.chunkSize);
  const stride = chunkSize + BigInt(AEAD_NONCE_BYTES + AEAD_MAC_BYTES);
  const firstChunk = start / chunkSize;
  const lastChunk = endInclusive / chunkSize;
  const chunks: Uint8Array[] = [];
  for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1n) {
    const plaintextLength = chunkPlaintextLength(externalHeader, chunkIndex);
    const encryptedStart = BigInt(blobOuterHeaderLength) + chunkIndex * stride;
    const encryptedLength = BigInt(AEAD_NONCE_BYTES + AEAD_MAC_BYTES) + plaintextLength;
    const record = await source.read(encryptedStart, encryptedStart + encryptedLength - 1n);
    const nonce = record.subarray(0, AEAD_NONCE_BYTES);
    const ciphertext = record.subarray(AEAD_NONCE_BYTES);
    const chunkKey = sodium.crypto_kdf_derive_from_key(
      32,
      chunkIndex + 1n,
      DATA_KDF_CONTEXT,
      externalHeader.symmetricKey,
    );
    try {
      chunks.push(
        sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, chunkKey),
      );
    } catch {
      throw new CryptoAuthenticationError(`encrypted chunk ${chunkIndex + 1n} failed authentication`);
    } finally {
      sodium.memzero(chunkKey);
    }
  }
  const combined = concatBytes(...chunks);
  const base = firstChunk * chunkSize;
  return combined.slice(Number(start - base), Number(endInclusive - base + 1n));
}
