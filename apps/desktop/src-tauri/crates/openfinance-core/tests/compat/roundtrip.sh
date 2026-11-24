#!/usr/bin/env bash
# Rust → Node direction of the compatibility checkpoints (PLAN.md §5):
# Rust creates an encrypted, bootstrapped DB plus OFE1/FWB1 payloads, then the
# real Node modules open/decrypt them. Exit code != 0 on any failure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../../../../.." && pwd)"
SERVER="$REPO/apps/server"
TSX="$SERVER/node_modules/.bin/tsx"
WORKSPACE="$REPO/apps/desktop/src-tauri"
PASS="thr0w'away pass ✓"

if [[ ! -x "$TSX" ]]; then
  echo "missing $TSX; run the parity harness once (it links node_modules) or pnpm install" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(cd "$WORKSPACE" && COMPAT_OUT="$TMP" cargo test -q -p openfinance-core --test compat \
  -- --ignored write_outputs_for_node >/dev/null)

IN="$TMP" SERVER_SRC="$SERVER/src" DB_PATH="$TMP/rust.db" OPENFINANCE_DB_KEY="$PASS" \
  OPENFINANCE_DESKTOP=true "$TSX" "$HERE/node/verify-rust-output.ts"

# A wrong passcode must make Node exit with 13 on the Rust-written file.
set +e
IN="$TMP" SERVER_SRC="$SERVER/src" DB_PATH="$TMP/rust.db" OPENFINANCE_DB_KEY="wrong" \
  OPENFINANCE_DESKTOP=true "$TSX" "$HERE/node/verify-rust-output.ts" >/dev/null 2>&1
code=$?
set -e
if [[ $code -ne 13 ]]; then
  echo "FAIL node exit code with wrong passcode on rust db: $code (want 13)"
  exit 1
fi
echo "ok   node exits 13 on rust-written db with wrong passcode"
