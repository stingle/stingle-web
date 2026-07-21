# Test fixtures

The credentials, recovery phrase, public/private keys, encrypted headers, and
album material in `desktop-v1.json` are synthetic interoperability test vectors.
They do not belong to a real Stingle account and must never be reused outside
the automated test suite.

`libheif-example.heic` is retained as the interoperability sample described in
`LIBHEIF_FIXTURE.md`. The small video probes under `media/` are imported only by
the browser media-test harness and are not included in the production build.
