import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { fromBase64, toBase64Url } from "../../src/crypto/encoding";
import { encryptFileBytes } from "../../src/crypto/file";

interface Fixture {
  password: string;
  accountSaltHex: string;
  loginHashHex: string;
  keyBundleBase64: string;
  userPublicKeyBase64: string;
  galleryFile: { blobBase64: string; outerHeaderBase64Url: string; filename: string };
  album: {
    name: string;
    publicKeyBase64: string;
    encryptedPrivateKeyBase64: string;
    metadataBase64: string;
  };
  params: { serverPublicKeyBase64: string };
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/desktop-v1.json", import.meta.url), "utf8"),
) as Fixture;

function envelope(parts: Record<string, unknown> = {}): string {
  return JSON.stringify({ status: "ok", infos: [], errors: [], parts });
}

test("decrypts a synced item, loads its thumbnail, and opens a media session", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "library media wiring is covered once; range playback has its own cross-browser suite");
  const encryptedBlob = Buffer.from(fixture.galleryFile.blobBase64, "base64");
  let originalDownloads = 0;
  let thumbnailDownloads = 0;
  let storageRangeRequests = 0;
  await page.route("https://storage.example/**", async (route) => {
    storageRangeRequests += 1;
    const match = /^bytes=(\d+)-(\d+)$/u.exec(route.request().headers().range ?? "");
    if (!match) return route.fulfill({ status: 416 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    return route.fulfill({
      status: 206,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${encryptedBlob.byteLength}`,
        "Content-Type": "application/octet-stream",
      },
      body: encryptedBlob.subarray(start, end + 1),
    });
  });
  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "library-token", userId: "library-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1",
      homeFolder: `library-${Date.now()}`, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) return route.fulfill({ contentType: "application/json", body: envelope({
      files: [{
        file: "fixture.sp", version: 1,
        headers: `${fixture.galleryFile.outerHeaderBase64Url}*${fixture.galleryFile.outerHeaderBase64Url}`,
        dateCreated: 1_700_000_000_000, dateModified: 1_700_000_000_001,
      }],
      trash: [], albums: [], albumFiles: [], contacts: [], deletes: [],
    }) });
    if (path.endsWith("/sync/getUrl")) return route.fulfill({ contentType: "application/json", body: envelope({ url: "https://storage.example/fixture.sp?signature=test" }) });
    if (path.endsWith("/sync/download")) {
      if (new URLSearchParams(route.request().postData() ?? "").has("thumb")) thumbnailDownloads += 1;
      else originalDownloads += 1;
      return route.fulfill({ contentType: "application/octet-stream", body: encryptedBlob });
    }
    if (path.endsWith("/login/logout")) return route.fulfill({ contentType: "application/json", body: envelope() });
    return route.abort("failed");
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("library@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const item = page.getByRole("button", { name: new RegExp(fixture.galleryFile.filename, "u") });
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.click();
  await expect(page.getByRole("dialog", { name: fixture.galleryFile.filename })).toBeVisible();
  await expect(page.getByRole("dialog").locator("video")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toHaveAttribute("data-media-transport", "memory");
  // Playwright page routes do not observe cross-origin fetches issued by a
  // service worker. That makes the registration probe fail in this synthetic
  // setup and intentionally exercises the full-download compatibility path.
  // Direct encrypted ranges are covered by the HttpRangeSource unit suite and
  // the authorized live Range/CORS probe.
  expect({ originalDownloads, storageRangeRequests }).toEqual({ originalDownloads: 1, storageRangeRequests: 0 });
  await page.getByRole("button", { name: "Close viewer" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(thumbnailDownloads).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(fixture.galleryFile.filename, "u") })
    .locator(".file-preview.loaded")).toBeVisible({ timeout: 60_000 });
  expect(thumbnailDownloads).toBe(1);
});

test("shows the cached scaled photo while its original downloads", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "photo viewer wiring needs one browser gate");
  const image = new Uint8Array(readFileSync(new URL("../../src/assets/stingle-logo.png", import.meta.url)));
  const publicKey = await fromBase64(fixture.userPublicKeyBase64);
  const original = await encryptFileBytes(image, { filename: "stingle-logo.png", fileType: 2, recipientPublicKey: publicKey });
  const thumbnail = await encryptFileBytes(image, {
    filename: "stingle-logo.png",
    fileType: 2,
    recipientPublicKey: publicKey,
    fileId: original.header.fileId,
  });
  const headers = `${await toBase64Url(original.outerHeader)}*${await toBase64Url(thumbnail.outerHeader)}`;
  let originalRequested = false;
  let releaseOriginal!: () => void;
  const originalGate = new Promise<void>((resolve) => { releaseOriginal = resolve; });
  let releaseNeighborThumbnail!: () => void;
  const neighborThumbnailGate = new Promise<void>((resolve) => { releaseNeighborThumbnail = resolve; });

  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fields = new URLSearchParams(route.request().postData() ?? "");
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "photo-viewer-token", userId: "photo-viewer-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1",
      homeFolder: `photo-viewer-${Date.now()}`, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) return route.fulfill({ contentType: "application/json", body: envelope({
      files: Array.from({ length: 3 }, (_, index) => ({ file: `photo-${index}.sp`, version: 1, headers, dateCreated: 1_700_000_000_000 + index, dateModified: 1_700_000_000_001 + index })),
      trash: [], albums: [], albumFiles: [], contacts: [], deletes: [],
    }) });
    if (path.endsWith("/sync/download")) {
      if (fields.get("thumb") === "1") {
        if (fields.get("file") === "photo-1.sp") await neighborThumbnailGate;
        return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(thumbnail.blob) });
      }
      originalRequested = true;
      await originalGate;
      return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(original.blob) });
    }
    return route.fulfill({ contentType: "application/json", body: envelope() });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("photo-viewer@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".file-tile strong, .file-tile small")).toHaveCount(0);
  const item = page.getByRole("button", { name: /stingle-logo\.png/u }).first();
  await expect(item.locator(".file-preview.loaded")).toBeVisible({ timeout: 60_000 });
  await item.click();
  const dialog = page.getByRole("dialog", { name: "stingle-logo.png" });
  const viewerImage = dialog.locator(".zoom-stage img").first();
  await expect(viewerImage).toBeVisible();
  await expect(dialog.getByRole("status", { name: "Loading full-resolution photo" })).toBeVisible();
  expect(originalRequested).toBe(true);
  releaseOriginal();
  await expect(dialog.getByRole("status", { name: "Loading full-resolution photo" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Share/u })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Save/u })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Move/u })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Delete/u })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /Save/u }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("stingle-logo.png");
  await expect(dialog.getByText("1 / 3", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Previous item" })).toHaveCount(0);
  const firstFit = await dialog.locator(".zoom-inner").boundingBox();
  await dialog.getByRole("button", { name: "Next item" }).click();
  await expect(dialog.getByText("2 / 3", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("status", { name: "Loading full-resolution photo" })).toHaveCount(0);
  releaseNeighborThumbnail();
  await expect(dialog.locator(".zoom-preview")).toBeVisible();
  const nextFit = await dialog.locator(".zoom-inner").boundingBox();
  expect(nextFit?.width).toBeCloseTo(firstFit?.width ?? 0, 0);
  expect(nextFit?.height).toBeCloseTo(firstFit?.height ?? 0, 0);
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByText("3 / 3", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByText("2 / 3", { exact: true })).toBeVisible();
  const zoomStage = dialog.locator(".zoom-stage");
  await zoomStage.dispatchEvent("wheel", { deltaY: -120 });
  await expect(zoomStage).not.toHaveAttribute("data-zoom", "1.00");
  await dialog.click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  await item.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "stingle-logo.png" })).toHaveCount(0);
});

test("keeps a 32-request thumbnail pool fed until the queue is empty", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "thumbnail scheduling needs one browser gate");
  const encryptedBlob = Buffer.from(fixture.galleryFile.blobBase64, "base64");
  let thumbnailDownloads = 0;
  let activeThumbnailDownloads = 0;
  let peakThumbnailDownloads = 0;
  const homeFolder = `thumbnails-${Date.now()}`;
  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fields = new URLSearchParams(route.request().postData() ?? "");
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "thumbnail-token", userId: "thumbnail-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1", homeFolder, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) return route.fulfill({ contentType: "application/json", body: envelope({
      files: Array.from({ length: 70 }, (_, index) => ({
        file: `fixture-${index}.sp`, version: 1,
        headers: `${fixture.galleryFile.outerHeaderBase64Url}*${fixture.galleryFile.outerHeaderBase64Url}`,
        dateCreated: 1_700_000_000_000 + index, dateModified: 1_700_000_000_001 + index,
      })),
      trash: [], albums: [], albumFiles: [], contacts: [], deletes: [],
    }) });
    if (path.endsWith("/sync/download")) {
      if (fields.get("thumb") === "1") {
        thumbnailDownloads += 1;
        activeThumbnailDownloads += 1;
        peakThumbnailDownloads = Math.max(peakThumbnailDownloads, activeThumbnailDownloads);
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        activeThumbnailDownloads -= 1;
      }
      return route.fulfill({ contentType: "application/octet-stream", body: encryptedBlob });
    }
    return route.fulfill({ contentType: "application/json", body: envelope() });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("thumbnails@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".file-tile")).toHaveCount(70, { timeout: 60_000 });
  await expect.poll(() => thumbnailDownloads, { timeout: 30_000 }).toBe(70);
  await expect(page.locator(".file-preview.loaded")).toHaveCount(70);
  expect(peakThumbnailDownloads).toBe(32);
});

test("prioritizes an opened album ahead of pending gallery thumbnails", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "thumbnail scheduling needs one browser gate");
  const galleryThumbnail = Buffer.from(fixture.galleryFile.blobBase64, "base64");
  const image = new Uint8Array(readFileSync(new URL("../../src/assets/stingle-logo.png", import.meta.url)));
  const albumPublicKey = await fromBase64(fixture.album.publicKeyBase64);
  const albumOriginal = await encryptFileBytes(image, {
    filename: "priority.png", fileType: 2, recipientPublicKey: albumPublicKey,
  });
  const albumThumbnail = await encryptFileBytes(image, {
    filename: "priority.png", fileType: 2, recipientPublicKey: albumPublicKey,
    fileId: albumOriginal.header.fileId,
  });
  const albumHeaders = `${await toBase64Url(albumOriginal.outerHeader)}*${await toBase64Url(albumThumbnail.outerHeader)}`;
  let activeGallery = 0;
  let releaseGallery!: () => void;
  const galleryGate = new Promise<void>((resolve) => { releaseGallery = resolve; });
  const downloadsAfterRelease: string[] = [];
  let released = false;

  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fields = new URLSearchParams(route.request().postData() ?? "");
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "priority-token", userId: "priority-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1",
      homeFolder: `priority-${Date.now()}`, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) return route.fulfill({ contentType: "application/json", body: envelope({
      files: Array.from({ length: 40 }, (_, index) => ({
        file: `gallery-${index}.sp`, version: 1,
        headers: `${fixture.galleryFile.outerHeaderBase64Url}*${fixture.galleryFile.outerHeaderBase64Url}`,
        dateCreated: 1_700_000_000_000 + index, dateModified: 1_700_000_000_001 + index,
      })),
      trash: [],
      albums: [{
        albumId: "priority-album", encPrivateKey: fixture.album.encryptedPrivateKeyBase64,
        publicKey: fixture.album.publicKeyBase64, metadata: fixture.album.metadataBase64,
        isShared: false, isHidden: false, isOwner: true, members: "", permissions: "111",
        isLocked: false, cover: "", dateCreated: 1_700_000_000_000, dateModified: 1_700_000_000_001,
      }],
      albumFiles: Array.from({ length: 2 }, (_, index) => ({
        file: `album-priority-${index}.sp`, albumId: "priority-album", version: 1, headers: albumHeaders,
        dateCreated: 1_700_000_000_100 + index, dateModified: 1_700_000_000_101 + index,
      })),
      contacts: [], deletes: [],
    }) });
    if (path.endsWith("/sync/download") && fields.get("thumb") === "1") {
      const file = fields.get("file") ?? "";
      if (released) downloadsAfterRelease.push(file);
      if (file.startsWith("gallery-")) {
        activeGallery += 1;
        await galleryGate;
        activeGallery -= 1;
        return route.fulfill({ contentType: "application/octet-stream", body: galleryThumbnail }).catch(() => undefined);
      }
      return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(albumThumbnail.blob) });
    }
    return route.fulfill({ contentType: "application/json", body: envelope() });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("priority@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect.poll(() => activeGallery, { timeout: 60_000 }).toBe(32);
  released = true;
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await page.locator(".album-tile").click();
  await expect(page.getByRole("heading", { name: fixture.album.name })).toBeVisible();
  await expect(page.locator(".file-preview.loaded")).toHaveCount(2, { timeout: 60_000 });
  expect(downloadsAfterRelease.slice(0, 4)).toEqual(expect.arrayContaining([
    "album-priority-0.sp", "album-priority-1.sp",
  ]));
  releaseGallery();
  await expect.poll(() => activeGallery).toBe(0);
});

test("windows a huge gallery and prioritizes thumbnails after a deep scroll jump", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "large-library windowing needs one browser gate");
  const encryptedThumbnail = Buffer.from(fixture.galleryFile.blobBase64, "base64");
  const fileCount = 2_500;
  let activeInitialDownloads = 0;
  let releaseInitialDownloads!: () => void;
  const initialGate = new Promise<void>((resolve) => { releaseInitialDownloads = resolve; });
  let scrolled = false;
  const downloadsAfterScroll: string[] = [];

  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fields = new URLSearchParams(route.request().postData() ?? "");
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "huge-gallery-token", userId: "huge-gallery-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1",
      homeFolder: `huge-gallery-${Date.now()}`, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) return route.fulfill({ contentType: "application/json", body: envelope({
      files: Array.from({ length: fileCount }, (_, index) => ({
        file: `huge-${index}.sp`, version: 1,
        headers: `${fixture.galleryFile.outerHeaderBase64Url}*${fixture.galleryFile.outerHeaderBase64Url}`,
        dateCreated: Date.UTC(2010, 0, 1) + index * 86_400_000,
        dateModified: 1_700_000_000_000 + index,
      })),
      trash: [], albums: [], albumFiles: [], contacts: [], deletes: [],
    }) });
    if (path.endsWith("/sync/download") && fields.get("thumb") === "1") {
      const file = fields.get("file") ?? "";
      if (!scrolled) {
        activeInitialDownloads += 1;
        await initialGate;
        activeInitialDownloads -= 1;
      } else {
        downloadsAfterScroll.push(file);
      }
      return route.fulfill({ contentType: "application/octet-stream", body: encryptedThumbnail }).catch(() => undefined);
    }
    return route.fulfill({ contentType: "application/json", body: envelope() });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("huge-gallery@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const virtualWindow = page.locator(".virtual-file-window");
  await expect(virtualWindow).toHaveAttribute("data-total-count", String(fileCount), { timeout: 60_000 });
  await expect(page.getByText(`${fileCount} items`, { exact: true })).toBeVisible();
  expect(await page.locator(".file-tile").count()).toBeLessThan(200);
  await expect.poll(() => activeInitialDownloads, { timeout: 60_000 }).toBeGreaterThan(0);

  scrolled = true;
  const scrollMetrics = await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    return {
      body: document.body.scrollHeight,
      document: document.documentElement.scrollHeight,
      y: window.scrollY,
      grid: document.querySelector<HTMLElement>(".virtual-file-window")?.offsetHeight ?? -1,
    };
  });
  expect(scrollMetrics.y, JSON.stringify(scrollMetrics)).toBeGreaterThan(2_000);
  await page.waitForTimeout(200);
  const settledMetrics = await page.evaluate(() => ({
    y: window.scrollY,
    body: document.body.scrollHeight,
    grid: document.querySelector<HTMLElement>(".virtual-file-window")?.offsetHeight ?? -1,
    start: document.querySelector<HTMLElement>(".virtual-file-window")?.dataset.visibleStart ?? "missing",
    top: document.querySelector<HTMLElement>(".virtual-file-window")?.getBoundingClientRect().top ?? -1,
  }));
  expect(Number(settledMetrics.start), JSON.stringify(settledMetrics)).toBeGreaterThan(2_000);
  await expect.poll(async () => Number(await virtualWindow.getAttribute("data-visible-start")), { timeout: 30_000 })
    .toBeGreaterThan(2_000);
  await expect.poll(async () => Number(await page.locator(".file-tile[data-file-index]").first().getAttribute("data-file-index")))
    .toBeGreaterThan(2_000);
  const sectionLabels = await page.locator(".virtual-date-section").allTextContents();
  expect(new Set(sectionLabels).size).toBeGreaterThan(1);
  const bottomPosition = await page.evaluate(() => window.scrollY);
  await page.waitForTimeout(400);
  expect(Math.abs(await page.evaluate(() => window.scrollY) - bottomPosition)).toBeLessThan(2);
  await page.evaluate(() => window.scrollBy(0, -600));
  const raisedPosition = await page.evaluate(() => window.scrollY);
  expect(raisedPosition).toBeLessThan(bottomPosition);
  expect(raisedPosition).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  expect(Math.abs(await page.evaluate(() => window.scrollY) - raisedPosition)).toBeLessThan(2);

  const previousStart = Number(await virtualWindow.getAttribute("data-visible-start"));
  const retainedIndex = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll<HTMLElement>(".file-tile[data-file-index]")];
    const tile = tiles[Math.floor(tiles.length / 2)];
    if (!tile) throw new Error("expected a rendered file tile");
    (window as Window & { __retainedVirtualTile?: HTMLElement }).__retainedVirtualTile = tile;
    return Number(tile.dataset.fileIndex);
  });
  await page.evaluate(() => window.scrollBy(0, -200));
  await expect.poll(async () => Number(await virtualWindow.getAttribute("data-visible-start"))).toBeLessThan(previousStart);
  expect(await page.evaluate((index) => {
    const retained = (window as Window & { __retainedVirtualTile?: HTMLElement }).__retainedVirtualTile;
    return retained?.isConnected === true &&
      retained === document.querySelector(`.file-tile[data-file-index="${index}"]`);
  }, retainedIndex)).toBe(true);

  await expect.poll(() => downloadsAfterScroll.length, { timeout: 60_000 }).toBeGreaterThan(5);
  expect(downloadsAfterScroll.slice(0, 5).every((file) => Number(/huge-(\d+)\.sp/u.exec(file)?.[1]) < 500)).toBe(true);
  releaseInitialDownloads();
  await expect.poll(() => activeInitialDownloads).toBe(0);
});

test("renders album covers and sends encrypted item or blank cover mutations", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "album cover UI and worker encryption need one browser gate");
  const image = new Uint8Array(readFileSync(new URL("../../src/assets/stingle-logo.png", import.meta.url)));
  const albumPublicKey = await fromBase64(fixture.album.publicKeyBase64);
  const original = await encryptFileBytes(image, { filename: "album-cover.png", fileType: 2, recipientPublicKey: albumPublicKey });
  const thumbnail = await encryptFileBytes(image, {
    filename: "album-cover.png",
    fileType: 2,
    recipientPublicKey: albumPublicKey,
    fileId: original.header.fileId,
  });
  const headers = `${await toBase64Url(original.outerHeader)}*${await toBase64Url(thumbnail.outerHeader)}`;
  const coverMutations: URLSearchParams[] = [];

  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fields = new URLSearchParams(route.request().postData() ?? "");
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "album-cover-token", userId: "album-cover-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1",
      homeFolder: `album-cover-${Date.now()}`, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) return route.fulfill({ contentType: "application/json", body: envelope({
      files: [], trash: [], contacts: [], deletes: [],
      albums: [{
        albumId: "fixture-album", encPrivateKey: fixture.album.encryptedPrivateKeyBase64,
        publicKey: fixture.album.publicKeyBase64, metadata: fixture.album.metadataBase64,
        isShared: 0, isHidden: 0, isOwner: 1, members: "", permissions: "", isLocked: 0,
        cover: "album-cover.sp", dateCreated: 1_700_000_000_000, dateModified: 1_700_000_000_001,
      }, {
        albumId: "blank-album", encPrivateKey: fixture.album.encryptedPrivateKeyBase64,
        publicKey: fixture.album.publicKeyBase64, metadata: fixture.album.metadataBase64,
        isShared: 0, isHidden: 0, isOwner: 1, members: "", permissions: "", isLocked: 0,
        cover: "__b__", dateCreated: 1_699_000_000_000, dateModified: 1_699_000_000_001,
      }, {
        albumId: "default-album", encPrivateKey: fixture.album.encryptedPrivateKeyBase64,
        publicKey: fixture.album.publicKeyBase64, metadata: fixture.album.metadataBase64,
        isShared: 0, isHidden: 0, isOwner: 1, members: "", permissions: "", isLocked: 0,
        cover: "", dateCreated: 1_698_000_000_000, dateModified: 1_698_000_000_001,
      }],
      albumFiles: [
        { file: "album-cover.sp", albumId: "fixture-album", version: 1, headers, dateCreated: 1_700_000_000_000, dateModified: 1_700_000_000_001 },
        { file: "album-second.sp", albumId: "fixture-album", version: 1, headers, dateCreated: 1_699_999_999_999, dateModified: 1_700_000_000_000 },
        { file: "default-first.sp", albumId: "default-album", version: 1, headers, dateCreated: 1_698_000_000_000, dateModified: 1_698_000_000_001 },
      ],
    }) });
    if (path.endsWith("/sync/download")) return route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(fields.get("thumb") === "1" ? thumbnail.blob : original.blob) });
    if (path.endsWith("/sync/changeAlbumCover")) {
      coverMutations.push(fields);
      return route.fulfill({ contentType: "application/json", body: envelope() });
    }
    return route.fulfill({ contentType: "application/json", body: envelope() });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("album-cover@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await expect(page.locator(".album-art.blank")).toBeVisible({ timeout: 60_000 });
  const album = page.locator(".album-tile").filter({ has: page.locator(".album-art img") });
  await expect(album).toHaveCount(2, { timeout: 60_000 });
  await album.first().click();
  await expect(page.getByRole("heading", { name: fixture.album.name })).toBeVisible();
  await expect(page.locator(".file-tile")).toHaveCount(2);
  await page.getByRole("button", { name: "Select items" }).click();
  await page.getByRole("button", { name: "album-cover.png" }).first().click();
  await page.getByRole("button", { name: "Set as cover" }).click();
  await expect.poll(() => coverMutations.length).toBe(1);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Blank cover" }).click();
  await expect.poll(() => coverMutations.length).toBe(2);
  for (const fields of coverMutations) {
    expect([...fields.keys()].sort()).toEqual(["params", "token"]);
    expect(fields.get("token")).toBe("album-cover-token");
    expect(fields.get("params")).not.toContain("album-cover.sp");
    expect(fields.get("params")).not.toContain("__b__");
  }
  await page.getByRole("button", { name: "Select items" }).click();
  await page.getByRole("button", { name: "album-cover.png" }).first().click();
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.locator(".file-tile")).toHaveCount(1);
  await page.getByRole("button", { name: "album-cover.png" }).click();
  const viewer = page.getByRole("dialog", { name: "album-cover.png" });
  await expect(viewer).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await viewer.getByRole("button", { name: /Delete/u }).click();
  await expect(page.locator(".file-tile")).toHaveCount(0);
});

test("prepares, encrypts, uploads, and re-syncs a browser-selected photo", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "upload worker and canvas wiring need one browser gate");
  let uploads = 0;
  let syncs = 0;
  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "upload-token", userId: "upload-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1",
      homeFolder: `uploads-${Date.now()}`, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) {
      syncs += 1;
      return route.fulfill({ contentType: "application/json", body: envelope({ files: [], trash: [], albums: [], albumFiles: [], contacts: [], deletes: [] }) });
    }
    if (path.endsWith("/sync/upload")) {
      uploads += 1;
      const contentType = route.request().headers()["content-type"] ?? "";
      const multipart = route.request().postData() ?? "";
      expect(contentType).toContain("multipart/form-data; boundary=");
      expect(multipart).toContain('name="token"');
      expect(multipart).toContain("upload-token");
      expect(multipart).toContain('name="file"; filename="');
      expect(multipart).toContain('name="thumb"; filename="');
      expect(multipart).toContain("application/stinglephoto");
      expect(multipart).not.toContain("stingle-logo.png");
      return route.fulfill({ contentType: "application/json", body: envelope({ spaceUsed: "1", spaceQuota: "100" }) });
    }
    return route.fulfill({ contentType: "application/json", body: envelope() });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("uploads@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Gallery" })).toBeVisible({ timeout: 60_000 });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fileURLToPath(new URL("../../src/assets/stingle-logo.png", import.meta.url)));
  await expect.poll(() => uploads, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => syncs, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Uploading 1 of 1…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "stingle-logo.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "stingle-logo.png" }).locator(".file-preview.loaded")).toBeVisible();
});

test("shows an album upload and its implicit cover before the update feed returns it", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "album upload reconciliation and worker encryption need one browser gate");
  let uploads = 0;
  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "album-upload-token", userId: "album-upload-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1",
      homeFolder: `album-uploads-${Date.now()}`, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) return route.fulfill({ contentType: "application/json", body: envelope({
      files: [], trash: [], contacts: [], deletes: [], albumFiles: [],
      albums: [{
        albumId: "upload-album", encPrivateKey: fixture.album.encryptedPrivateKeyBase64,
        publicKey: fixture.album.publicKeyBase64, metadata: fixture.album.metadataBase64,
        isShared: 0, isHidden: 0, isOwner: 1, members: "", permissions: "", isLocked: 0,
        cover: "", dateCreated: 1_700_000_000_000, dateModified: 1_700_000_000_001,
      }],
    }) });
    if (path.endsWith("/sync/upload")) {
      uploads += 1;
      return route.fulfill({ contentType: "application/json", body: envelope({ spaceUsed: "1", spaceQuota: "100" }) });
    }
    return route.fulfill({ contentType: "application/json", body: envelope() });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("album-uploads@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await page.locator(".album-tile").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fileURLToPath(new URL("../../src/assets/stingle-logo.png", import.meta.url)));
  await expect.poll(() => uploads, { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole("button", { name: "stingle-logo.png" })).toBeVisible();
  await page.getByRole("button", { name: "stingle-logo.png" }).click();
  await page.getByRole("dialog", { name: "stingle-logo.png" }).getByRole("button", { name: /Move/u }).click();
  await expect(page.getByRole("dialog", { name: "Move item" }).getByRole("button", { name: "Gallery" })).toBeVisible();
  await page.getByRole("dialog", { name: "Move item" }).getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Back to albums" }).click();
  await expect(page.locator(".album-tile .album-art img")).toBeVisible();
});

test("creates an album and sends a selected gallery item to trash with encrypted params", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "mutation UI and worker encryption need one browser gate");
  const encryptedBlob = Buffer.from(fixture.galleryFile.blobBase64, "base64");
  const mutationBodies: Array<{ path: string; fields: URLSearchParams }> = [];
  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fields = new URLSearchParams(route.request().postData() ?? "");
    if (path.endsWith("/login/preLogin")) return route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
    if (path.endsWith("/login/login")) return route.fulfill({ contentType: "application/json", body: envelope({
      token: "mutation-token", userId: "mutation-user", keyBundle: fixture.keyBundleBase64,
      serverPublicKey: fixture.params.serverPublicKeyBase64, isKeyBackedUp: "1",
      homeFolder: `mutations-${Date.now()}`, addons: [],
    }) });
    if (path.endsWith("/sync/getUpdates")) return route.fulfill({ contentType: "application/json", body: envelope({
      files: [{
        file: "fixture.sp", version: 1,
        headers: `${fixture.galleryFile.outerHeaderBase64Url}*${fixture.galleryFile.outerHeaderBase64Url}`,
        dateCreated: 1_700_000_000_000, dateModified: 1_700_000_000_001,
      }],
      trash: [], albums: [], albumFiles: [], contacts: [], deletes: [],
    }) });
    if (path.endsWith("/sync/download")) return route.fulfill({ contentType: "application/octet-stream", body: encryptedBlob });
    if (path.endsWith("/sync/addAlbum") || path.endsWith("/sync/moveFile")) {
      mutationBodies.push({ path, fields });
      return route.fulfill({ contentType: "application/json", body: envelope() });
    }
    if (path.endsWith("/login/logout")) return route.fulfill({ contentType: "application/json", body: envelope() });
    return route.abort("failed");
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("mutations@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(fixture.galleryFile.filename, "u") })).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await page.getByRole("button", { name: "New album" }).click();
  await page.getByLabel("Album name").fill("Web private album");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => mutationBodies.filter((item) => item.path.endsWith("/sync/addAlbum")).length).toBe(1);

  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await page.getByRole("button", { name: "Select items" }).click();
  const item = page.getByRole("button", { name: new RegExp(fixture.galleryFile.filename, "u") });
  await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect.poll(() => mutationBodies.filter((entry) => entry.path.endsWith("/sync/moveFile")).length).toBe(1);

  for (const { fields } of mutationBodies) {
    expect(Object.fromEntries(fields).token).toBe("mutation-token");
    expect(fields.get("params")).toBeTruthy();
    expect(fields.get("params")).not.toContain("fixture.sp");
    expect([...fields.keys()].sort()).toEqual(["params", "token"]);
  }
});
