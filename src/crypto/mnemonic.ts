import { wordlist } from "@scure/bip39/wordlists/english.js";

import { CryptoFormatError } from "./errors";
import { ready } from "./sodium";

function bytesToBits(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(2).padStart(8, "0")).join("");
}

function bitsToBytes(bits: string): Uint8Array {
  const output = new Uint8Array(bits.length / 8);
  for (let index = 0; index < output.byteLength; index += 1) {
    output[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  return output;
}

export async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  if (entropy.byteLength < 16 || entropy.byteLength > 32 || entropy.byteLength % 4 !== 0) {
    throw new CryptoFormatError("BIP39 entropy must be 16, 20, 24, 28, or 32 bytes");
  }
  const checksumLength = entropy.byteLength / 4;
  const digest = (await ready()).crypto_hash_sha256(entropy);
  const bits = bytesToBits(entropy) + bytesToBits(digest).slice(0, checksumLength);
  const words: string[] = [];
  for (let offset = 0; offset < bits.length; offset += 11) {
    const word = wordlist[Number.parseInt(bits.slice(offset, offset + 11), 2)];
    if (!word) throw new CryptoFormatError("BIP39 word index is invalid");
    words.push(word);
  }
  return words.join(" ");
}

export async function mnemonicToEntropy(phrase: string): Promise<Uint8Array> {
  const words = phrase.trim().split(/\s+/u);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new CryptoFormatError("BIP39 mnemonic has an invalid word count");
  }
  let bits = "";
  for (const word of words) {
    const index = wordlist.indexOf(word);
    if (index < 0) throw new CryptoFormatError(`unknown BIP39 word: ${word}`);
    bits += index.toString(2).padStart(11, "0");
  }
  const entropyLength = Math.floor((bits.length * 32) / 33);
  const checksumLength = bits.length - entropyLength;
  const entropy = bitsToBytes(bits.slice(0, entropyLength));
  const expected = bytesToBits((await ready()).crypto_hash_sha256(entropy)).slice(0, checksumLength);
  if (bits.slice(entropyLength) !== expected) {
    throw new CryptoFormatError("BIP39 mnemonic checksum is invalid");
  }
  return entropy;
}
