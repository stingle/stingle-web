# Stingle Photos Web

Stingle Photos Web is the browser client for
[Stingle Photos](https://stingle.org), an end-to-end encrypted photo and video
storage service. It can be self-hosted as an independent Docker Compose stack
and connected to a compatible Stingle API server.

## Features

- Create an account, sign in, restore a browser session, and sign out.
- Browse Gallery, Albums, Shared albums, and Trash.
- Window large galleries and albums, reuse encrypted thumbnail caches after refresh, and prioritize the visible scroll range.
- View JPEG, PNG, WebP, AVIF, GIF, and locally converted HEIC/HEIF images.
- Play authenticated encrypted video through browser range requests.
- Upload encrypted photos and videos from the browser.
- Create albums and copy or move items between Gallery and owned albums.
- Set an album item or a blank image as the album cover.
- Move items to Trash, restore them, permanently delete them, or empty Trash.
- Use a responsive, installable PWA with the Stingle Desktop visual language.

Public album links are not part of the initial release because they require a
coordinated API and native-client protocol change.

## Security model

Encryption, decryption, file-header processing, and private-key operations run
locally in a dedicated crypto worker. Account and album private keys are not
sent to the API server. Decrypted thumbnails, photos, and compatibility video
blobs use revocable in-memory URLs and are not stored in Cache Storage or
IndexedDB. Downloaded thumbnail ciphertext is cached in the per-account
IndexedDB mirror and must be decrypted again before display.

Refresh-session restoration stores an authenticated ciphertext and a
non-extractable browser `CryptoKey`. This protects against casual disk
inspection, but it is not equivalent to an operating-system keychain: code
executing with the application's same-origin authority can use the unlocked
session. Production deployments must use HTTPS, retain the supplied security
headers, and avoid third-party scripts on the application origin.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and additional
security details.

## Requirements

- Node.js 22 or newer
- npm
- Docker with Docker Compose for the recommended deployment path

## Run with Docker

Create the local environment file:

```sh
cp .env.example .env
```

Set `API_SERVER_URL` to an HTTPS origin without a path or trailing slash:

```text
API_SERVER_URL=https://api.stingle.org
```

Then build and start the independent stack:

```sh
docker compose up -d --build
```

Open `http://localhost:8080`. For any non-loopback deployment, place the stack
behind a TLS reverse proxy. Browser crypto and service workers require a secure
context in production.

## Local development

```sh
cp .env.example .env
npm ci
npm run dev
```

The development server listens on `http://127.0.0.1:4173` and proxies `/api/`
to `API_SERVER_URL`. Loopback HTTP API origins are accepted for local
development; all other API origins must use HTTPS.

## Testing

Run the release gates before submitting a change:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
```

The Playwright suite covers Chromium, Firefox, and WebKit. Some native-media
cases are intentionally exercised only in the engines that support them
reliably in headless mode.

Live API tests are opt-in and require an explicitly authorized disposable test
account supplied through environment variables:

```sh
STINGLE_TEST_EMAIL=...
STINGLE_TEST_PASSWORD=...
STINGLE_TEST_API_URL=https://api.stingle.org
npm run test:live-auth
```

The default live test is read-only apart from login/logout. Mutation and upload
tests additionally require their explicit enable flags and clean up their
temporary data. Never commit credentials or real account media.

## Repository layout

- `src/api` — API transport and response validation
- `src/auth` — session service and isolated crypto worker
- `src/crypto` — Stingle-compatible cryptographic formats
- `src/media` — image preparation and authenticated video streaming
- `src/sync` — incremental sync and IndexedDB mirror
- `src/app` — React application UI
- `tests` — unit, browser, interoperability, and opt-in live tests
- `docker` — nginx proxy, runtime validation, and security headers

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a pull request. Report security issues privately as described in
[SECURITY.md](SECURITY.md), not through a public issue.

## License

Stingle Photos Web is free software licensed under the
[GNU General Public License version 3](LICENSE).
