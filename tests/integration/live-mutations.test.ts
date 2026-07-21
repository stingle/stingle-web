import { expect, test } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import { ApiClient } from "../../src/api/client";
import { AuthService } from "../../src/auth/auth-service";
import { VaultCore, type PreparedAlbum } from "../../src/auth/vault-core";
import { MirrorStore } from "../../src/sync/mirror-store";
import { SyncEngine } from "../../src/sync/sync-engine";

const email = process.env.STINGLE_TEST_EMAIL;
const password = process.env.STINGLE_TEST_PASSWORD;
const origin = process.env.STINGLE_TEST_API_URL ?? "https://api.stingle.org";
const enabled = process.env.STINGLE_RUN_LIVE_MUTATIONS === "1";

test.skipIf(!email || !password || !enabled)("copies a real item into a temporary encrypted album and cleans it up", async () => {
  const api = new ApiClient({ baseUrl: `${origin.replace(/\/$/u, "")}/v2/` });
  const vault = new VaultCore();
  const auth = new AuthService(api, vault);
  const store = await MirrorStore.open(`live-mutation-${Date.now()}`, new IDBFactory());
  const engine = new SyncEngine(auth, store);
  let temporaryAlbum: PreparedAlbum | undefined;
  let cleanupError: unknown;
  try {
    await auth.login(email!, password!);
    await engine.syncOnce();
    const source = (await store.listFiles("files")).find((file) => file.isRemote && file.headers.split("*").length === 2);
    expect(source, "authorized test account needs one gallery item with original and thumbnail headers").toBeDefined();
    const sourceMetadata = await auth.decryptLibrary([], [{ id: "source", headers: source!.headers }]);
    expect(sourceMetadata.files[0]?.error).not.toBe(true);

    temporaryAlbum = await auth.createAlbum(`Phase 4 validation ${Date.now()}`);
    await auth.moveFiles({
      files: [{ file: source!.file, headers: source!.headers, isRemote: true }],
      setFrom: 0,
      setTo: 2,
      targetAlbum: temporaryAlbum,
      isMoving: false,
    });

    let copied = false;
    for (let attempt = 0; attempt < 5 && !copied; attempt += 1) {
      await engine.syncOnce();
      copied = (await store.listAlbumFiles(temporaryAlbum.albumId)).some((file) => file.file === source!.file);
      if (!copied) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(copied).toBe(true);
    const albumFile = (await store.listAlbumFiles(temporaryAlbum.albumId)).find((file) => file.file === source!.file)!;
    const copiedMetadata = await auth.decryptLibrary(
      [temporaryAlbum],
      [{ id: "copy", albumId: temporaryAlbum.albumId, headers: albumFile.headers }],
    );
    expect(copiedMetadata.files[0]?.filename).toBe(sourceMetadata.files[0]?.filename);
  } finally {
    if (temporaryAlbum && auth.currentSession) {
      try {
        await auth.deleteAlbum(temporaryAlbum.albumId);
      } catch (error) {
        cleanupError = error;
      }
    }
    store.close();
    await auth.logout().catch(() => vault.clear());
    if (cleanupError) throw cleanupError;
  }
});
