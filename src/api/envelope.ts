import { ApiError, SessionExpiredError } from "./errors";

export type JsonObject = Record<string, unknown>;

export interface ApiEnvelope {
  status: string;
  parts: JsonObject;
  infos: string[];
  errors: string[];
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
}

export function parseEnvelope(value: unknown): ApiEnvelope {
  if (!isJsonObject(value)) throw new ApiError("API response is not a JSON object.", "protocol");
  if (typeof value.status !== "string") {
    throw new ApiError("API response has no valid status field.", "protocol");
  }
  // PHP's json_encode represents an empty associative result as [] on several
  // successful mutation endpoints. Accept that one legacy shape as {} without
  // weakening validation for non-empty arrays.
  const emptyPartsArray = Array.isArray(value.parts) && value.parts.length === 0;
  if (value.parts !== undefined && !isJsonObject(value.parts) && !emptyPartsArray) {
    throw new ApiError("API response has an invalid parts field.", "protocol");
  }
  return {
    status: value.status,
    parts: isJsonObject(value.parts) ? value.parts : {},
    infos: stringList(value.infos),
    errors: stringList(value.errors),
  };
}

export function partString(envelope: ApiEnvelope, name: string): string | undefined {
  const value = envelope.parts[name];
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : String(value);
}

export function requiredPart(envelope: ApiEnvelope, name: string): string {
  const value = partString(envelope, name);
  if (!value) throw new ApiError(`API response is missing ${name}.`, "protocol");
  return value;
}

export function partArray(envelope: ApiEnvelope, name: string): unknown[] {
  const value = envelope.parts[name];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function assertEnvelopeOk(envelope: ApiEnvelope): ApiEnvelope {
  const logout = partString(envelope, "logout");
  if (logout !== undefined && logout !== "" && logout !== "0") throw new SessionExpiredError();
  if (envelope.status !== "ok") {
    const message = envelope.errors[0] ?? envelope.infos[0] ?? "The server rejected the request.";
    throw new ApiError(message, "server");
  }
  return envelope;
}
