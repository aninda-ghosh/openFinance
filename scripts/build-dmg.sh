#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

# Read the current version from the root package.json
VERSION=$(node -p "require('./package.json').version")
echo "Project version is $VERSION. Syncing to configuration files..."

# Update version in apps/desktop/src-tauri/tauri.conf.json
node -e "
  const fs = require('fs');
  const path = './apps/desktop/src-tauri/tauri.conf.json';
  const config = JSON.parse(fs.readFileSync(path, 'utf8'));
  config.version = '$VERSION';
  fs.writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
"

# Update version in apps/desktop/package.json
node -e "
  const fs = require('fs');
  const path = './apps/desktop/package.json';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2), 'utf8');
"

# Update version in apps/server/package.json
node -e "
  const fs = require('fs');
  const path = './apps/server/package.json';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2), 'utf8');
"

echo "Version successfully synced to $VERSION."

echo "---------------------------------------------------------"
echo "Step 1: Bundling Node.js backend server sidecar..."
echo "---------------------------------------------------------"
pnpm --filter @finwise/server bundle:sidecar

echo "---------------------------------------------------------"
echo "Step 2: Building desktop React frontend client..."
echo "---------------------------------------------------------"
pnpm --filter finwise-desktop build

echo "---------------------------------------------------------"
echo "Step 3: Building standalone macOS DMG installer..."
echo "---------------------------------------------------------"

# Read current version for final output path print
CUR_VERSION=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")

# Check if rustup is available for universal compilation
if command -v rustup &> /dev/null; then
  echo "rustup detected. Setting up compilation targets for Universal DMG..."
  rustup target add aarch64-apple-darwin || true
  rustup target add x86_64-apple-darwin || true
  
  CI=true pnpm --filter finwise-desktop tauri build --target universal-apple-darwin --bundles dmg
  DMG_PATH="apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Finwise_${CUR_VERSION}_universal.dmg"
else
  echo "rustup not found (running via system/Homebrew rustc). Building native host DMG..."
  CI=true pnpm --filter finwise-desktop tauri build --bundles dmg
  # Detect host architecture for the output path
  HOST_ARCH=$(uname -m)
  if [ "$HOST_ARCH" = "arm64" ]; then
    HOST_ARCH="aarch64"
  fi
  DMG_PATH="apps/desktop/src-tauri/target/release/bundle/dmg/Finwise_${CUR_VERSION}_${HOST_ARCH}.dmg"
fi

echo "========================================================="
echo "Build complete!"
echo "DMG file created at:"
echo "  $(pwd)/$DMG_PATH"
echo "========================================================="
