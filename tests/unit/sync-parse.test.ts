import { describe, expect, test } from "vitest";

import { parseEnvelope } from "../../src/api/envelope";
import { ApiError } from "../../src/api/errors";
import { DeleteEventType } from "../../src/sync/model";
import { parseSyncUpdates } from "../../src/sync/parse";

function envelope(parts: Record<string, unknown>) {
  return parseEnvelope({ status: "ok", parts, errors: [], infos: [] });
}

describe("sync payload parser", () => {
  test("accepts string numerics and JSON-encoded arrays", () => {
    const updates = parseSyncUpdates(
      envelope({
        files: JSON.stringify([
          {
            file: "safe_file-1.sp",
            version: "2",
            headers: "opaque*opaque",
            dateCreated: "100",
            dateModified: "200",
          },
        ]),
        contacts: [{ userId: 9, email: "friend@example.test", publicKey: "pk", dateUsed: null, dateModified: "300" }],
        spaceUsed: "12",
        spaceQuota: 1024,
      }),
    );
    expect(updates.files[0]).toMatchObject({ file: "safe_file-1.sp", version: 2, dateModified: 200 });
    expect(updates.contacts[0]).toMatchObject({ userId: "9", dateUsed: 0, dateModified: 300 });
    expect(updates.spaceUsed).toBe(12);
  });

  test("rejects unsafe filenames before they reach local paths", () => {
    expect(() =>
      parseSyncUpdates(
        envelope({
          files: [{ file: "../escape.sp", version: 1, headers: "x*y", dateCreated: 1, dateModified: 2 }],
        }),
      ),
    ).toThrow(ApiError);
  });

  test("accepts a bounded legacy filename that is still one safe component", () => {
    const updates = parseSyncUpdates(
      envelope({
        files: [{ file: "legacy file+1.sp", version: 1, headers: "x*y", dateCreated: 1, dateModified: 2 }],
      }),
    );

    expect(updates.files[0]?.file).toBe("legacy file+1.sp");
  });

  test.each([".", "..", "a/b.sp", "a\\b.sp", "C:evil.sp", "bad\u0000name.sp"])(
    "rejects unsafe filename %j",
    (file) => {
      expect(() =>
        parseSyncUpdates(
          envelope({ files: [{ file, version: 1, headers: "x*y", dateCreated: 1, dateModified: 2 }] }),
        ),
      ).toThrow(/unsafe storage filename/u);
    },
  );

  test("rejects malformed collections, dates, and unknown delete types", () => {
    expect(() => parseSyncUpdates(envelope({ files: "not-json" }))).toThrow(/valid JSON/u);
    expect(() =>
      parseSyncUpdates(envelope({ deletes: [{ file: "x.sp", type: 99, date: 10 }] })),
    ).toThrow(/Unknown delete-event/u);
    expect(() =>
      parseSyncUpdates(
        envelope({
          files: [{ file: "x.sp", version: 1, headers: "x*y", dateCreated: 1, dateModified: -1 }],
        }),
      ),
    ).toThrow(/dateModified/u);
  });

  test("accepts album delete events whose identity is only albumId", () => {
    const updates = parseSyncUpdates(
      envelope({ deletes: [{ file: "", albumId: "album-id", type: DeleteEventType.ALBUM, date: 10 }] }),
    );
    expect(updates.deletes[0]).toEqual({ file: "", albumId: "album-id", type: 4, date: 10 });
  });
});
