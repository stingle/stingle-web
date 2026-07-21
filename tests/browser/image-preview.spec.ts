import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const heicFixture = readFileSync(new URL("../fixtures/libheif-example.heic", import.meta.url));
const videoFixture = readFileSync(new URL("../fixtures/media/probe.mp4", import.meta.url));

test("converts a decrypted HEIC original to a displayable JPEG", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the local decoder wiring needs one browser gate");
  await page.route("https://fixture.test/example.heic", (route) => route.fulfill({
    contentType: "image/heic",
    body: heicFixture,
  }));
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite serves this browser-only source module during the test.
    const { browserDisplayBlob } = await import("/src/media/image-preview.ts");
    const source = new Uint8Array(await (await fetch("https://fixture.test/example.heic")).arrayBuffer());
    const converted = await browserDisplayBlob(source, "IMG_0001.HEIC");
    const bitmap = await createImageBitmap(converted);
    const details = { type: converted.type, size: converted.size, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return details;
  });
  expect(result.type).toBe("image/jpeg");
  expect(result.size).toBeGreaterThan(1_000);
  expect(result.width).toBeGreaterThan(0);
  expect(result.height).toBeGreaterThan(0);
});

test("extracts an encrypted-upload thumbnail and duration from a browser video", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "video thumbnail preparation needs one browser gate");
  await page.route("https://fixture.test/probe.mp4", (route) => route.fulfill({
    contentType: "video/mp4",
    body: videoFixture,
  }));
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite serves this browser-only source module during the test.
    const { prepareBrowserMedia } = await import("/src/media/upload-preparation.ts");
    const response = await fetch("https://fixture.test/probe.mp4");
    const bytes = await response.arrayBuffer();
    const prepared = await prepareBrowserMedia(new File([bytes], "probe.mp4", {
      type: "video/mp4",
      lastModified: 123,
    }));
    return {
      fileType: prepared.fileType,
      duration: prepared.videoDuration,
      dateCreated: prepared.dateCreated,
      originalSize: prepared.original.byteLength,
      sourceSize: bytes.byteLength,
      jpegMagic: Array.from(prepared.thumbnail.slice(0, 2)),
      thumbnailSize: prepared.thumbnail.byteLength,
    };
  });
  expect(result).toMatchObject({ fileType: 3, dateCreated: 123, jpegMagic: [0xff, 0xd8] });
  expect(result.duration).toBeGreaterThan(0);
  expect(result.originalSize).toBe(result.sourceSize);
  expect(result.thumbnailSize).toBeGreaterThan(1_000);
});

test("preserves photo aspect ratio in an encrypted-upload preview", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "canvas preview preparation needs one browser gate");
  await page.goto("/");
  const dimensions = await page.evaluate(async () => {
    const source = document.createElement("canvas");
    source.width = 1600;
    source.height = 900;
    const context = source.getContext("2d")!;
    context.fillStyle = "#e23b3b";
    context.fillRect(0, 0, source.width, source.height);
    const sourceBlob = await new Promise<Blob>((resolve) => source.toBlob((blob) => resolve(blob!), "image/png"));
    // @ts-expect-error Vite serves this browser-only source module during the test.
    const { prepareBrowserMedia } = await import("/src/media/upload-preparation.ts");
    const prepared = await prepareBrowserMedia(new File([sourceBlob], "landscape.png", { type: "image/png" }));
    const bitmap = await createImageBitmap(new Blob([prepared.thumbnail], { type: "image/jpeg" }));
    const result = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  });
  expect(dimensions).toEqual({ width: 800, height: 450 });
});
