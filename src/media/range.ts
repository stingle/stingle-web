import { CryptoFormatError } from "../crypto/errors";

export interface PlaintextRange {
  start: bigint;
  endInclusive: bigint;
}

export function parseRangeHeader(value: string | null, totalSize: bigint): PlaintextRange | null {
  if (value === null) return null;
  if (totalSize <= 0n || !value.startsWith("bytes=") || value.includes(",")) {
    throw new CryptoFormatError("unsupported HTTP range");
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match) throw new CryptoFormatError("malformed HTTP range");
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") throw new CryptoFormatError("empty HTTP range");

  let start: bigint;
  let endInclusive: bigint;
  if (startText === "") {
    const suffixLength = BigInt(endText);
    if (suffixLength <= 0n) throw new CryptoFormatError("invalid suffix range");
    start = suffixLength >= totalSize ? 0n : totalSize - suffixLength;
    endInclusive = totalSize - 1n;
  } else {
    start = BigInt(startText);
    endInclusive = endText === "" ? totalSize - 1n : BigInt(endText);
  }
  if (start >= totalSize || endInclusive < start) {
    throw new CryptoFormatError("HTTP range is not satisfiable");
  }
  if (endInclusive >= totalSize) endInclusive = totalSize - 1n;
  return { start, endInclusive };
}
