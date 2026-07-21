import { expect, test } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import { ApiClient } from "../../src/api/client";
import { VaultCore } from "../../src/auth/vault-core";
import { MirrorStore } from "../../src/sync/mirror-store";
import { ZERO_CURSORS } from "../../src/sync/model";
import { expectedEncryptedSize } from "../../src/crypto/file";

const email = process.env.STINGLE_TEST_EMAIL;
const password = process.env.STINGLE_TEST_PASSWORD;
const origin = process.env.STINGLE_TEST_API_URL ?? "https://api.stingle.org";

test.skipIf(!email || !password)("logs in and logs out against an explicitly configured server", async () => {
  const api = new ApiClient({ baseUrl: `${origin.replace(/\/$/u, "")}/v2/` });
  const vault = new VaultCore();
  const salt = await api.preLogin(email!);
  const hash = await vault.deriveLoginHash(password!, salt);
  const result = await api.login(email!, hash);
  try {
    await vault.unlockSession(password!, result.keyBundle, result.serverPublicKey);
    expect(result.token).not.toBe("");
    expect(result.userId).not.toBe("");
    const updates = await api.getUpdates(result.token, { ...ZERO_CURSORS });
    expect(Array.isArray(updates.files)).toBe(true);
    expect(Array.isArray(updates.albums)).toBe(true);
    expect(Array.isArray(updates.deletes)).toBe(true);
    const decrypted = await vault.decryptLibrary(
      updates.albums.map((album) => ({
        albumId: album.albumId,
        publicKey: album.publicKey,
        encPrivateKey: album.encPrivateKey,
        metadata: album.metadata,
      })),
      [
        ...updates.files.map((file) => ({ id: `gallery:${file.file}`, headers: file.headers })),
        ...updates.trash.map((file) => ({ id: `trash:${file.file}`, headers: file.headers })),
        ...updates.albumFiles.map((file) => ({ id: `album:${file.albumId}:${file.file}`, albumId: file.albumId, headers: file.headers })),
      ],
    );
    expect(decrypted.albums).toHaveLength(updates.albums.length);
    expect(decrypted.files).toHaveLength(updates.files.length + updates.trash.length + updates.albumFiles.length);
    expect(decrypted.albums.filter((album) => album.error)).toHaveLength(0);
    expect(decrypted.files.filter((file) => file.error)).toHaveLength(0);

    const sample = updates.files[0]
      ? { file: updates.files[0], set: 0, album: undefined }
      : updates.trash[0]
        ? { file: updates.trash[0], set: 1, album: undefined }
        : updates.albumFiles[0]
          ? {
              file: updates.albumFiles[0],
              set: 2,
              album: updates.albums.find((album) => album.albumId === updates.albumFiles[0]?.albumId),
            }
          : undefined;
    if (sample) {
      const encryptedThumb = await api.downloadEncrypted(result.token, sample.file.file, sample.set, true);
      const album = sample.album ? {
        albumId: sample.album.albumId,
        publicKey: sample.album.publicKey,
        encPrivateKey: sample.album.encPrivateKey,
        metadata: sample.album.metadata,
      } : undefined;
      const thumb = await vault.decryptFileBlob(encryptedThumb, sample.file.headers, true, album);
      expect(thumb.byteLength).toBeGreaterThan(0);

      const signedUrl = await api.getDownloadUrl(result.token, sample.file.file, sample.set);
      const range = await fetch(signedUrl, {
        headers: { Range: "bytes=0-38", Origin: "http://localhost:8080" },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-range")).toMatch(/^bytes 0-38\//u);
      expect(range.headers.get("access-control-allow-origin")).toMatch(/^(\*|http:\/\/localhost:8080)$/u);
      const prefix = new Uint8Array(await range.arrayBuffer());
      expect(prefix.slice(0, 3)).toEqual(new Uint8Array([0x53, 0x50, 1]));
      const openedHeader = await vault.openMediaHeader(sample.file.headers, false, album);
      const total = /\/(\d+)$/u.exec(range.headers.get("content-range") ?? "")?.[1];
      expect(total).toBe(expectedEncryptedSize(openedHeader, openedHeader.byteLength).toString());
      openedHeader.symmetricKey.fill(0);
    }

    // Keep the live account strictly read-only. fake-indexeddb exercises the
    // exact browser storage code in process memory and disappears after exit.
    const factory = new IDBFactory();
    let mirror = await MirrorStore.open("live-read-only-validation", factory);
    const first = await mirror.applyUpdates(updates);
    const firstCursors = await mirror.getCursors();
    const firstStats = await mirror.getStats();
    expect(first.files).toBe(firstStats.files);
    expect(first.albums).toBe(firstStats.albums);
    mirror.close();

    mirror = await MirrorStore.open("live-read-only-validation", factory);
    expect(await mirror.getCursors()).toEqual(firstCursors);
    expect(await mirror.getStats()).toEqual(firstStats);

    const incremental = await api.getUpdates(result.token, firstCursors);
    await mirror.applyUpdates(incremental);
    const nextCursors = await mirror.getCursors();
    for (const key of Object.keys(firstCursors) as (keyof typeof firstCursors)[]) {
      expect(nextCursors[key]).toBeGreaterThanOrEqual(firstCursors[key]);
    }
    mirror.close();
  } finally {
    await api.logout(result.token).catch(() => undefined);
    await vault.clear();
  }
});
