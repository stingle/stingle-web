import { ALBUM_METADATA_VERSION, FILE_ID_BYTES, MAX_BUFFER_LENGTH, PUBLIC_KEY_BYTES, SECRET_KEY_BYTES } from "./constants";
import { ByteReader, concatBytes, writeU32BE } from "./bytes";
import { toBase64, toBase64Url } from "./encoding";
import { CryptoAuthenticationError, CryptoFormatError, CryptoVersionError } from "./errors";
import { ready } from "./sodium";

export interface CreatedAlbumMaterial {
  albumId: string;
  encPrivateKey: string;
  publicKey: string;
  metadata: string;
}

export async function createAlbumMaterial(
  name: string,
  userPublicKey: Uint8Array,
): Promise<CreatedAlbumMaterial> {
  if (userPublicKey.byteLength !== PUBLIC_KEY_BYTES) throw new CryptoFormatError("invalid user public key");
  const encodedName = new TextEncoder().encode(name);
  if (encodedName.byteLength > MAX_BUFFER_LENGTH) throw new CryptoFormatError("album name is too long");
  const sodium = await ready();
  const album = sodium.crypto_box_keypair();
  try {
    const metadata = sodium.crypto_box_seal(
      concatBytes(new Uint8Array([ALBUM_METADATA_VERSION]), writeU32BE(encodedName.byteLength), encodedName),
      album.publicKey,
    );
    const encryptedPrivateKey = sodium.crypto_box_seal(album.privateKey, userPublicKey);
    return {
      albumId: await toBase64Url(sodium.randombytes_buf(FILE_ID_BYTES)),
      publicKey: await toBase64(album.publicKey),
      encPrivateKey: await toBase64(encryptedPrivateKey),
      metadata: await toBase64(metadata),
    };
  } finally {
    sodium.memzero(album.privateKey);
  }
}

export async function openAlbumPrivateKey(
  encryptedAlbumPrivateKey: Uint8Array,
  userPublicKey: Uint8Array,
  userPrivateKey: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await ready();
  if (userPublicKey.byteLength !== PUBLIC_KEY_BYTES || userPrivateKey.byteLength !== SECRET_KEY_BYTES) {
    throw new CryptoFormatError("invalid user keypair length");
  }
  try {
    const albumPrivateKey = sodium.crypto_box_seal_open(
      encryptedAlbumPrivateKey,
      userPublicKey,
      userPrivateKey,
    );
    if (albumPrivateKey.byteLength !== SECRET_KEY_BYTES) {
      throw new CryptoFormatError("invalid album private key length");
    }
    return albumPrivateKey;
  } catch (error) {
    if (error instanceof CryptoFormatError) throw error;
    throw new CryptoAuthenticationError("cannot open album private key");
  }
}

export async function openAlbumName(
  encryptedMetadata: Uint8Array,
  albumPublicKey: Uint8Array,
  albumPrivateKey: Uint8Array,
): Promise<string> {
  const sodium = await ready();
  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_box_seal_open(encryptedMetadata, albumPublicKey, albumPrivateKey);
  } catch {
    throw new CryptoAuthenticationError("cannot open album metadata");
  }
  const reader = new ByteReader(plaintext);
  const version = reader.readU8();
  if (version !== ALBUM_METADATA_VERSION) {
    throw new CryptoVersionError(`unsupported album metadata version ${version}`);
  }
  const nameLength = reader.readU32();
  if (nameLength > MAX_BUFFER_LENGTH || nameLength > reader.remaining) {
    throw new CryptoFormatError("invalid album name length");
  }
  return new TextDecoder().decode(reader.read(nameLength));
}
