export const FileSet = Object.freeze({ GALLERY: 0, TRASH: 1, ALBUM: 2 } as const);

export const DeleteEventType = Object.freeze({
  GALLERY: 1,
  TRASH: 2,
  PERMANENT: 3,
  ALBUM: 4,
  ALBUM_FILE: 5,
  CONTACT: 6,
} as const);

export type DeleteEventCode = (typeof DeleteEventType)[keyof typeof DeleteEventType];

export interface RemoteFile {
  file: string;
  albumId?: string;
  version: number;
  headers: string;
  dateCreated: number;
  dateModified: number;
}

export interface RemoteAlbum {
  albumId: string;
  encPrivateKey: string;
  publicKey: string;
  metadata: string;
  isShared: boolean;
  isHidden: boolean;
  isOwner: boolean;
  members: string;
  permissions: string;
  isLocked: boolean;
  cover: string;
  dateCreated: number;
  dateModified: number;
}

export interface RemoteContact {
  userId: string;
  email: string;
  publicKey: string;
  dateUsed: number;
  dateModified: number;
}

export interface DeleteEvent {
  file: string;
  albumId?: string;
  type: DeleteEventCode;
  date: number;
}

export interface SyncCursors {
  files: number;
  trash: number;
  albums: number;
  albumFiles: number;
  deletes: number;
  contacts: number;
}

export const ZERO_CURSORS: Readonly<SyncCursors> = Object.freeze({
  files: 0,
  trash: 0,
  albums: 0,
  albumFiles: 0,
  deletes: 0,
  contacts: 0,
});

export interface SyncUpdates {
  files: RemoteFile[];
  trash: RemoteFile[];
  albums: RemoteAlbum[];
  albumFiles: RemoteFile[];
  contacts: RemoteContact[];
  deletes: DeleteEvent[];
  spaceUsed?: number;
  spaceQuota?: number;
}

export interface LocalFile extends RemoteFile {
  isLocal: boolean;
  isRemote: boolean;
  reupload: boolean;
}

export interface LocalAlbum extends RemoteAlbum {
  syncLocal: boolean;
}

export interface SyncSummary {
  received: number;
  files: number;
  trash: number;
  albums: number;
  albumFiles: number;
  contacts: number;
  deletes: number;
  spaceUsed?: number;
  spaceQuota?: number;
  caughtUp: boolean;
}

