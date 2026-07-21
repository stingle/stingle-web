import {
  BOX_NONCE_BYTES,
  KEY_BUNDLE_BYTES,
  KEY_BUNDLE_ENCRYPTED,
  KEY_BUNDLE_MAGIC,
  KEY_BUNDLE_VERSION,
  PUBLIC_KEY_BYTES,
  SECRET_KEY_BYTES,
  SECRETBOX_MAC_BYTES,
  SECRETBOX_NONCE_BYTES,
  PWHASH_SALT_BYTES,
} from "./constants";
import { ByteReader, concatBytes, equalBytes } from "./bytes";
import { CryptoAuthenticationError, CryptoFormatError, CryptoVersionError } from "./errors";
import { fromBase64, toBase64 } from "./encoding";
import { derivePasswordKey } from "./pwhash";
import { ready } from "./sodium";

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface EncryptedKeyBundle {
  publicKey: Uint8Array;
  encryptedPrivateKey: Uint8Array;
  passwordSalt: Uint8Array;
  privateKeyNonce: Uint8Array;
}

export function parseEncryptedKeyBundle(bytes: Uint8Array): EncryptedKeyBundle {
  if (bytes.byteLength !== KEY_BUNDLE_BYTES) {
    throw new CryptoFormatError(`encrypted key bundle must be ${KEY_BUNDLE_BYTES} bytes`);
  }
  const reader = new ByteReader(bytes);
  if (!equalBytes(reader.read(3), KEY_BUNDLE_MAGIC)) {
    throw new CryptoFormatError("not an SPK key bundle");
  }
  const version = reader.readU8();
  if (version !== KEY_BUNDLE_VERSION) {
    throw new CryptoVersionError(`unsupported key bundle version ${version}`);
  }
  if (reader.readU8() !== KEY_BUNDLE_ENCRYPTED) {
    throw new CryptoFormatError("key bundle is not password encrypted");
  }
  return {
    publicKey: reader.read(PUBLIC_KEY_BYTES),
    encryptedPrivateKey: reader.read(SECRET_KEY_BYTES + SECRETBOX_MAC_BYTES),
    passwordSalt: reader.read(PWHASH_SALT_BYTES),
    privateKeyNonce: reader.read(SECRETBOX_NONCE_BYTES),
  };
}

export async function parseEncryptedKeyBundleBase64(value: string): Promise<EncryptedKeyBundle> {
  return parseEncryptedKeyBundle(await fromBase64(value));
}

export async function unlockKeyBundle(bundle: EncryptedKeyBundle, password: string): Promise<KeyPair> {
  const sodium = await ready();
  const passwordKey = await derivePasswordKey(password, bundle.passwordSalt, "moderate");
  try {
    let privateKey: Uint8Array;
    try {
      privateKey = sodium.crypto_secretbox_open_easy(
        bundle.encryptedPrivateKey,
        bundle.privateKeyNonce,
        passwordKey,
      );
    } catch {
      throw new CryptoAuthenticationError("incorrect password or corrupted key bundle");
    }
    const derivedPublicKey = sodium.crypto_scalarmult_base(privateKey);
    if (!equalBytes(derivedPublicKey, bundle.publicKey)) {
      sodium.memzero(privateKey);
      throw new CryptoAuthenticationError("key bundle public/private key mismatch");
    }
    return { publicKey: bundle.publicKey.slice(), privateKey };
  } finally {
    sodium.memzero(passwordKey);
  }
}

export async function createEncryptedKeyBundle(keyPair: KeyPair, password: string): Promise<string> {
  const sodium = await ready();
  const salt = sodium.randombytes_buf(PWHASH_SALT_BYTES);
  const nonce = sodium.randombytes_buf(SECRETBOX_NONCE_BYTES);
  const passwordKey = await derivePasswordKey(password, salt, "moderate");
  try {
    const encryptedPrivateKey = sodium.crypto_secretbox_easy(keyPair.privateKey, nonce, passwordKey);
    return toBase64(
      concatBytes(
        KEY_BUNDLE_MAGIC,
        new Uint8Array([KEY_BUNDLE_VERSION, KEY_BUNDLE_ENCRYPTED]),
        keyPair.publicKey,
        encryptedPrivateKey,
        salt,
        nonce,
      ),
    );
  } finally {
    sodium.memzero(passwordKey);
  }
}

export async function generateKeyPair(): Promise<KeyPair> {
  const keyPair = (await ready()).crypto_box_keypair();
  return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey };
}

export async function keyPairFromPrivateKey(privateKey: Uint8Array): Promise<KeyPair> {
  if (privateKey.byteLength !== SECRET_KEY_BYTES) {
    throw new CryptoFormatError("private key must be 32 bytes");
  }
  return { publicKey: (await ready()).crypto_scalarmult_base(privateKey), privateKey: privateKey.slice() };
}

export async function encryptParamsForServer(
  params: unknown,
  serverPublicKey: Uint8Array,
  userPrivateKey: Uint8Array,
): Promise<string> {
  const sodium = await ready();
  const nonce = sodium.randombytes_buf(BOX_NONCE_BYTES);
  const message = new TextEncoder().encode(JSON.stringify(params));
  const encrypted = sodium.crypto_box_easy(message, nonce, serverPublicKey, userPrivateKey);
  return toBase64(concatBytes(nonce, encrypted));
}
