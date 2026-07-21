import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

interface Fixture {
  password: string;
  accountSaltHex: string;
  loginHashHex: string;
  keyBundleBase64: string;
  params: { serverPublicKeyBase64: string };
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/desktop-v1.json", import.meta.url), "utf8"),
) as Fixture;

// API mocks must observe page fetches directly. A controlling service worker can
// make WebKit bypass Playwright's page routing even when the worker falls through.
test.use({ serviceWorkers: "block" });

function envelope(parts: Record<string, unknown> = {}): string {
  return JSON.stringify({ status: "ok", infos: [], errors: [], parts });
}

async function mockLoginApi(page: Page): Promise<void> {
  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fields = new URLSearchParams(route.request().postData() ?? "");
    if (path.endsWith("/login/preLogin")) {
      await route.fulfill({ contentType: "application/json", body: envelope({ salt: fixture.accountSaltHex }) });
      return;
    }
    if (path.endsWith("/login/login")) {
      expect(fields.get("password")).toBe(fixture.loginHashHex);
      await route.fulfill({
        contentType: "application/json",
        body: envelope({
          token: "browser-token+with&symbols=",
          userId: "browser-user",
          keyBundle: fixture.keyBundleBase64,
          serverPublicKey: fixture.params.serverPublicKeyBase64,
          isKeyBackedUp: "1",
          homeFolder: "fixture-home",
          addons: "[]",
        }),
      });
      return;
    }
    if (path.endsWith("/login/logout")) {
      expect(fields.get("token")).toBe("browser-token+with&symbols=");
      await route.fulfill({ contentType: "application/json", body: envelope() });
      return;
    }
    if (path.endsWith("/sync/getUpdates")) {
      expect(fields.get("filesST")).toBe("0");
      await route.fulfill({
        contentType: "application/json",
        body: envelope({ files: [], trash: [], albums: [], albumFiles: [], contacts: [], deletes: [] }),
      });
      return;
    }
    await route.abort("failed");
  });
}

test("signs in through the real crypto worker and clears the session", async ({ page }) => {
  let loginRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/login/login")) loginRequests += 1;
  });
  await mockLoginApi(page);
  await page.goto("/");
  await page.getByLabel("Email").fill("browser@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "browser@example.test" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Encrypted backup enabled")).toBeVisible();
  await expect(page.getByText("Up to date")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "browser@example.test" })).toBeVisible({ timeout: 30_000 });
  expect(loginRequests).toBe(1);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("creates an account and requires recovery-phrase acknowledgement", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "registration's three MODERATE Argon2 operations need only one browser gate");
  let registration: URLSearchParams | undefined;
  await page.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fields = new URLSearchParams(route.request().postData() ?? "");
    if (path.endsWith("/register/createAccount")) {
      registration = fields;
      expect(fields.get("password")).toMatch(/^[0-9A-F]{128}$/u);
      expect(fields.get("salt")).toMatch(/^[0-9A-F]{32}$/u);
      expect(fields.get("keyBundle")).toBeTruthy();
      await route.fulfill({ contentType: "application/json", body: envelope({ token: "register-token" }) });
      return;
    }
    if (path.endsWith("/login/login")) {
      if (!registration) throw new Error("login occurred before registration");
      expect(fields.get("password")).toBe(registration.get("password"));
      await route.fulfill({
        contentType: "application/json",
        body: envelope({
          token: "new-session-token",
          userId: "new-user",
          keyBundle: registration.get("keyBundle"),
          serverPublicKey: fixture.params.serverPublicKeyBase64,
          isKeyBackedUp: "1",
          homeFolder: "new-home",
          addons: [],
        }),
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: envelope() });
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Email").fill("new@example.test");
  await page.getByLabel("Password", { exact: true }).fill("registration-test-password");
  await page.getByLabel("Confirm password").fill("registration-test-password");
  await page.getByRole("button", { name: "Create encrypted account" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByLabel("Recovery phrase").getByRole("listitem")).toHaveCount(24);
  await page.getByRole("button", { name: "I saved it securely" }).click();
  await expect(page.getByRole("heading", { name: "new@example.test" })).toBeVisible();
});
