#!/usr/bin/env bash
# Deploy openFinance to a remote server using SCP/SSH:
# Builds the Docker images locally, exports them to archive files,
# transfers the archives and docker-compose.yml to the server,
# and loads them on the remote Docker engine.
set -euo pipefail

cd "$(dirname "$0")/.."

# ── 1. Argument validation ────────────────────────────────────────────────────
if [ "$#" -lt 1 ]; then
  echo "❌ Error: Remote host argument is required."
  echo "Usage:"
  echo "  $0 user@your-server-ip [target_directory]"
  echo "Example:"
  echo "  $0 ubuntu@198.51.100.1 /opt/openfinance"
  exit 1
fi

REMOTE_HOST="$1"
TARGET_DIR="${2:-/opt/openfinance}"
TEMP_DIR="/tmp/openfinance-deploy"

# ── 2. Local Docker check ────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ Error: Local Docker command is not found. Please install Docker."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "❌ Error: Local Docker daemon is not running. Please start Docker."
  exit 1
fi

# ── 3. Establish Multiplexed SSH Connection ─────────────────────────────────
# Since password authentication is used, ControlMaster lets us prompt for the
# password exactly once and reuse that single session for all copies and builds.
SSH_SOCKET="/tmp/ssh-control-openfinance-$$"
echo "🔑 Establishing secure SSH connection to $REMOTE_HOST..."
echo "Please enter your remote password if prompted:"

ssh -M -S "$SSH_SOCKET" -f -o ExitOnForwardFailure=yes -o ControlPersist=10m -N "$REMOTE_HOST"

# Ensure we close the master connection on exit
cleanup() {
  echo "🧹 Closing SSH connection and cleaning up..."
  ssh -S "$SSH_SOCKET" -O exit "$REMOTE_HOST" 2>/dev/null || true
}
trap cleanup EXIT

# ── 4. Build local Docker images ──────────────────────────────────────────────
echo "🔨 Building openFinance Docker images locally..."
docker compose build

# ── 5. Create remote directory and copy configurations ────────────────────────
echo "📂 Setting up remote directory and configs..."
ssh -S "$SSH_SOCKET" "$REMOTE_HOST" "
  if [ -d '$TARGET_DIR' ]; then
    echo '🧹 Cleaning up remote target directory (preserving .env)...'
    find '$TARGET_DIR' -mindepth 1 -not -name '.env' -delete 2>/dev/null || true
  else
    mkdir -p '$TARGET_DIR'
  fi
"

ssh -S "$SSH_SOCKET" "$REMOTE_HOST" "cat > '$TARGET_DIR/docker-compose.yml'" < docker-compose.yml

# Copy local .env file to the remote server if it doesn't already exist there
if ssh -S "$SSH_SOCKET" "$REMOTE_HOST" "[ ! -f '$TARGET_DIR/.env' ]"; then
  echo "📝 Remote .env not found. Copying local .env secrets..."
  ssh -S "$SSH_SOCKET" "$REMOTE_HOST" "cat > '$TARGET_DIR/.env'" < .env
else
  echo "ℹ️ Remote .env already exists. Preserving it."
fi

# ── 6. Stream and Load Docker Images directly over SSH ────────────────────────
# Instead of writing massive .tar files to disk, we stream the output of 
# 'docker save' directly into the remote server's 'docker load' standard input.
echo "📤 Streaming openfinance-server image to remote host..."
docker save openfinance-server:latest | ssh -S "$SSH_SOCKET" "$REMOTE_HOST" "docker load"

echo "📤 Streaming openfinance-web image to remote host..."
docker save openfinance-web:latest | ssh -S "$SSH_SOCKET" "$REMOTE_HOST" "docker load"

# ── 7. Restart containers on remote server ──────────────────────────────────
echo "🔄 Starting openFinance on remote host..."
ssh -S "$SSH_SOCKET" "$REMOTE_HOST" "cd '$TARGET_DIR' && docker compose up -d"

echo "✨ Deployment complete! openFinance is running on $REMOTE_HOST."

