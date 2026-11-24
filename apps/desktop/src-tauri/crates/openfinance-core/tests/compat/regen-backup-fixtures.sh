#!/usr/bin/env bash
# Regenerates tests/compat/fixtures/backup by running the real Node backup
# route (export of sample-data.json plus extras, encrypted and plain). The
# passcode is a throwaway test value, also hard-coded in tests/compat_backup.rs.
# It is ASCII on purpose: the import's x-backup-password header is Latin-1.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../../../../.." && pwd)"
SERVER="$REPO/apps/server"
TSX="$SERVER/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "missing $TSX; run the parity harness once (it links node_modules) or pnpm install" >&2
  exit 1
fi

OUT="$HERE/fixtures/backup"
rm -rf "$OUT"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MODE=gen OUT="$OUT" SAMPLE="$REPO/sample-data.json" SERVER_SRC="$SERVER/src" \
  DB_PATH="$TMP/node.db" OPENFINANCE_DB_KEY="backup'pass 1" OPENFINANCE_DESKTOP=true \
  OPENFINANCE_NO_NETWORK=1 "$TSX" "$HERE/node/backup.ts"
ls -la "$OUT"
