import {
  DeleteEventType,
  ZERO_CURSORS,
  type LocalAlbum,
  type LocalFile,
  type RemoteContact,
  type SyncCursors,
  type SyncSummary,
  type SyncUpdates,
} from "./model";

const DB_VERSION = 1;
const stores = Object.freeze({
  files: "files",
  trash: "trash",
  albums: "albums",
  albumFiles: "albumFiles",
  contacts: "contacts",
  meta: "meta",
});

interface MetaRecord {
  key: string;
  value: unknown;
}

export interface MirrorStats {
  files: number;
  trash: number;
  albums: number;
  albumFiles: number;
  contacts: number;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function collectCursor<T>(cursorRequest: IDBRequest<IDBCursorWithValue | null>, limit: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const values: T[] = [];
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("IndexedDB cursor failed."));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || values.length >= limit) {
        resolve(values);
        return;
      }
      values.push(cursor.value as T);
      cursor.continue();
    };
  });
}

function databaseName(accountKey: string): string {
  if (!accountKey || accountKey.length > 256) throw new Error("invalid account storage key");
  return `stingle-web-mirror-v1-${encodeURIComponent(accountKey)}`;
}

function maxDate(current: number, values: readonly { dateModified: number }[]): number {
  return values.reduce((maximum, value) => Math.max(maximum, value.dateModified), current);
}

function nextCursors(current: SyncCursors, updates: SyncUpdates): SyncCursors {
  return {
    files: maxDate(current.files, updates.files),
    trash: maxDate(current.trash, updates.trash),
    albums: maxDate(current.albums, updates.albums),
    albumFiles: maxDate(current.albumFiles, updates.albumFiles),
    contacts: maxDate(current.contacts, updates.contacts),
    deletes: updates.deletes.reduce((maximum, value) => Math.max(maximum, value.date), current.deletes),
  };
}

