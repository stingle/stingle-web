import type { DecryptedLibrarySnapshot, EncryptedAlbumDescriptor, EncryptedFileDescriptor, PersistedAuthSession, PreparedAlbum, PreparedRegistration, PreparedUpload } from "./vault-core";
import type { OpenedFileHeader } from "../crypto/file";

export type VaultOperation =
  | { type: "derive-login-hash"; password: string; accountSaltHex: string }
  | { type: "prepare-registration"; password: string }
  | { type: "unlock-session"; password: string; keyBundleBase64: string; serverPublicKeyBase64: string }
  | { type: "encrypt-params"; params: unknown }
  | { type: "decrypt-library"; albums: EncryptedAlbumDescriptor[]; files: EncryptedFileDescriptor[] }
  | { type: "open-media-header"; headers: string; isThumb: boolean; album?: EncryptedAlbumDescriptor }
  | { type: "decrypt-file-blob"; encryptedBlob: Uint8Array; headers: string; isThumb: boolean; album?: EncryptedAlbumDescriptor }
  | { type: "create-album"; name: string; timestamp: number }
  | { type: "reseal-file-headers"; headers: string; sourceAlbum?: EncryptedAlbumDescriptor; targetAlbum?: EncryptedAlbumDescriptor }
  | { type: "prepare-upload"; original: Uint8Array; thumbnail: Uint8Array; filename: string; fileType: 2 | 3; videoDuration: number; album?: EncryptedAlbumDescriptor }
  | { type: "persist-session"; session: PersistedAuthSession }
  | { type: "restore-session" }
  | { type: "clear" };

export interface VaultRequest {
  id: number;
  operation: VaultOperation;
}

export type VaultResult = string | PreparedRegistration | PreparedAlbum | PreparedUpload | PersistedAuthSession | DecryptedLibrarySnapshot | OpenedFileHeader | Uint8Array | undefined;

export type VaultReply =
  | { id: number; ok: true; result: VaultResult }
  | { id: number; ok: false; error: string };
