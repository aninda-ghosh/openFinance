# 🦉 openFinance (v4.0.1) — Your Money. Your Rules. 💸

A self-hosted personal finance powerhouse built for developers, privacy purists, and builders who want **absolute control** over their financial destiny. No cloud trackers, no data brokers sniffing your transaction history, and no subscription fees. Just gorgeous Obsidian dashboards and secure offline AI chat, running 100% on your own hardware.

openFinance deploys as a single Docker Compose stack — a React frontend served by Nginx, a Node.js Hono backend, and a PostgreSQL database — and is accessed from any browser on your network. One script (`./scripts/deploy.sh`) takes care of everything. 🚀

---

## ⚡ Superpowers

- 🛡️ **Self-Hosted & Login-Protected** — Runs entirely on your own server. The API is protected by username/password authentication with signed JWT tokens, and your data never leaves your machine.
- 🔒 **AES-256-GCM Encryption at Rest** — Uploaded bank statements, contract notes, and AI chat memories are encrypted on disk with a server key generated at deploy time and decrypted on the fly in memory.
- 📦 **Single-File Deployment** — The whole stack (web UI, API server, database, reverse proxy config) is defined in one `docker-compose.yml`, including the Dockerfiles inline. One command builds and starts everything.
- 💸 **Envelope Budgeting** — Dynamic zero-based budgeting with custom rollovers (carry it forward, cap it, or reset it).
- 🏦 **Unified Balance Sheet** — Scannable tracking across Checking, Savings, Credit Cards, Cash, Investments, and Loans.
- 📈 **Tax-Loss & Portfolio Tracking** — Real-time performance metrics across mutual funds, stocks, bonds, high-yield deposits, real estate, and crypto.
- 🧠 **100% Offline Local AI Chat** — Talk to your database! Ask natural-language questions like *"How much did I spend on Starbucks this month?"* powered by a local Ollama model. Your data never leaves your machine.
- 💱 **Global Multi-Currency Engine** — Native support for INR, USD, SGD, GBP, EUR, JPY, and NTD with dynamic exchange rates and localized formatting.
- 🌿 **Tactile Obsidian Theme** — A stunning, tactile user experience with rich layered depth, sage-green dark mode undertones, elegant brand gradients, and fluid transitions.
- 📦 **One-Click Backup & Import** — Decrypts files on export to a standard `.zip` folder and re-encrypts with your key when importing.

---

## Screenshots

### 1. Dashboard
![Dashboard](screenshots/01-dashboard.png)

### 2. Net Worth Analytics
![Net Worth](screenshots/02-net-worth.png)

### 3. Cash Flow Visualizer
![Cash Flow](screenshots/03-cash-flow.png)

### 4. Envelope Budgeting
![Envelope Budgeting](screenshots/04-budget.png)

### 5. Transactions Ledger
![Transactions](screenshots/05-transactions.png)

### 6. Checking & Savings Accounts
![Savings Accounts](screenshots/06-accounts-savings.png)

### 7. Investments & Holdings
![Investments](screenshots/07-accounts-investments.png)

### 8. Insurance Policies
![Insurance Policies](screenshots/08-accounts-policies.png)

### 9. Debt & Loans Tracker
![Debt & Loans](screenshots/09-accounts-debt.png)

### 10. Local AI Financial Assistant
![AI Chat](screenshots/11-ai-chat.png)

### 11. Help & Documentation
![Help & FAQ](screenshots/12-help-n-faqs.png)

### 12. Settings & Backups
![Settings](screenshots/13-settings.png)

### 13. Secure Document Storage
![Settings](screenshots/14-document-storage.png)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19 + Vite + TypeScript + TailwindCSS 4 |
| **Backend** | Hono (Node.js / TypeScript) |
| **Database** | PostgreSQL 17 |
| **ORM** | Drizzle ORM |
| **AI LLM Client** | Ollama (local instance) |
| **Deployment** | Docker Compose + Nginx |

---

## Prerequisites

To **deploy**:
- **Docker Engine** with **Compose v2.23.1+** (the compose file uses inline Dockerfiles and configs)

To **modify or develop** the codebase:
- **Node.js 22+**
- **pnpm 10+**
- **Ollama** (optional, for AI chat features):
  ```bash
  ollama pull gemma4:e2b
  ```

---

## Local Development