export class MirrorStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(accountKey: string, factory: IDBFactory = indexedDB): Promise<MirrorStore> {
    const opening = factory.open(databaseName(accountKey), DB_VERSION);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      const files = database.createObjectStore(stores.files, { keyPath: "file" });
      files.createIndex("dateCreated", "dateCreated");
      const trash = database.createObjectStore(stores.trash, { keyPath: "file" });
      trash.createIndex("dateCreated", "dateCreated");
      const albums = database.createObjectStore(stores.albums, { keyPath: "albumId" });
      albums.createIndex("dateModified", "dateModified");
      const albumFiles = database.createObjectStore(stores.albumFiles, { keyPath: ["albumId", "file"] });
      albumFiles.createIndex("albumId", "albumId");
      albumFiles.createIndex("dateCreated", "dateCreated");
      const contacts = database.createObjectStore(stores.contacts, { keyPath: "userId" });
      contacts.createIndex("dateModified", "dateModified");
      database.createObjectStore(stores.meta, { keyPath: "key" });
    };
    return new MirrorStore(await request(opening));
  }

  close(): void {
    this.database.close();
  }

  async getCursors(): Promise<SyncCursors> {
    const transaction = this.database.transaction(stores.meta, "readonly");
    const row = (await request(transaction.objectStore(stores.meta).get("cursors"))) as
      | MetaRecord
      | undefined;
    await transactionDone(transaction);
    if (!row || typeof row.value !== "object" || row.value === null) return { ...ZERO_CURSORS };
    return { ...ZERO_CURSORS, ...(row.value as Partial<SyncCursors>) };
  }

  async applyUpdates(updates: SyncUpdates): Promise<SyncSummary> {
    const transaction = this.database.transaction(Object.values(stores), "readwrite");
    const files = transaction.objectStore(stores.files);
    const trash = transaction.objectStore(stores.trash);
    const albums = transaction.objectStore(stores.albums);
    const albumFiles = transaction.objectStore(stores.albumFiles);
    const contacts = transaction.objectStore(stores.contacts);
    const meta = transaction.objectStore(stores.meta);

    try {
      const cursorRow = (await request(meta.get("cursors"))) as MetaRecord | undefined;
      const current: SyncCursors = cursorRow?.value
        ? { ...ZERO_CURSORS, ...(cursorRow.value as Partial<SyncCursors>) }
        : { ...ZERO_CURSORS };

      for (const remote of updates.files) {
        const local = (await request(files.get(remote.file))) as LocalFile | undefined;
        await request(files.put({
          ...remote,
          isLocal: local?.isLocal ?? false,
          isRemote: true,
          reupload: local?.reupload ?? false,
        } satisfies LocalFile));
      }
      for (const remote of updates.trash) {
        const local = (await request(trash.get(remote.file))) as LocalFile | undefined;
        await request(trash.put({
          ...remote,
          isLocal: local?.isLocal ?? false,
          isRemote: true,
          reupload: local?.reupload ?? false,
        } satisfies LocalFile));
      }
      for (const remote of updates.albums) {
        const local = (await request(albums.get(remote.albumId))) as LocalAlbum | undefined;
        await request(albums.put({ ...remote, syncLocal: local?.syncLocal ?? false } satisfies LocalAlbum));
      }
      for (const remote of updates.albumFiles) {
        const key: [string, string] = [remote.albumId!, remote.file];
        const local = (await request(albumFiles.get(key))) as LocalFile | undefined;
        await request(albumFiles.put({
          ...remote,
          isLocal: local?.isLocal ?? false,
          isRemote: true,
          reupload: local?.reupload ?? false,
        } satisfies LocalFile));
      }
      for (const remote of updates.contacts) {
        const local = (await request(contacts.get(remote.userId))) as RemoteContact | undefined;
        await request(contacts.put({ ...remote, dateUsed: Math.max(remote.dateUsed, local?.dateUsed ?? 0) }));
      }

      for (const deletion of updates.deletes) {
        if (deletion.type === DeleteEventType.CONTACT) {
          await request(contacts.delete(deletion.file));
          continue;
        }
        if (deletion.type === DeleteEventType.ALBUM) {
          const album = (await request(albums.get(deletion.albumId!))) as LocalAlbum | undefined;
          if (album && album.dateModified < deletion.date) {
            const albumIndex = albumFiles.index("albumId");
            const keys = await request(albumIndex.getAllKeys(deletion.albumId!));
            for (const key of keys) await request(albumFiles.delete(key));
            await request(albums.delete(deletion.albumId!));
          }
          continue;
        }
        const target =
          deletion.type === DeleteEventType.GALLERY
            ? files
            : deletion.type === DeleteEventType.ALBUM_FILE
              ? albumFiles
              : trash;
        const key: IDBValidKey =
          deletion.type === DeleteEventType.ALBUM_FILE
            ? [deletion.albumId!, deletion.file]
            : deletion.file;
        const local = (await request(target.get(key))) as LocalFile | undefined;
        if (local && local.dateModified < deletion.date) await request(target.delete(key));
      }

      const cursors = nextCursors(current, updates);
      await request(meta.put({ key: "cursors", value: cursors } satisfies MetaRecord));
      if (updates.spaceUsed !== undefined) {
        await request(meta.put({ key: "spaceUsed", value: updates.spaceUsed } satisfies MetaRecord));
      }
      if (updates.spaceQuota !== undefined) {
        await request(meta.put({ key: "spaceQuota", value: updates.spaceQuota } satisfies MetaRecord));
      }
      await transactionDone(transaction);

      const counts = await this.getStats();
      const received =
        updates.files.length + updates.trash.length + updates.albums.length +
        updates.albumFiles.length + updates.contacts.length + updates.deletes.length;
      const summary: SyncSummary = {
        received,
        ...counts,
        deletes: updates.deletes.length,
        caughtUp: received === 0,
      };
      if (updates.spaceUsed !== undefined) summary.spaceUsed = updates.spaceUsed;
      if (updates.spaceQuota !== undefined) summary.spaceQuota = updates.spaceQuota;
      return summary;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have completed if a later stats read failed.
      }
      throw error;
    }
  }

  async getStats(): Promise<MirrorStats> {
    const names = [stores.files, stores.trash, stores.albums, stores.albumFiles, stores.contacts] as const;
    const transaction = this.database.transaction([...names], "readonly");
    const counts = await Promise.all(
      names.map((name) => request(transaction.objectStore(name).count())),
    );
    await transactionDone(transaction);
    return {
      files: counts[0]!,
      trash: counts[1]!,
      albums: counts[2]!,
      albumFiles: counts[3]!,
      contacts: counts[4]!,
    };
  }

  async getFile(set: "files" | "trash", filename: string): Promise<LocalFile | undefined> {
    const transaction = this.database.transaction(set, "readonly");
    const result = (await request(transaction.objectStore(set).get(filename))) as LocalFile | undefined;
    await transactionDone(transaction);
    return result;
  }

  async getAlbum(albumId: string): Promise<LocalAlbum | undefined> {
    const transaction = this.database.transaction(stores.albums, "readonly");
    const result = (await request(transaction.objectStore(stores.albums).get(albumId))) as
      | LocalAlbum
      | undefined;
    await transactionDone(transaction);
    return result;
  }

  async getAlbumFile(albumId: string, filename: string): Promise<LocalFile | undefined> {
    const transaction = this.database.transaction(stores.albumFiles, "readonly");
    const result = (await request(transaction.objectStore(stores.albumFiles).get([albumId, filename]))) as
      | LocalFile
      | undefined;
    await transactionDone(transaction);
    return result;
  }

  async listFiles(set: "files" | "trash", limit = 200): Promise<LocalFile[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("invalid page limit");
    const transaction = this.database.transaction(set, "readonly");
    const result = await collectCursor<LocalFile>(
      transaction.objectStore(set).index("dateCreated").openCursor(undefined, "prev"),
      limit,
    );
    await transactionDone(transaction);
    return result;
  }

  async listAlbums(limit = 1_000): Promise<LocalAlbum[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("invalid page limit");
    const transaction = this.database.transaction(stores.albums, "readonly");
    const result = await collectCursor<LocalAlbum>(
      transaction.objectStore(stores.albums).index("dateModified").openCursor(undefined, "prev"),
      limit,
    );
    await transactionDone(transaction);
    return result;
  }

  async listAlbumFiles(albumId: string, limit = 200): Promise<LocalFile[]> {
    if (!albumId) throw new Error("album id is required");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("invalid page limit");
    const transaction = this.database.transaction(stores.albumFiles, "readonly");
    const result = ((await request(
      transaction.objectStore(stores.albumFiles).index("albumId").getAll(albumId),
    )) as LocalFile[])
      .sort((left, right) => right.dateCreated - left.dateCreated)
      .slice(0, limit);
    await transactionDone(transaction);
    return result;
  }

  async setAlbumSyncLocal(albumId: string, syncLocal: boolean): Promise<void> {
    const transaction = this.database.transaction(stores.albums, "readwrite");
    const objectStore = transaction.objectStore(stores.albums);
    const album = (await request(objectStore.get(albumId))) as LocalAlbum | undefined;
    if (!album) {
      transaction.abort();
      throw new Error("album does not exist");
    }
    await request(objectStore.put({ ...album, syncLocal } satisfies LocalAlbum));
    await transactionDone(transaction);
  }

  async getContact(userId: string): Promise<RemoteContact | undefined> {
    const transaction = this.database.transaction(stores.contacts, "readonly");
    const result = (await request(transaction.objectStore(stores.contacts).get(userId))) as
      | RemoteContact
      | undefined;
    await transactionDone(transaction);
    return result;
  }
}
