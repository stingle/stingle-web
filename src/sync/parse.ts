import { type ApiEnvelope, isJsonObject } from "../api/envelope";
import { ApiError } from "../api/errors";
import {
  DeleteEventType,
  type DeleteEvent,
  type DeleteEventCode,
  type RemoteAlbum,
  type RemoteContact,
  type RemoteFile,
  type SyncUpdates,
} from "./model";

function protocol(message: string): never {
  throw new ApiError(message, "protocol");
}

function records(envelope: ApiEnvelope, name: string): Record<string, unknown>[] {
  const raw = envelope.parts[name];
  if (raw === undefined || raw === null || raw === "") return [];
  let values: unknown;
  if (typeof raw === "string") {
    try {
      values = JSON.parse(raw) as unknown;
    } catch {
      return protocol(`API part ${name} is not valid JSON.`);
    }
  } else {
    values = raw;
  }
  if (!Array.isArray(values)) return protocol(`API part ${name} is not an array.`);
  return values.map((value, index) => {
    if (!isJsonObject(value)) return protocol(`API part ${name}[${index}] is not an object.`);
    return value;
  });
}

function text(row: Record<string, unknown>, name: string, required = true): string {
  const value = row[name];
  if (value === undefined || value === null) {
    if (!required) return "";
    return protocol(`Sync row is missing ${name}.`);
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return protocol(`Sync field ${name} is not scalar.`);
  }
  const result = String(value);
  if (required && result.length === 0) return protocol(`Sync field ${name} is empty.`);
  return result;
}

function integer(row: Record<string, unknown>, name: string, required = true): number {
  const raw = row[name];
  if ((raw === undefined || raw === null || raw === "") && !required) return 0;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return protocol(`Sync field ${name} is not a safe non-negative integer.`);
  return value;
}

function flag(row: Record<string, unknown>, name: string): boolean {
  const value = row[name];
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0" || value === undefined || value === null) return false;
  return protocol(`Sync flag ${name} is invalid.`);
}

function validateFilename(value: string): string {
  // The current clients generate base64url/hex `.sp` names, but existing
  // accounts can contain older server-assigned names. Match Desktop's actual
  // trust boundary: accept one bounded path component, never traversal or
  // control characters. All HTTP consumers must still URL-encode this value.
  if (
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return protocol("Sync file contains an unsafe storage filename.");
  }
  return value;
}

function parseFile(row: Record<string, unknown>, albumFile: boolean): RemoteFile {
  const albumId = text(row, "albumId", false);
  if (albumFile && !albumId) return protocol("Album file is missing albumId.");
  const result: RemoteFile = {
    file: validateFilename(text(row, "file")),
    version: integer(row, "version"),
    headers: text(row, "headers"),
    dateCreated: integer(row, "dateCreated"),
    dateModified: integer(row, "dateModified"),
  };
  if (albumId) result.albumId = albumId;
  return result;
}

function parseAlbum(row: Record<string, unknown>): RemoteAlbum {
  return {
    albumId: text(row, "albumId"),
    encPrivateKey: text(row, "encPrivateKey"),
    publicKey: text(row, "publicKey"),
    metadata: text(row, "metadata", false),
    isShared: flag(row, "isShared"),
    isHidden: flag(row, "isHidden"),
    isOwner: flag(row, "isOwner"),
    members: text(row, "members", false),
    permissions: text(row, "permissions", false),
    isLocked: flag(row, "isLocked"),
    cover: text(row, "cover", false),
    dateCreated: integer(row, "dateCreated"),
    dateModified: integer(row, "dateModified"),
  };
}

function parseContact(row: Record<string, unknown>): RemoteContact {
  return {
    userId: text(row, "userId"),
    email: text(row, "email"),
    publicKey: text(row, "publicKey"),
    dateUsed: integer(row, "dateUsed", false),
    dateModified: integer(row, "dateModified", false),
  };
}

function parseDelete(row: Record<string, unknown>): DeleteEvent {
  const type = integer(row, "type") as DeleteEventCode;
  if (!Object.values(DeleteEventType).includes(type)) return protocol(`Unknown delete-event type ${type}.`);
  const file = text(row, "file", type !== DeleteEventType.ALBUM);
  const albumId = text(row, "albumId", false);
  if ((type === DeleteEventType.ALBUM || type === DeleteEventType.ALBUM_FILE) && !albumId) {
    return protocol("Album delete event is missing albumId.");
  }
  const result: DeleteEvent = { file, type, date: integer(row, "date") };
  if (albumId) result.albumId = albumId;
  return result;
}

function optionalCounter(envelope: ApiEnvelope, name: string): number | undefined {
  const raw = envelope.parts[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return protocol(`API part ${name} is invalid.`);
  return value;
}

export function parseSyncUpdates(envelope: ApiEnvelope): SyncUpdates {
  const result: SyncUpdates = {
    files: records(envelope, "files").map((row) => parseFile(row, false)),
    trash: records(envelope, "trash").map((row) => parseFile(row, false)),
    albums: records(envelope, "albums").map(parseAlbum),
    albumFiles: records(envelope, "albumFiles").map((row) => parseFile(row, true)),
    contacts: records(envelope, "contacts").map(parseContact),
    deletes: records(envelope, "deletes").map(parseDelete),
  };
  const spaceUsed = optionalCounter(envelope, "spaceUsed");
  const spaceQuota = optionalCounter(envelope, "spaceQuota");
  if (spaceUsed !== undefined) result.spaceUsed = spaceUsed;
  if (spaceQuota !== undefined) result.spaceQuota = spaceQuota;
  return result;
}
