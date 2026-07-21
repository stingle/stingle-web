import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { ApiClient } from "../../src/api/client";
import { AuthService, type UploadedFileRef } from "../../src/auth/auth-service";
import { VaultCore } from "../../src/auth/vault-core";

const email = process.env.STINGLE_TEST_EMAIL;
const password = process.env.STINGLE_TEST_PASSWORD;
const origin = process.env.STINGLE_TEST_API_URL ?? "https://api.stingle.org";
const enabled = process.env.STINGLE_RUN_LIVE_UPLOAD === "1";
const jpeg = new Uint8Array(readFileSync(new URL("../fixtures/live-upload.jpg", import.meta.url)));

test.skipIf(!email || !password || !enabled)("uploads an interoperable encrypted browser photo and removes it", async () => {
  const api = new ApiClient({ baseUrl: `${origin.replace(/\/$/u, "")}/v2/`, timeoutMs: 120_000 });
  const vault = new VaultCore();
  const auth = new AuthService(api, vault);
  let uploaded: UploadedFileRef | undefined;
  let movedToTrash = false;
  let cleanupError: unknown;
  try {
    await auth.login(email!, password!);
    uploaded = await auth.upload(jpeg.slice(), jpeg.slice(), `Phase 5 validation ${Date.now()}.jpg`, 2, 0, Date.now());
    const updates = await auth.getUpdates({ files: 0, trash: 0, albums: 0, albumFiles: 0, deletes: 0, contacts: 0 });
    const remote = updates.files.find((file) => file.file === uploaded!.file);
    expect(remote).toBeDefined();
    const metadata = await auth.decryptLibrary([], [{ id: "uploaded", headers: remote!.headers }]);
    expect(metadata.files[0]?.filename).toMatch(/^Phase 5 validation \d+\.jpg$/u);
    const encryptedThumb = await auth.downloadEncrypted(uploaded.file, 0, true);
    await expect(auth.decryptFileBlob(encryptedThumb, remote!.headers, true)).resolves.toEqual(jpeg);
  } finally {
    if (uploaded && auth.currentSession) {
      try {
        await auth.moveFiles({
          files: [{ file: uploaded.file, headers: uploaded.headers, isRemote: true }],
          setFrom: 0,
          setTo: 1,
          isMoving: true,
        });
        movedToTrash = true;
        await auth.deleteFiles([{ file: uploaded.file, headers: uploaded.headers, isRemote: true }]);
      } catch (error) {
        cleanupError = error;
      }
    }
    await auth.logout().catch(() => vault.clear());
    if (uploaded && !movedToTrash && !cleanupError) cleanupError = new Error("live upload cleanup did not run");
    if (cleanupError) throw cleanupError;
  }
});
