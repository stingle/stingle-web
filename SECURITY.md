# Security Policy

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues.

Email [security@stingle.org](mailto:security@stingle.org). If possible, encrypt
the report with the
[Stingle security PGP key](https://stingle.org/publickey.security@stingle.org-7a5ca27ce343345bc679eff0807cb16d3cee7552.asc).

Include as much of the following information as possible:

- The type and impact of the issue.
- Step-by-step reproduction instructions.
- Affected source paths and versions, branches, or commits.
- Any special configuration required to reproduce it.
- Proof-of-concept or exploit code, when available.

Security communication should be in English.

## Browser security model

Stingle Web preserves the Stingle end-to-end encryption boundary. Account and
album private keys are handled by a dedicated crypto worker. The API receives
encrypted blobs, sealed headers, opaque encrypted mutation parameters, and
bearer-token fields.

### Refresh persistence

To restore a signed-in session after refresh, the crypto worker stores one
non-extractable AES-GCM `CryptoKey` in IndexedDB and an authenticated ciphertext
containing the session token, identity keypair, server public key, and public
session metadata. Restore validates the record framing, field types, and
identity public/private key relationship.

Logout, API session expiry, failed restoration, and a replacement login erase
the session record. Clearing browser site data also signs the account out.

This is not an operating-system keychain. JavaScript executing with the
application's same-origin authority can ask the non-extractable key to decrypt
the session. A compromised running origin therefore has the authority of the
unlocked session. Content Security Policy, dependency review, TLS, and
prevention of same-origin script injection remain essential.

### Media and uploads

- Decrypted thumbnails and photos use revocable memory-only object URLs.
- Video sessions expose authenticated plaintext ranges only while active.
- Decrypted media is not stored in Cache Storage or IndexedDB.
- HEIC conversion and video-thumbnail extraction happen locally.
- Upload originals and previews are encrypted inside the crypto worker.
- Plaintext filenames are stored only inside sealed Stingle headers.
- Signed storage URLs must be credential-free HTTPS and receive no Stingle
  token or cookies.

Production deployments must use HTTPS and should not add third-party scripts to
the application origin.
