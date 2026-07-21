import "fake-indexeddb/auto";

import { afterEach, describe, expect, test } from "vitest";

import { VaultCore, type PersistedAuthSession } from "../../src/auth/vault-core";

const session: PersistedAuthSession = {
  token: "opaque-token",
  email: "saved@example.test",
  userId: "42",
  homeFolder: "home-folder",
  isKeyBackedUp: true,
  addons: ["one"],
};

afterEach(async () => {
  await new VaultCore().clear();
});

describe("encrypted browser session vault", () => {
  test("restores identity material and session metadata without the password", async () => {
    const first = new VaultCore();
    const prepared = await first.prepareRegistration("correct horse battery staple");
    await first.unlockSession("correct horse battery staple", prepared.keyBundleBase64, prepared.publicKeyBase64);
    await first.persistSession(session);

    const restored = new VaultCore();
    await expect(restored.restoreSession()).resolves.toEqual(session);
    await expect(restored.encryptParams({ proof: true })).resolves.toEqual(expect.any(String));
    await restored.clear();
    await expect(new VaultCore().restoreSession()).resolves.toBeUndefined();
  }, 30_000);
});
