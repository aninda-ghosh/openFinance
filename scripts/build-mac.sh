#!/usr/bin/env bash
#
# Builds openFinance as a standalone macOS app and packages it into a .dmg.
#
#   ./scripts/build-mac.sh
#
# The result is a self-contained app: a Tauri (WebKit) shell around the existing
# React UI, with the Hono API server running inside it as a bundled Node sidecar
# and an encrypted SQLite file for storage. No Docker, no Postgres, no network.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BLUE=$'\033[1;34m'; GREEN=$'\033[1;32m'; RED=$'\033[1;31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
step() { echo "${BLUE}==>${OFF} $*"; }
die()  { echo "${RED}Error:${OFF} $*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────

[[ "$(uname -s)" == "Darwin" ]] || die "This script builds a macOS app and must run on macOS."

command -v cargo >/dev/null || die "Rust is not installed. Install it with:

  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source \"\$HOME/.cargo/env\"

then run this script again."
command -v node  >/dev/null || die "Node.js 22+ is not installed."
xcode-select -p  >/dev/null 2>&1 || die "Xcode command line tools are missing. Run: xcode-select --install"

# Scratch space, cleaned up on exit.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# pnpm: use it if installed, otherwise let Corepack (bundled with Node 22) run
# the exact version pinned in package.json. Nothing is installed globally.
#
# This has to end up on PATH rather than being a shell function: Tauri runs its
# beforeBuildCommand ("pnpm build") in its own subshell, which would not inherit
# a function.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if ! command -v pnpm >/dev/null; then
  command -v corepack >/dev/null \
    || die "pnpm is not installed and this Node has no corepack.
  Install pnpm with one of:
    npm install -g pnpm
    brew install pnpm"

  corepack pnpm --version >/dev/null 2>&1 \
    || die "pnpm is not installed and corepack could not download it.
  Check your network, or install pnpm with one of:
    corepack enable pnpm
    npm install -g pnpm
    brew install pnpm"

  mkdir -p "$SCRATCH/bin"
  cat > "$SCRATCH/bin/pnpm" <<'SHIM'
#!/usr/bin/env bash
exec corepack pnpm "$@"
SHIM
  chmod +x "$SCRATCH/bin/pnpm"
  export PATH="$SCRATCH/bin:$PATH"
  echo "${DIM}pnpm not found — using the version pinned in package.json via corepack${OFF}"
fi

TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
case "$TRIPLE" in
  aarch64-apple-darwin) NODE_ARCH="darwin-arm64" ;;
  x86_64-apple-darwin)  NODE_ARCH="darwin-x64"   ;;
  *) die "Unexpected host target '$TRIPLE' — expected an Apple target." ;;
esac

# The Node runtime shipped inside the .app.
#
# This CANNOT be pinned independently of the local Node. better-sqlite3 is a
# native addon, and pnpm fetches the prebuilt binary matching the ABI
# (NODE_MODULE_VERSION) of whatever Node ran the install. Ship a different Node
# major and the app dies on launch with ERR_DLOPEN_FAILED. Shipping the same
# version that installed the addon keeps the two in lockstep by construction.
NODE_VERSION="${OPENFINANCE_NODE_VERSION:-$(node -v)}"

BIN_DIR="$ROOT/apps/desktop/src-tauri/binaries"
SIDECAR="$BIN_DIR/server-$TRIPLE"

echo "${DIM}target      $TRIPLE"
echo "node runtime $NODE_VERSION ($NODE_ARCH)${OFF}"
echo

# ── 1. Dependencies ───────────────────────────────────────────────────────────

step "Installing workspace dependencies"
pnpm install --no-frozen-lockfile

# ── 2. Bundle the API server ──────────────────────────────────────────────────

step "Bundling the API server into a single file"
pnpm --filter @openfinance/server bundle

# ── 3. Stage the bundle as a Tauri resource ───────────────────────────────────

step "Staging the server bundle into the app resources"
rm -rf "$BIN_DIR/server-bundle"
mkdir -p "$BIN_DIR"
cp -R "$ROOT/apps/server/dist/sidecar" "$BIN_DIR/server-bundle"

# ── 4. Fetch the Node runtime that will run the bundle ────────────────────────

if [[ -x "$SIDECAR" ]] && [[ "$("$SIDECAR" -v 2>/dev/null)" == "$NODE_VERSION" ]]; then
  step "Node $NODE_VERSION sidecar already staged"
else
  [[ -e "$SIDECAR" ]] && rm -f "$SIDECAR"
  step "Downloading the Node $NODE_VERSION runtime"
  TMP="$SCRATCH/node"
  mkdir -p "$TMP"
  TARBALL="node-$NODE_VERSION-$NODE_ARCH.tar.gz"
  curl -fL --progress-bar \
    "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" -o "$TMP/$TARBALL" \
    || die "Could not download the Node runtime. Check your network connection."
  tar -xzf "$TMP/$TARBALL" -C "$TMP"
  cp "$TMP/node-$NODE_VERSION-$NODE_ARCH/bin/node" "$SIDECAR"
  chmod +x "$SIDECAR"
fi

# ── 5. Prove the shipped runtime can drive the shipped database engine ───────
# A native-addon ABI mismatch is invisible until first launch, where it shows up
# only as "server took too long to start". Catch it here instead.

step "Verifying the bundled server can open an encrypted database"
cat > "$SCRATCH/verify.js" <<'JS'
// argv: [node, this script, <addon package dir>, <scratch db path>]
const Database = require(process.argv[2]);
const db = new Database(process.argv[3]);
db.pragma("cipher='sqlcipher'");
db.pragma("legacy = 4");
db.pragma("key='build-check'");
db.exec("CREATE TABLE t (a INTEGER)");
db.prepare("INSERT INTO t VALUES (?)").run(1);
const row = db.prepare("SELECT a FROM t").get();
db.close();
if (!row || row.a !== 1) throw new Error("wrote a row but could not read it back");
JS
"$SIDECAR" "$SCRATCH/verify.js" \
  "$BIN_DIR/server-bundle/node_modules/better-sqlite3" \
  "$SCRATCH/verify.db" \
  || die "The bundled SQLite engine could not be loaded by the bundled Node $NODE_VERSION.

  This is a native-addon ABI mismatch: the better-sqlite3 binary in node_modules
  was built for a different Node than the one being shipped.

  Local node is $(node -v), shipping $NODE_VERSION.
  ${OPENFINANCE_NODE_VERSION:+You set OPENFINANCE_NODE_VERSION — unset it to ship the local Node instead.}

  Otherwise force a fresh addon download:
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    ./scripts/build-mac.sh"

# ── 6. Build the app and package the DMG ──────────────────────────────────────

step "Building the app (this takes a few minutes the first time)"
pnpm --filter openfinance-desktop tauri build

DMG="$(find "$ROOT/apps/desktop/src-tauri/target/release/bundle/dmg" -name '*.dmg' -maxdepth 1 2>/dev/null | head -1)"

echo
if [[ -n "$DMG" ]]; then
  echo "${GREEN}Done.${OFF} Installer: $DMG"
  echo
  echo "Install it by opening the .dmg and dragging openFinance to Applications."
  echo "${DIM}The build is unsigned, so the first launch needs one of:"
  echo "  • right-click the app in Applications → Open → Open"
  echo "  • or: xattr -cr /Applications/openFinance.app${OFF}"
else
  die "The build finished but no .dmg was produced — check the output above."
fi
