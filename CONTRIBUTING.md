# Contributing to Stingle Photos Web

Thank you for helping improve Stingle Photos Web.

## Development setup

Use Node.js 22 or newer. Install the locked dependency graph with:

```sh
npm ci
```

Copy `.env.example` to `.env` when you need to connect to an API server. Never
commit credentials, tokens, private keys, recovery phrases, or real account
media.

## Before opening a pull request

Run all release gates:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
```

Keep changes focused, add regression tests for behavioral changes, and document
new configuration. Preserve compatibility with the existing Stingle encrypted
formats and API contracts.

Tests under `tests/integration` that contact a live service are opt-in. Use only
an explicitly authorized disposable account, and ensure mutation tests remove
all data they create.

## Security issues

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in [SECURITY.md](SECURITY.md).

## License of contributions

By contributing, you agree that your contribution is licensed under the GNU
General Public License version 3, the same license as this project.
