import type { OpenedFileHeader } from "../crypto/file";

export const MEDIA_PATH_PREFIX = "/_stingle_media/";

export interface RegisterMemoryMediaSessionMessage {
  type: "register-media-session";
  sessionId: string;
  mimeType: string;
  encryptedBlob: Uint8Array;
  header: OpenedFileHeader;
}

export interface RegisterRemoteMediaSessionMessage {
  type: "register-remote-media-session";
  sessionId: string;
  mimeType: string;
  remoteUrl: string;
  header: OpenedFileHeader;
}

export interface CloseMediaSessionMessage {
  type: "close-media-session";
  sessionId: string;
}

export type MediaWorkerMessage = RegisterMemoryMediaSessionMessage | RegisterRemoteMediaSessionMessage | CloseMediaSessionMessage;

export interface MediaWorkerReply {
  ok: boolean;
  error?: string;
}
