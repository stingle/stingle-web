/// <reference lib="webworker" />

import { VaultCore } from "./vault-core";
import type { VaultReply, VaultRequest, VaultResult } from "./vault-protocol";

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const vault = new VaultCore();

scope.addEventListener("message", (event: MessageEvent<VaultRequest>) => {
  const { id, operation } = event.data;
  void (async (): Promise<VaultResult> => {
    switch (operation.type) {
      case "derive-login-hash":
        return vault.deriveLoginHash(operation.password, operation.accountSaltHex);
      case "prepare-registration":
        return vault.prepareRegistration(operation.password);
      case "unlock-session":
        await vault.unlockSession(
          operation.password,
          operation.keyBundleBase64,
          operation.serverPublicKeyBase64,
        );
        return undefined;
      case "encrypt-params":
        return vault.encryptParams(operation.params);
      case "decrypt-library":
        return vault.decryptLibrary(operation.albums, operation.files);
      case "open-media-header":
        return vault.openMediaHeader(operation.headers, operation.isThumb, operation.album);
      case "decrypt-file-blob":
        return vault.decryptFileBlob(
          operation.encryptedBlob,
          operation.headers,
          operation.isThumb,
          operation.album,
        );
      case "create-album":
        return vault.createAlbum(operation.name, operation.timestamp);
      case "reseal-file-headers":
        return vault.resealFileHeaders(operation.headers, operation.sourceAlbum, operation.targetAlbum);
      case "prepare-upload":
        return vault.prepareUpload(operation.original, operation.thumbnail, operation.filename, operation.fileType, operation.videoDuration, operation.album);
      case "persist-session":
        await vault.persistSession(operation.session);
        return undefined;
      case "restore-session":
        return vault.restoreSession();
      case "clear":
        await vault.clear();
        return undefined;
    }
  })()
    .then((result) => {
      const reply: VaultReply = { id, ok: true, result };
      if (result && typeof result === "object" && "encryptedFile" in result && "encryptedThumb" in result) {
        scope.postMessage(reply, [result.encryptedFile.buffer, result.encryptedThumb.buffer]);
      } else {
        scope.postMessage(reply);
      }
    })
    .catch((error: unknown) => {
      const reply: VaultReply = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : "Crypto worker failed.",
      };
      scope.postMessage(reply);
    });
});
