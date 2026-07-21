import { describe, expect, test } from "vitest";

import { browserDisplayBlob, imageMimeType, isHeicFilename } from "../../src/media/image-preview";

describe("browser image preparation", () => {
  test("recognizes HEIC and HEIF extensions case-insensitively", () => {
    expect(isHeicFilename("IMG_001.HEIC")).toBe(true);
    expect(isHeicFilename("photo.heif")).toBe(true);
    expect(isHeicFilename("photo.jpg")).toBe(false);
    expect(imageMimeType("photo.HEIC")).toBe("image/heic");
  });

  test("leaves browser-native image bytes unchanged", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const blob = await browserDisplayBlob(bytes, "photo.png");
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
});