openFinance uses Turborepo to orchestrate development tasks. Install dependencies and start the development servers:

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Start a local PostgreSQL — uncomment the `ports` lines under the
#    postgres service in docker-compose.yml, then:
docker compose up -d postgres

# 3. Spin up frontend (port 1420) and backend dev servers (port 3001).
#    Use the POSTGRES_PASSWORD that scripts/deploy.sh generated into .env:
DATABASE_URL=postgres://openfinance:<POSTGRES_PASSWORD>@127.0.0.1:5432/openfinance pnpm dev
```

During development:
- The React client runs at `http://localhost:1420` (open it in your browser).
- The Node server starts in watch mode with tsx on port `3001`.

---

## Deploying with Docker

The entire stack — web UI (Nginx), API server, and PostgreSQL database — is defined in a single [`docker-compose.yml`](./docker-compose.yml), with the Dockerfiles and Nginx config inlined. Deployment is one command:

```bash
./scripts/deploy.sh
```

The script:
1. Checks that **Docker** is installed (and points you to the download page if it isn't — on macOS it can also start Docker Desktop for you).
2. Generates the required secrets (`JWT_SECRET`, `POSTGRES_PASSWORD`) into `.env` on first run — no manual configuration needed.
3. Builds and starts the stack with `docker compose up -d --build`.
4. Waits until the app reports healthy and prints the URL.

Then open `http://<your-server>:3002` in a browser and **register your account** on first launch.

### Services

| Service | Description |
|---------|-------------|
| `web` | React UI served by Nginx on host port **3002**; proxies `/api` to the server |
| `server` | Hono API on internal port `3001` (uncomment the `ports` mapping in the compose file to expose it directly) |
| `postgres` | PostgreSQL 17 — the application database |

### AI assistant (Ollama)

The AI chat connects to any reachable [Ollama](https://ollama.com) server — configure the URL and model from the in-app **Settings → AI Assistant** page (defaults to `http://localhost:11434`). Nothing is hardcoded: point it at your workstation, a GPU box on your LAN, or anywhere else. If Ollama runs on the same machine as Docker, use `http://host.docker.internal:11434`.

### Data persistence

| Volume | Contents |
|--------|----------|
| `openfinance_pgdata` | PostgreSQL data |
| `openfinance_uploads` | Uploaded documents — encrypted at rest (AES-256-GCM) |
| `openfinance_chat-memories` | AI conversation memories — encrypted at rest |

All survive rebuilds and upgrades. To back up the database:

```bash
docker compose exec postgres pg_dump -U openfinance openfinance > openfinance-backup.sql
```

### Configuration (`.env`)

Everything is generated or defaulted automatically; override only if you want to.

| Variable | Default | Purpose |
|----------|---------|---------|
| `JWT_SECRET` | auto-generated by `deploy.sh` | Secret used to sign login tokens |
| `POSTGRES_PASSWORD` | auto-generated by `deploy.sh` | Database password |
| `ENCRYPTION_KEY` | auto-generated by `deploy.sh` | AES-256-GCM key for documents & chat memories at rest |
| `WEB_PORT` | `3002` | Host port for the web UI |
| `OLLAMA_URL` / `OLLAMA_MODEL` | unset | Optional overrides for the AI defaults; normally configured in-app instead |

> ⚠️ **Back up your `.env` file.** It holds the encryption key — without it, uploaded documents cannot be decrypted.

### Upgrading

```bash
git pull
./scripts/deploy.sh
```

---

## Project Structure

```
openFinance/
├── apps/
│   ├── server/               # Hono backend API server (TypeScript)
│   │   ├── src/
│   │   │   ├── ai/           # Local Ollama client & chat memories
│   │   │   ├── db/           # Drizzle ORM schemas & PostgreSQL connection
│   │   │   ├── routes/       # API router endpoints
│   │   │   └── services/     # Core logic (Budgets, Documents, crypto)
│   │   └── scripts/          # Server esbuild bundler
│   │
│   └── desktop/              # React frontend client (Vite, TailwindCSS)
│
├── packages/
│   └── shared/               # Monorepo shared contract & validator types
│
├── screenshots/              # README previews
├── scripts/                  # Utility scripts (backup conversion)
├── docker-compose.yml        # Full-stack Docker deployment (inline Dockerfiles)
├── package.json              # Workspace root package config
└── pnpm-workspace.yaml       # Monorepo workspace configuration
```

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for full project releases and commit histories.
