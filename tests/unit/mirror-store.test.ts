import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, test, vi } from "vitest";

import { DeleteEventType, type SyncUpdates, ZERO_CURSORS } from "../../src/sync/model";
import { MirrorStore } from "../../src/sync/mirror-store";
import { SyncEngine } from "../../src/sync/sync-engine";

function emptyUpdates(overrides: Partial<SyncUpdates> = {}): SyncUpdates {
  return { files: [], trash: [], albums: [], albumFiles: [], contacts: [], deletes: [], ...overrides };
}

async function createVersionOneMirror(factory: IDBFactory, accountKey: string): Promise<void> {
  const opening = factory.open(`stingle-web-mirror-v1-${encodeURIComponent(accountKey)}`, 1);
  opening.onupgradeneeded = () => {
    const database = opening.result;
    const files = database.createObjectStore("files", { keyPath: "file" });
    files.createIndex("dateCreated", "dateCreated");
    const trash = database.createObjectStore("trash", { keyPath: "file" });
    trash.createIndex("dateCreated", "dateCreated");
    const albums = database.createObjectStore("albums", { keyPath: "albumId" });
    albums.createIndex("dateModified", "dateModified");
    const albumFiles = database.createObjectStore("albumFiles", { keyPath: ["albumId", "file"] });
    albumFiles.createIndex("albumId", "albumId");
    albumFiles.createIndex("dateCreated", "dateCreated");
    const contacts = database.createObjectStore("contacts", { keyPath: "userId" });
    contacts.createIndex("dateModified", "dateModified");
    database.createObjectStore("meta", { keyPath: "key" });
  };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  database.close();
}

