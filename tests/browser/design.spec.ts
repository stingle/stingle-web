import { expect, test } from "@playwright/test";

test("uses the Stingle desktop palette and a compact authentication screen", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "one browser is sufficient for the CSS regression gate");

  await page.goto("/");

  await expect(page.locator(".auth-logo img")).toBeVisible();
  await expect(page.getByText("Your photos. Only yours.")).toHaveCount(0);
  await expect(page.getByText("Encryption happens on this device")).toHaveCount(0);

  const palette = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const primary = getComputedStyle(document.querySelector<HTMLButtonElement>("button.primary")!);
    return { background: body.backgroundColor, primary: primary.backgroundColor };
  });
  expect(palette).toEqual({ background: "rgb(21, 22, 26)", primary: "rgb(226, 59, 59)" });
});

test("keeps the authentication card inside a phone-sized viewport", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "one browser is sufficient for the responsive CSS gate");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();

  const bounds = await page.locator(".auth-card").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
