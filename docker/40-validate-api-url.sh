#!/bin/sh
set -eu

case "${API_SERVER_URL:-}" in
  https://*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://\[::1\]|http://\[::1\]:*) ;;
  *)
    echo >&2 "API_SERVER_URL must be HTTPS, or HTTP on an explicit loopback host"
    exit 1
    ;;
esac

api_authority=${API_SERVER_URL#*://}
case "$api_authority" in
  ""|*/*|*\?*|*\#*|*@*)
    echo >&2 "API_SERVER_URL must be an origin only (scheme, host, and optional port)"
    exit 1
    ;;
esac
