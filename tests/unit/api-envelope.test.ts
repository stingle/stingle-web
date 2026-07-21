import { describe, expect, test } from "vitest";

import { assertEnvelopeOk, parseEnvelope, partArray } from "../../src/api/envelope";
import { ApiError, SessionExpiredError } from "../../src/api/errors";

describe("API response envelope", () => {
  test("requires an explicit ok status", () => {
    expect(() => parseEnvelope({ parts: {} })).toThrow(ApiError);
    expect(() => assertEnvelopeOk(parseEnvelope({ status: "unexpected", parts: {} }))).toThrow(ApiError);
  });

  test("accepts arrays encoded directly or as JSON strings", () => {
    const direct = parseEnvelope({ status: "ok", parts: { values: ["a", "b"] } });
    const encoded = parseEnvelope({ status: "ok", parts: { values: '["a","b"]' } });
    expect(partArray(direct, "values")).toEqual(["a", "b"]);
    expect(partArray(encoded, "values")).toEqual(["a", "b"]);
  });

  test("normalizes the server's legacy empty mutation parts array only", () => {
    expect(parseEnvelope({ status: "ok", parts: [] }).parts).toEqual({});
    expect(() => parseEnvelope({ status: "ok", parts: ["unexpected"] })).toThrow(ApiError);
  });

  test("turns the machine-readable logout flag into session expiry", () => {
    const envelope = parseEnvelope({ status: "nok", parts: { logout: 1 }, errors: ["localized"] });
    expect(() => assertEnvelopeOk(envelope)).toThrow(SessionExpiredError);
  });
});
