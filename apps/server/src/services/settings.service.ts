import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { app_settings } from "../db/schema";

// Resolution order for the AI assistant endpoint/model:
//   1. value saved from the in-app Settings page (app_settings row)
//   2. OLLAMA_URL / OLLAMA_MODEL environment variables
//   3. built-in defaults (localhost)
function envOrNull(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : null;
}

const FALLBACK_OLLAMA_URL = "http://localhost:11434";
const FALLBACK_OLLAMA_MODEL = "gemma4:e2b";

let cachedOllamaUrl: string | null = null;
let cachedOllamaModel: string | null = null;

export function getOllamaUrl(): string {
  return cachedOllamaUrl ?? envOrNull("OLLAMA_URL") ?? FALLBACK_OLLAMA_URL;
}

export function getOllamaModel(): string {
  return cachedOllamaModel ?? envOrNull("OLLAMA_MODEL") ?? FALLBACK_OLLAMA_MODEL;
}

export async function loadAiSettings(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(app_settings)
    .where(eq(app_settings.id, "system"));
  const row = rows[0];
  cachedOllamaUrl = row?.ollama_url?.trim() || null;
  cachedOllamaModel = row?.ollama_model?.trim() || null;
}

export type AiSettings = {
  ollama_url: string;
  ollama_model: string;
  // True when the value comes from the saved setting (vs env/default)
  customized: boolean;
};

export function getAiSettings(): AiSettings {
  return {
    ollama_url: getOllamaUrl(),
    ollama_model: getOllamaModel(),
    customized: cachedOllamaUrl !== null || cachedOllamaModel !== null,
  };
}

export async function updateAiSettings(input: {
  ollama_url?: string | null;
  ollama_model?: string | null;
}): Promise<AiSettings> {
  const db = getDb();
  const values: Partial<typeof app_settings.$inferInsert> = {
    updated_at: new Date().toISOString(),
  };
  if (input.ollama_url !== undefined) {
    // Empty string resets to env/default; strip a trailing slash otherwise
    values.ollama_url = input.ollama_url?.trim()
      ? input.ollama_url.trim().replace(/\/+$/, "")
      : null;
  }
  if (input.ollama_model !== undefined) {
    values.ollama_model = input.ollama_model?.trim() || null;
  }

  await db
    .insert(app_settings)
    .values({ id: "system", ...values })
    .onConflictDoUpdate({ target: app_settings.id, set: values });

  await loadAiSettings();
  return getAiSettings();
}
