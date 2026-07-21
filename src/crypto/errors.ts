export class CryptoFormatError extends Error {
  override readonly name = "CryptoFormatError";
}

export class CryptoVersionError extends Error {
  override readonly name = "CryptoVersionError";
}

export class CryptoAuthenticationError extends Error {
  override readonly name = "CryptoAuthenticationError";
}
