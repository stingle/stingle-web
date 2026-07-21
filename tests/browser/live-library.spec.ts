import { expect, test } from "@playwright/test";

const email = process.env.STINGLE_TEST_EMAIL;
const password = process.env.STINGLE_TEST_PASSWORD;

test.skip(!email || !password, "requires an explicitly authorized live account");
test.use({ trace: "off" });

test("streams a real encrypted video through the Docker stack", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  test.skip(browserName !== "chromium", "real-Docker integration is covered once; native playback has cross-browser gates");
  try {
    await page.goto("/");
    await page.getByLabel("Email").fill(email!);
    await page.getByLabel("Password", { exact: true }).fill(password!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: email! })).toBeVisible({ timeout: 60_000 });
    const videoTile = page.locator(".file-tile:has(.video-badge)").first();
    await expect(videoTile).toBeVisible({ timeout: 60_000 });
    const signedResponse = page.waitForResponse((response) => response.url().includes("/sync/getUrl"));
    await videoTile.click();
    const signedBody = await (await signedResponse).json() as { parts: { url: string } };
    const browserRange = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, { headers: { Range: "bytes=0-38" }, cache: "no-store", credentials: "omit" });
        return { status: response.status, contentRange: response.headers.get("content-range"), length: (await response.arrayBuffer()).byteLength };
      } catch (error) {
        return { status: 0, contentRange: error instanceof Error ? error.name : "error", length: 0 };
      }
    }, signedBody.parts.url);
    expect(browserRange.status).toBe(206);
    expect(browserRange.contentRange).toMatch(/^bytes 0-38\//u);
    expect(browserRange.length).toBe(39);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAttribute("data-media-transport", "remote-range", { timeout: 30_000 });
    const video = dialog.locator("video");
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  } finally {
    const closeViewer = page.getByRole("button", { name: "Close viewer" });
    if (await closeViewer.isVisible().catch(() => false)) await closeViewer.click();
    const signOut = page.getByRole("button", { name: "Sign out" });
    if (await signOut.isVisible().catch(() => false)) await signOut.click();
  }
});
