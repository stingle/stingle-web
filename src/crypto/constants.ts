export const PUBLIC_KEY_BYTES = 32;
export const SECRET_KEY_BYTES = 32;
export const BOX_MAC_BYTES = 16;
export const BOX_NONCE_BYTES = 24;
export const SEAL_BYTES = 48;

export const SECRETBOX_NONCE_BYTES = 24;
export const SECRETBOX_MAC_BYTES = 16;
export const PWHASH_SALT_BYTES = 16;

export const FILE_MAGIC = new Uint8Array([0x53, 0x50]);
export const FILE_VERSION = 1;
export const HEADER_VERSION = 1;
export const FILE_ID_BYTES = 32;
export const OUTER_HEADER_PREFIX_BYTES = 2 + 1 + FILE_ID_BYTES + 4;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const DATA_KDF_CONTEXT = "__data__";
export const AEAD_NONCE_BYTES = 24;
export const AEAD_MAC_BYTES = 16;
export const MAX_BUFFER_LENGTH = 64 * 1024 * 1024;

export const KEY_BUNDLE_MAGIC = new Uint8Array([0x53, 0x50, 0x4b]);
export const KEY_BUNDLE_VERSION = 1;
export const KEY_BUNDLE_ENCRYPTED = 0;
export const KEY_BUNDLE_BYTES = 125;

export const ALBUM_METADATA_VERSION = 1;