describe("per-account sync mirror", () => {
  test("atomically upserts streams, advances independent cursors, and survives reopen", async () => {
    const factory = new IDBFactory();
    let store = await MirrorStore.open("account-a", factory);
    const summary = await store.applyUpdates(
      emptyUpdates({
        files: [{ file: "gallery.sp", version: 1, headers: "a*b", dateCreated: 10, dateModified: 101 }],
        trash: [{ file: "trash.sp", version: 2, headers: "c*d", dateCreated: 20, dateModified: 202 }],
        albums: [{
          albumId: "album", encPrivateKey: "esk", publicKey: "pk", metadata: "metadata",
          isShared: false, isHidden: false, isOwner: true, members: "", permissions: "000",
          isLocked: false, cover: "", dateCreated: 30, dateModified: 303,
        }],
        albumFiles: [{ file: "album-file.sp", albumId: "album", version: 1, headers: "e*f", dateCreated: 40, dateModified: 404 }],
        contacts: [{ userId: "7", email: "friend@example.test", publicKey: "contact-pk", dateUsed: 5, dateModified: 505 }],
        spaceUsed: 12,
        spaceQuota: 1024,
      }),
    );
    expect(summary).toMatchObject({ received: 5, files: 1, trash: 1, albums: 1, albumFiles: 1, contacts: 1 });
    expect(await store.getCursors()).toEqual({
      files: 101, trash: 202, albums: 303, albumFiles: 404, deletes: 0, contacts: 505,
    });
    store.close();
    store = await MirrorStore.open("account-a", factory);
    expect(await store.getStats()).toEqual({ files: 1, trash: 1, albums: 1, albumFiles: 1, contacts: 1 });
    store.close();
  });

  test("applies only newer tombstones and contact deletion unconditionally", async () => {
    const store = await MirrorStore.open("account-b", new IDBFactory());
    await store.applyUpdates(
      emptyUpdates({
        files: [{ file: "item.sp", version: 1, headers: "a*b", dateCreated: 1, dateModified: 100 }],
        contacts: [{ userId: "9", email: "x@example.test", publicKey: "pk", dateUsed: 1, dateModified: 500 }],
      }),
    );
    await store.applyUpdates(
      emptyUpdates({
        deletes: [
          { file: "item.sp", type: DeleteEventType.GALLERY, date: 99 },
          { file: "9", type: DeleteEventType.CONTACT, date: 2 },
        ],
      }),
    );
    expect(await store.getFile("files", "item.sp")).toBeDefined();
    expect(await store.getContact("9")).toBeUndefined();
    await store.applyUpdates(
      emptyUpdates({ deletes: [{ file: "item.sp", type: DeleteEventType.GALLERY, date: 101 }] }),
    );
    expect(await store.getFile("files", "item.sp")).toBeUndefined();
    expect((await store.getCursors()).deletes).toBe(101);
    store.close();
  });

  test("preserves local album download preference and contact recency", async () => {
    const store = await MirrorStore.open("account-c", new IDBFactory());
    const album = {
      albumId: "album", encPrivateKey: "esk", publicKey: "pk", metadata: "m",
      isShared: false, isHidden: false, isOwner: true, members: "", permissions: "000",
      isLocked: false, cover: "", dateCreated: 1, dateModified: 2,
    };
    await store.applyUpdates(emptyUpdates({
      albums: [album],
      contacts: [{ userId: "1", email: "a@b.test", publicKey: "pk", dateUsed: 50, dateModified: 2 }],
    }));
    await store.setAlbumSyncLocal("album", true);
    await store.applyUpdates(emptyUpdates({
      albums: [{ ...album, metadata: "new", dateModified: 3 }],
      contacts: [{ userId: "1", email: "a@b.test", publicKey: "pk", dateUsed: 0, dateModified: 3 }],
    }));
    expect((await store.getAlbum("album"))?.syncLocal).toBe(true);
    expect((await store.getContact("1"))?.dateUsed).toBe(50);
    store.close();
  });

  test("coalesces concurrent sync requests", async () => {
    const store = await MirrorStore.open("account-d", new IDBFactory());
    const source = { getUpdates: vi.fn().mockResolvedValue(emptyUpdates()) };
    const engine = new SyncEngine(source, store);
    const first = engine.syncOnce();
    const second = engine.syncOnce();
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ caughtUp: true, received: 0 });
    expect(source.getUpdates).toHaveBeenCalledOnce();
    expect(source.getUpdates).toHaveBeenCalledWith({ ...ZERO_CURSORS });
    store.close();
  });

  test("lists gallery, trash, albums, and album items newest first", async () => {
    const store = await MirrorStore.open("account-list", new IDBFactory(), IDBKeyRange);
    const album = {
      albumId: "album", encPrivateKey: "esk", publicKey: "pk", metadata: "m",
      isShared: true, isHidden: false, isOwner: false, members: "", permissions: "000",
      isLocked: false, cover: "", dateCreated: 1, dateModified: 2,
    };
    await store.applyUpdates(emptyUpdates({
      files: [
        { file: "old.sp", version: 1, headers: "a", dateCreated: 10, dateModified: 10 },
        { file: "new.sp", version: 1, headers: "b", dateCreated: 20, dateModified: 20 },
        { file: "newest.sp", version: 1, headers: "c", dateCreated: 30, dateModified: 30 },
      ],
      trash: [{ file: "trash.sp", version: 1, headers: "c", dateCreated: 5, dateModified: 5 }],
      albums: [album],
      albumFiles: [
        { file: "one.sp", albumId: "album", version: 1, headers: "d", dateCreated: 30, dateModified: 30 },
        { file: "two.sp", albumId: "album", version: 1, headers: "e", dateCreated: 40, dateModified: 40 },
        { file: "three.sp", albumId: "album", version: 1, headers: "f", dateCreated: 50, dateModified: 50 },
      ],
    }));
    expect(await store.countFiles("files")).toBe(3);
    expect(await store.listFileDateGroups("files")).toEqual([{ dateCreated: 30, count: 3 }]);
    expect((await store.listFiles("files", 1)).map((file) => file.file)).toEqual(["newest.sp"]);
    expect((await store.listFiles("files", 1, 1)).map((file) => file.file)).toEqual(["new.sp"]);
    expect((await store.listFiles("trash")).map((file) => file.file)).toEqual(["trash.sp"]);
    expect((await store.listAlbums()).map((value) => value.albumId)).toEqual(["album"]);
    expect(await store.countAlbumFiles("album")).toBe(3);
    expect(await store.listAlbumFileDateGroups("album")).toEqual([{ dateCreated: 50, count: 3 }]);
    expect((await store.listAlbumFiles("album", 2, 1)).map((file) => file.file)).toEqual(["two.sp", "one.sp"]);
    store.close();
  });

  test("persists accepted uploads immediately without advancing sync cursors", async () => {
    const store = await MirrorStore.open("account-upload", new IDBFactory());
    const gallery = {
      file: "gallery-upload.sp", version: 1, headers: "a*b", dateCreated: 20, dateModified: 21,
      isLocal: false, isRemote: true, reupload: false,
    };
    const album = {
      ...gallery, file: "album-upload.sp", albumId: "album",
    };
    await store.putUploadedFile(gallery);
    await store.putUploadedFile(album);
    expect((await store.listFiles("files")).map((file) => file.file)).toEqual(["gallery-upload.sp"]);
    expect((await store.listAlbumFiles("album")).map((file) => file.file)).toEqual(["album-upload.sp"]);
    expect(await store.getCursors()).toEqual(ZERO_CURSORS);
    await store.removeFile("files", gallery.file);
    await store.removeFile("albumFiles", album.file, album.albumId);
    expect(await store.listFiles("files")).toEqual([]);
    expect(await store.listAlbumFiles("album")).toEqual([]);
    store.close();
  });

  test("persists encrypted thumbnails across reopen and rejects stale cache entries", async () => {
    const factory = new IDBFactory();
    const file = {
      file: "cached.sp", version: 1, headers: "file-header*thumb-header", dateCreated: 20, dateModified: 21,
      isLocal: false, isRemote: true, reupload: false,
    };
    let store = await MirrorStore.open("account-thumbnail-cache", factory);
    const encrypted = new Uint8Array([0x53, 0x50, 1, 9, 8, 7]);
    await store.putEncryptedThumbnail("gallery:cached.sp", file, encrypted);
    encrypted.fill(0);
    expect(await store.getEncryptedThumbnail("gallery:cached.sp", file)).toEqual(
      new Uint8Array([0x53, 0x50, 1, 9, 8, 7]),
    );
    store.close();

    store = await MirrorStore.open("account-thumbnail-cache", factory);
    expect(await store.getEncryptedThumbnail("gallery:cached.sp", file)).toEqual(
      new Uint8Array([0x53, 0x50, 1, 9, 8, 7]),
    );
    expect(await store.getEncryptedThumbnail("gallery:cached.sp", { ...file, headers: "updated*headers" }))
      .toBeUndefined();
    expect(await store.getEncryptedThumbnail("gallery:cached.sp", { ...file, version: 2 }))
      .toBeUndefined();
    await store.removeEncryptedThumbnail("gallery:cached.sp");
    expect(await store.getEncryptedThumbnail("gallery:cached.sp", file)).toBeUndefined();
    store.close();
  });

  test("adds the encrypted thumbnail cache when upgrading an existing mirror", async () => {
    const factory = new IDBFactory();
    await createVersionOneMirror(factory, "account-upgrade");
    const store = await MirrorStore.open("account-upgrade", factory, IDBKeyRange);
    const file = {
      file: "upgrade.sp", version: 1, headers: "a*b", dateCreated: 1, dateModified: 2,
      isLocal: false, isRemote: true, reupload: false,
    };
    await store.putUploadedFile(file);
    await store.putUploadedFile({ ...file, file: "album-upgrade.sp", albumId: "album" });
    await store.putEncryptedThumbnail("gallery:upgrade.sp", file, new Uint8Array([0x53, 0x50, 1]));
    expect((await store.listFiles("files"))[0]?.file).toBe("upgrade.sp");
    expect((await store.listAlbumFiles("album"))[0]?.file).toBe("album-upgrade.sp");
    expect(await store.getEncryptedThumbnail("gallery:upgrade.sp", file)).toEqual(new Uint8Array([0x53, 0x50, 1]));
    store.close();
  });
});
