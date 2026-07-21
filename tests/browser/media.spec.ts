import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/media-test.html");
  await expect(page.locator("html")).toHaveAttribute("data-crypto-ready", "true", { timeout: 30_000 });
});

test("service worker returns authenticated plaintext byte ranges", async ({ page }) => {
  expect(await page.evaluate(() => window.mediaTest.rangeRoundTrip())).toBe(true);
});

test("native video element plays and seeks through encrypted ranges", async ({ page, browserName }) => {
  test.fail(
    browserName === "webkit",
    "Playwright's Windows WebKit media pipeline cancels its valid synthetic 206 response; native Safari must be validated separately",
  );
  const result = await page.evaluate(() => window.mediaTest.nativeVideoPlaybackProbe());
  expect(result.mimeType, browserName).toMatch(/^video\/(webm|mp4)/u);
  expect(result.duration).toBeGreaterThan(0);
  expect(result.played).toBe(true);
  expect(result.seeked).toBe(true);
  expect(result.transport).toBe(
    browserName === "webkit" ? "decrypted-blob-fallback" : "service-worker-range",
  );
});
