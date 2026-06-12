#!/usr/bin/env bash
# One-shot openFinance deployment: checks Docker, generates secrets, builds
# and starts the full stack. Safe to re-run — secrets are generated once and
# subsequent runs just rebuild and restart the containers.
set -euo pipefail

cd "$(dirname "$0")/.."

DOCKER_DESKTOP_URL="https://www.docker.com/products/docker-desktop/"

# ── 1. Docker installed? ──────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ Docker is not installed."
  echo
  echo "openFinance deploys as Docker containers, so Docker is required."
  case "$(uname -s)" in
    Darwin)
      echo "Download Docker Desktop for Mac: $DOCKER_DESKTOP_URL"
      printf "Open the download page in your browser now? [Y/n] "
      read -r answer
      if [[ ! "$answer" =~ ^[Nn] ]]; then
        open "$DOCKER_DESKTOP_URL"
      fi
      ;;
    Linux)
      echo "Install Docker Engine with:"
      echo "  curl -fsSL https://get.docker.com | sh"
      echo "or download Docker Desktop: $DOCKER_DESKTOP_URL"
      ;;
    *)
      echo "Download Docker Desktop: $DOCKER_DESKTOP_URL"
      ;;
  esac
  echo
  echo "Re-run this script after installing Docker."
  exit 1
fi

# ── 2. Docker daemon running? ─────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker is installed but the daemon is not running."
  if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/Docker.app" ]; then
    echo "Starting Docker Desktop…"
    open -a Docker
    printf "Waiting for Docker to start"
    for _ in $(seq 1 60); do
      if docker info >/dev/null 2>&1; then
        echo " ✓"
        break
      fi
      printf "."
      sleep 2
    done
    if ! docker info >/dev/null 2>&1; then
      echo
      echo "Docker did not start in time. Start it manually and re-run this script."
      exit 1
    fi
  else
    echo "Start Docker and re-run this script."
    exit 1
  fi
fi

# ── 3. Compose v2 available? ──────────────────────────────────────────────────
if ! docker compose version >/dev/null 2>&1; then
  echo "❌ Docker Compose v2 is required (the 'docker compose' command)."
  echo "Update Docker Desktop, or install the compose plugin:"
  echo "  https://docs.docker.com/compose/install/"
  exit 1
fi

# ── 4. Generate secrets into .env (first run only) ───────────────────────────
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -vN "$1" -An -tx1 /dev/urandom | tr -d ' \n'
  fi
}

touch .env
if ! grep -q '^JWT_SECRET=' .env; then
  echo "JWT_SECRET=$(random_hex 32)" >> .env
  echo "Generated JWT_SECRET → .env"
fi
if ! grep -q '^POSTGRES_PASSWORD=' .env; then
  echo "POSTGRES_PASSWORD=$(random_hex 16)" >> .env
  echo "Generated POSTGRES_PASSWORD → .env"
fi
if ! grep -q '^ENCRYPTION_KEY=' .env; then
  echo "ENCRYPTION_KEY=$(random_hex 32)" >> .env
  echo "Generated ENCRYPTION_KEY → .env"
  echo "⚠️  Uploaded documents are encrypted with this key — back up .env somewhere safe."
fi

# ── 5. Build and start the stack ──────────────────────────────────────────────
echo
echo "Building and starting openFinance…"
docker compose up -d --build

# ── 6. Wait for the stack to come up ──────────────────────────────────────────
WEB_PORT=$(grep '^WEB_PORT=' .env | cut -d= -f2 || true)
WEB_PORT=${WEB_PORT:-3002}

printf "Waiting for the app to become healthy"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://localhost:${WEB_PORT}/health" >/dev/null 2>&1; then
    echo " ✓"
    echo
    echo "========================================================="
    echo "  openFinance is running!"
    echo
    echo "  Open:  http://localhost:${WEB_PORT}"
    echo "  First visit: register your account."
    echo
    echo "  AI assistant: point it at your Ollama server from the"
    echo "  in-app Settings page (default: http://localhost:11434)."
    echo "========================================================="
    exit 0
  fi
  printf "."
  sleep 2
done

echo
echo "⚠️  The stack started but did not report healthy within 2 minutes."
echo "Check the logs with: docker compose logs -f"
exit 1
