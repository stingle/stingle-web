import { describe, expect, test, vi } from "vitest";

import { ApiClient } from "../../src/api/client";
import { SecondFactorUnsupportedError, SessionExpiredError } from "../../src/api/errors";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API client transport", () => {
  test("form-encodes opaque token symbols without corruption", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok", parts: {} }));
    const client = new ApiClient({ baseUrl: "https://example.test/v2/", fetch: fetchMock });
    const token = "a+b&c=d%ef";
    await client.logout(token);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/v2/login/logout");
    expect(new URLSearchParams(String(init?.body)).get("token")).toBe(token);
    expect(init?.credentials).toBe("omit");
  });

  test("detects session expiry and invokes the lifecycle callback", async () => {
    const expired = vi.fn();
    const client = new ApiClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ status: "nok", parts: { logout: "1" }, errors: ["translated"] }),
      ),
      onSessionExpired: expired,
    });
    await expect(client.logout("token")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(expired).toHaveBeenCalledOnce();
  });

  test("recognizes the unrecoverable v2 second-factor signal", async () => {
    const client = new ApiClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ status: "nok", parts: { needSecondFactor: 1 }, errors: [] }),
      ),
    });
    await expect(client.login("person@example.test", "HASH")).rejects.toBeInstanceOf(
      SecondFactorUnsupportedError,
    );
  });

  test("rejects cleartext non-loopback API URLs", () => {
    expect(() => new ApiClient({ baseUrl: "http://example.test/v2/" })).toThrow(/HTTPS/u);
    expect(() => new ApiClient({ baseUrl: "http://127.0.0.1:8080/v2/" })).not.toThrow();
  });

  test("downloads binary SP data and preserves the requested set and thumbnail flag", async () => {
    const bytes = new Uint8Array([0x53, 0x50, 1, 9]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    const client = new ApiClient({ fetch: fetchMock });
    await expect(client.downloadEncrypted("token", "safe.sp", 2, true)).resolves.toEqual(bytes);
    const fields = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(fields.get("file")).toBe("safe.sp");
    expect(fields.get("set")).toBe("2");
    expect(fields.get("thumb")).toBe("1");
  });

  test("never accepts a JSON API error body as encrypted media", async () => {
    const client = new ApiClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "nok", errors: ["missing"], parts: {} })),
    });
    await expect(client.downloadEncrypted("token", "missing.sp", 0, false)).rejects.toThrow("missing");
  });

  test("accepts only credential-free HTTPS signed media URLs", async () => {
    const good = new ApiClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok", parts: { url: "https://storage.example/file?signature=x" } })) });
    await expect(good.getDownloadUrl("token", "file.sp", 0)).resolves.toBe("https://storage.example/file?signature=x");
    const unsafe = new ApiClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok", parts: { url: "http://storage.example/file" } })) });
    await expect(unsafe.getDownloadUrl("token", "file.sp", 0)).rejects.toThrow(/unsafe/u);
  });

  test("sends mutation payloads only as token plus encrypted params", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok", parts: {} }));
    const client = new ApiClient({ baseUrl: "https://example.test/v2/", fetch: fetchMock });
    await client.moveFiles("opaque-token", "encrypted-params");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/v2/sync/moveFile");
    const fields = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(Object.fromEntries(fields)).toEqual({ token: "opaque-token", params: "encrypted-params" });
  });

  test("uses the cross-client change-album-cover endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok", parts: {} }));
    const client = new ApiClient({ baseUrl: "https://example.test/v2/", fetch: fetchMock });
    await client.changeAlbumCover("opaque-token", "encrypted-params");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/v2/sync/changeAlbumCover");
    expect(Object.fromEntries(new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body)))).toEqual({
      token: "opaque-token",
      params: "encrypted-params",
    });
  });

  test("uploads an encrypted original and thumbnail using the interoperable multipart contract", async () => {
    let body: FormData | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      body = init?.body as FormData;
      return jsonResponse({ status: "ok", parts: { spaceUsed: "1", spaceQuota: "2" } });
    });
    const client = new ApiClient({ baseUrl: "https://example.test/v2/", fetch: fetchMock });
    await client.uploadEncrypted("opaque-token", {
      file: "00112233445566778899aabbccddeeff.sp",
      set: 2,
      albumId: "album-id",
      version: 1,
      dateCreated: 123,
      dateModified: 456,
      headers: "file-header*thumb-header",
      encryptedFile: new Uint8Array([0x53, 0x50, 1]),
      encryptedThumb: new Uint8Array([0x53, 0x50, 1, 2]),
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/v2/sync/upload");
    expect(Object.fromEntries(["token", "set", "albumId", "version", "dateCreated", "dateModified", "headers"].map((key) => [key, body?.get(key)]))).toEqual({
      token: "opaque-token", set: "2", albumId: "album-id", version: "1",
      dateCreated: "123", dateModified: "456", headers: "file-header*thumb-header",
    });
    expect(body?.get("file")).toBeInstanceOf(Blob);
    expect((body?.get("file") as Blob).type).toBe("application/stinglephoto");
    expect((body?.get("thumb") as Blob).size).toBe(4);
  });
});
