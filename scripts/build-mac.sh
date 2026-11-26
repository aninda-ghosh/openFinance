#!/usr/bin/env bash
#
# Builds openFinance as a standalone macOS app and packages it into a .dmg.
#
#   ./scripts/build-mac.sh
#
# The result is a self-contained app: a Tauri (WebKit) shell around the React
# UI, with the API server (Rust, axum) running inside the same process and an
# encrypted SQLite (SQLCipher) file for storage. No Node runtime is shipped, no
# sidecar, no Docker, no Postgres, no network.
#
# Node.js and pnpm are still needed at build time, to build the UI with Vite.
#
# Optional: CODESIGN_IDENTITY="openFinance Local" ./scripts/build-mac.sh
# signs the app with that code-signing identity (e.g. a self-signed
# certificate in your login keychain, see docs/TOUCH-ID.md) so its signature
# stays the same across rebuilds and macOS stops asking for keychain access to
# the Touch ID passcode after every rebuild. Unset, the build is unchanged.
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
command -v node  >/dev/null || die "Node.js 22+ is not installed (it is needed to build the UI; the app itself does not ship Node)."
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
  aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *) die "Unexpected host target '$TRIPLE' — expected an Apple target." ;;
esac

echo "${DIM}target      $TRIPLE${OFF}"
echo

# ── 1. Dependencies ───────────────────────────────────────────────────────────

step "Installing workspace dependencies (for the UI build)"
pnpm install --no-frozen-lockfile

# ── 2. Build the app and package the DMG ──────────────────────────────────────
# Tauri runs "pnpm build" (tsc + vite) for the UI, then compiles the Rust app,
# which includes the API server and SQLCipher.

step "Building the app (this takes a few minutes the first time)"
pnpm --filter openfinance-desktop tauri build

BUNDLE="$ROOT/apps/desktop/src-tauri/target/release/bundle"
APP="$BUNDLE/macos/openFinance.app"
DMG="$(find "$BUNDLE/dmg" -name '*.dmg' -maxdepth 1 2>/dev/null | head -1)"

# ── 3. Check the bundle is a single binary ────────────────────────────────────
# The app must not carry a Node runtime or a sidecar from an older build.

step "Checking the app bundle"
[[ -d "$APP" ]] || die "The build finished but $APP is missing — check the output above."
EXECUTABLES="$(find "$APP/Contents/MacOS" -type f)"
[[ "$(echo "$EXECUTABLES" | wc -l | tr -d ' ')" == "1" ]] \
  || die "Expected exactly one executable in the app bundle, found:
$EXECUTABLES"
[[ ! -e "$APP/Contents/Resources/binaries" ]] \
  || die "The app bundle still contains the old server sidecar resources."

# ── 4. Optional: sign with a stable identity ──────────────────────────────────
# Signs the .app with CODESIGN_IDENTITY, then puts the signed app into the DMG
# Tauri made (keeping its window layout). Only runs when the variable is set.

if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
  step "Signing the app with \"$CODESIGN_IDENTITY\""
  [[ -n "$DMG" ]] || die "No .dmg to update — check the output above."
  security find-identity -v -p codesigning | grep -qF "\"$CODESIGN_IDENTITY\"" \
    || die "No valid code-signing identity named \"$CODESIGN_IDENTITY\" in your keychain.
  See docs/TOUCH-ID.md for how to create one, or unset CODESIGN_IDENTITY."
  codesign --force --deep --sign "$CODESIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP" || die "The signed app does not verify."

  RW="$SCRATCH/rw.dmg"
  MNT="$SCRATCH/mnt"
  mkdir -p "$MNT"
  hdiutil convert "$DMG" -format UDRW -o "$RW" -quiet
  hdiutil resize -size +20m "$RW" -quiet
  hdiutil attach "$RW" -nobrowse -noverify -noautoopen -mountpoint "$MNT" -quiet
  detach() { hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet; }
  if ! { rm -rf "$MNT/openFinance.app" && ditto "$APP" "$MNT/openFinance.app"; }; then
    detach
    die "Could not copy the signed app into the DMG."
  fi
  codesign --verify --deep --strict "$MNT/openFinance.app" \
    || { detach; die "The app in the DMG does not verify."; }
  detach
  rm -f "$DMG"
  hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" -quiet
  echo "${DIM}$(codesign -dvv "$APP" 2>&1 | grep -E '^(Authority|Identifier)=' | tr '\n' ' ')${OFF}"
fi

echo
if [[ -n "$DMG" ]]; then
  echo "${GREEN}Done.${OFF} Installer: $DMG"
  echo "${DIM}app $(du -sh "$APP" | cut -f1), dmg $(du -sh "$DMG" | cut -f1)${OFF}"
  echo
  echo "Install it by opening the .dmg and dragging openFinance to Applications."
  echo "${DIM}The build is unsigned, so the first launch needs one of:"
  echo "  • right-click the app in Applications → Open → Open"
  echo "  • or: xattr -cr /Applications/openFinance.app${OFF}"
else
  die "The build finished but no .dmg was produced — check the output above."
fi
