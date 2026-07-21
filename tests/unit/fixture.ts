import { readFileSync } from "node:fs";

export interface FileFixture {
  plaintextBase64: string;
  blobBase64: string;
  outerHeaderBase64Url: string;
  fileIdBase64Url: string;
  filename: string;
  fileType: number;
  videoDuration: number;
}

export interface DesktopFixture {
  source: string;
  password: string;
  accountSaltHex: string;
  loginHashHex: string;
  userPublicKeyBase64: string;
  userPrivateKeyBase64: string;
  keyBundleBase64: string;
  mnemonic: string;
  galleryFile: FileFixture;
  album: {
    name: string;
    publicKeyBase64: string;
    privateKeyBase64: string;
    encryptedPrivateKeyBase64: string;
    metadataBase64: string;
    file: FileFixture;
  };
  params: {
    json: string;
    encryptedBase64: string;
    serverPublicKeyBase64: string;
    serverPrivateKeyBase64: string;
  };
}

export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/desktop-v1.json", import.meta.url), "utf8"),
) as DesktopFixture;
