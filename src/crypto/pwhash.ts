import { PWHASH_SALT_BYTES } from "./constants";
import { CryptoFormatError } from "./errors";
import { ready } from "./sodium";

export type PasswordDifficulty = "interactive" | "moderate";

export async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  difficulty: PasswordDifficulty,
  outputLength = 32,
): Promise<Uint8Array> {
  if (salt.byteLength !== PWHASH_SALT_BYTES) {
    throw new CryptoFormatError("Argon2id salt must be 16 bytes");
  }
  const sodium = await ready();
  const opsLimit =
    difficulty === "interactive"
      ? sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE
      : sodium.crypto_pwhash_OPSLIMIT_MODERATE;
  const memLimit =
    difficulty === "interactive"
      ? sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
      : sodium.crypto_pwhash_MEMLIMIT_MODERATE;
  return sodium.crypto_pwhash(
    outputLength,
    password,
    salt,
    opsLimit,
    memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function passwordHashForStorage(password: string, salt: Uint8Array): Promise<string> {
  const sodium = await ready();
  const hash = await derivePasswordKey(password, salt, "moderate", 64);
  try {
    return sodium.to_hex(hash).toUpperCase();
  } finally {
    sodium.memzero(hash);
  }
}
