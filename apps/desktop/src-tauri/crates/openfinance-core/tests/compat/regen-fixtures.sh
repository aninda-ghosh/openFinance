#!/usr/bin/env bash
# Regenerates tests/compat/fixtures by running the real Node server modules.
# The passcode is a throwaway test value, also hard-coded in tests/compat.rs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../../../../.." && pwd)"
SERVER="$REPO/apps/server"
TSX="$SERVER/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "missing $TSX; run the parity harness once (it links node_modules) or pnpm install" >&2
  exit 1
fi

OUT="$HERE/fixtures"
rm -rf "$OUT"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

OUT="$OUT" SERVER_SRC="$SERVER/src" DB_PATH="$TMP/node.db" \
  OPENFINANCE_DB_KEY="thr0w'away pass ✓" OPENFINANCE_DESKTOP=true \
  "$TSX" "$HERE/node/gen-fixtures.ts"

# *.db is git-ignored, so the committed copy uses another extension.
cp "$TMP/node.db" "$OUT/node-encrypted.sqlite"
ls -la "$OUT"
