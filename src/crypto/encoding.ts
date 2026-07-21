import { ready } from "./sodium";

export async function fromBase64(value: string): Promise<Uint8Array> {
  const sodium = await ready();
  return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
}

export async function fromBase64Flexible(value: string): Promise<Uint8Array> {
  const sodium = await ready();
  const variants = [
    sodium.base64_variants.ORIGINAL,
    sodium.base64_variants.ORIGINAL_NO_PADDING,
    sodium.base64_variants.URLSAFE,
    sodium.base64_variants.URLSAFE_NO_PADDING,
  ];
  for (const variant of variants) {
    try {
      return sodium.from_base64(value.trim(), variant);
    } catch {
      // Try the next historical encoding used by another client.
    }
  }
  throw new Error("invalid base64");
}

export async function toBase64(value: Uint8Array): Promise<string> {
  const sodium = await ready();
  return sodium.to_base64(value, sodium.base64_variants.ORIGINAL);
}

export async function fromBase64Url(value: string): Promise<Uint8Array> {
  const sodium = await ready();
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function toBase64Url(value: Uint8Array): Promise<string> {
  const sodium = await ready();
  return sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function fromHex(value: string): Promise<Uint8Array> {
  return (await ready()).from_hex(value);
}

export async function toHexUpper(value: Uint8Array): Promise<string> {
  return (await ready()).to_hex(value).toUpperCase();
}
