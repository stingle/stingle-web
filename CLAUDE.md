# Stingle Photos Web — Agent Guide

This file is the repository-specific guide for AI coding agents. Read it before
making changes. User instructions take precedence over this guide.

## Project intent

Stingle Photos Web is an independent, self-hostable browser client for the
Stingle Photos end-to-end encrypted service. The production deployment is a
single Docker Compose stack that receives only an API server origin through
`API_SERVER_URL`.

The initial release supports account creation and login, Gallery, Albums,
Shared albums, Trash, browser uploads, photo viewing, and encrypted video
playback. Public album links are deliberately deferred because they require a
coordinated protocol/API change across clients.

The project is GPLv3. Keep new source and dependencies compatible with
`GPL-3.0-only` distribution.

## Sources of truth

Use the sibling Stingle repositories when behavior or protocol details are
unclear:

- `../stingle-desktop` — primary UI and desktop behavior reference
- `../stingle-photos-android` — primary mobile behavior and crypto reference
- `../stingle-api` — server endpoint behavior and request contracts
- `../stingle-contract` — shared contract material when applicable

Do not invent crypto formats, API fields, permission semantics, or album-cover
rules. Confirm them in an existing client/server implementation and add an
interoperability or regression test.

Important established behavior:

- File sets are Gallery `0`, Trash `1`, and Album `2`.
- Album cover `__b__` means intentionally blank.
- An empty cover, or a missing explicitly selected cover, falls back to the
  first item in the album's newest-first ordering, matching Android.
- Thumbnails are aspect-preserving scaled versions, not cropped square images.
- Opening a photo displays the cached scaled image immediately, then swaps in
  the decrypted original when ready.
- Thumbnail work uses a continuously fed pool of 32 concurrent tasks.
- Video playback should use authenticated encrypted byte ranges. Do not replace
  streaming with a mandatory full-file download except as a compatibility
  fallback.

## Architecture

- `src/api` — API transport, envelopes, validation, and download URLs
- `src/auth` — session orchestration and the isolated crypto-worker boundary
- `src/crypto` — Stingle-compatible file, header, key, and encoding formats
- `src/media` — upload preparation, HEIC display conversion, task pooling, and
  authenticated range-based video playback
- `src/sync` — incremental synchronization and the per-account IndexedDB mirror
- `src/app` — React UI and interaction state
- `tests/unit` — deterministic unit and interoperability tests
- `tests/browser` — Playwright UI, worker, image, and media tests
- `tests/integration` — explicitly enabled live-server tests
- `docker` — nginx proxy template, runtime URL validation, and security headers

Keep protocol/crypto logic out of React components. UI code should call
`AuthService`, media helpers, and `MirrorStore` rather than duplicating their
logic.

## Security invariants

These requirements are non-negotiable:

- Passwords, recovery phrases, private keys, plaintext media, access tokens,
  and decrypted headers must never be logged or committed.
- Private-key operations and file cryptography stay behind the crypto-worker
  boundary. Do not move secret keys into long-lived React state.
- Never upload plaintext media or plaintext metadata.
- Wipe sensitive `Uint8Array` buffers when ownership is no longer needed.
- Decrypted media uses revocable in-memory object URLs. Do not persist it in
  IndexedDB, Cache Storage, local storage, service-worker caches, or the file
  system.
- Preserve nginx security headers and the no-third-party-script posture.
- Validate `API_SERVER_URL`; production API origins must use HTTPS. Do not add
  arbitrary runtime proxy targets.
- Do not weaken authentication, response validation, filename validation,
  range authentication, or recovery-phrase acknowledgement to make a test pass.
- Never read, print, or commit `.env` values or live-test credentials.

## Sync and optimistic UI rules

The API update feed can be eventually consistent. A successful mutation must
not wait for a later sync before the UI reflects it.

For accepted uploads and mutations:

1. Wait for the API operation to succeed.
2. Update the IndexedDB mirror immediately without advancing server cursors.
3. Update visible React state and cached thumbnail/cover state immediately.
4. Run normal sync afterward as reconciliation.
5. If the API operation fails, leave the local mirror and UI unchanged.

Apply this consistently to both viewer actions and grid/multi-selection actions.
When removing album items, recalculate an implicit or missing album cover. Add a
browser regression test whose post-mutation update response omits the change so
the test exercises the eventual-consistency case.

## UI conventions

Match the Stingle Desktop visual language and behavior instead of introducing a
generic landing-page design. Reuse Stingle assets already present in sibling
repositories when needed.

- Media tiles do not show filename/date labels.
- The viewer has no frame around the media.
- Clicking outside the media closes the viewer.
- Left/right buttons and keyboard arrows navigate adjacent items; Escape closes.
- Photos support wheel zoom and dragging while zoomed.
- Viewer actions are placed at the top and follow Desktop capabilities.
- Do not add introductory or promotional copy inside the authenticated library.
- Preserve responsive behavior for phone-sized viewports.
- Shared-album actions must respect ownership and permission flags.
- Do not implement public-link or plaintext browser sharing as a substitute for
  encrypted Stingle sharing.

## Editing discipline

- Preserve unrelated user changes; the worktree may already be dirty.
- Keep changes focused and avoid broad mechanical rewrites.
- Prefer existing helpers and fixtures over duplicate implementations.
- Do not add generated output such as `dist`, Playwright results, TypeScript
  build metadata, credentials, or local environment files to Git.
- Keep test-only media under `tests/fixtures`, not `public`, so it is excluded
  from production builds.
- Update README, configuration examples, and tests when public behavior or
  deployment requirements change.
- Do not refer to a non-existent `docs/` directory.

## Required validation

Install the locked dependency graph with Node.js 22 or newer:

```sh
npm ci
```

Run focused tests while developing. Before declaring a change complete, run:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
git diff --check
```

When Docker or production behavior is affected, also run:

```sh
docker compose up -d --build
docker compose ps
```

Confirm the container becomes healthy and the app responds at
`http://localhost:8080`.

Some Playwright cases intentionally run in one engine, and WebKit has a marked
expected failure for a headless native-video behavior. Do not remove meaningful
coverage or turn a new failure into a skip without documenting the platform
limitation.

Every bug fix needs a regression test that fails for the reported behavior and
passes after the fix. Prefer mocked browser/API tests for destructive workflows.

## Live-server tests

Live tests require an explicitly authorized disposable account. The normal test
suite must not contact a live server.

```text
STINGLE_TEST_EMAIL
STINGLE_TEST_PASSWORD
STINGLE_TEST_API_URL
```

Login/logout validation uses `npm run test:live-auth`. Upload and mutation tests
also require `STINGLE_RUN_LIVE_UPLOAD=1` or
`STINGLE_RUN_LIVE_MUTATIONS=1`. Ensure destructive live tests clean up all data
they create, even when assertions fail. Never run them merely because credentials
happen to exist in the environment.

## Completion checklist

Before handing work back:

- Confirm the implementation matches an existing Stingle client or documented
  server contract.
- Confirm failure paths do not expose plaintext or leave incorrect optimistic
  state.
- Confirm refresh/reopen behavior through the IndexedDB mirror.
- Confirm Gallery, Album, Shared album, and Trash capability differences.
- Run the relevant focused regression tests and the full release gates.
- Report what changed, what was tested, and any intentionally deferred behavior.
