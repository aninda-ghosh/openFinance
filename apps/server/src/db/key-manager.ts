import crypto from "node:crypto";

// The key is a 64-character lowercase hex string (32 bytes — AES-256).
// NEVER log it, serialize it, or pass it to Ollama.
//
// Key lifecycle:
//   Development  → set FINWISE_DB_KEY env var before starting the server
//   Production   → Tauri reads from macOS Keychain (tauri-plugin-keyring),
//                  generates a new random key on first launch, then passes it
//                  to this sidecar via the FINWISE_DB_KEY environment variable.
//                  See: apps/desktop/src-tauri/src/lib.rs → get_or_create_db_key()

const _SERVICE = "finwise";
const _ACCOUNT = "db-key";

export async function getOrCreateDbKey(): Promise<string> {
  const existing = await getKeyFromEnv();
  if (existing) return existing;

  // Fallback for bare `tsx src/index.ts` without FINWISE_DB_KEY set.
  // This should never happen in production (Tauri always injects the key).
  const newKey = crypto.randomBytes(32).toString("hex");
  console.warn(
    `[key-manager] FINWISE_DB_KEY not set — generated ephemeral key for this run. ` +
      `Set FINWISE_DB_KEY="${newKey}" to persist the database across restarts.`
  );
  return newKey;
}

async function getKeyFromEnv(): Promise<string | null> {
  const key = process.env.FINWISE_DB_KEY;
  if (!key || key.trim() === "") return null;
  return key;
}
