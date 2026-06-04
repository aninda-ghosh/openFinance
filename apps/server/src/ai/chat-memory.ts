import { promises as fs } from "node:fs";
import * as path from "node:path";
import { encryptString, decryptString } from "../utils/crypto";

// Store memories inside the App Support folder next to DB_PATH if running in desktop mode
const MEMORIES_DIR = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), "chat-memories")
  : path.join(process.cwd(), "chat-memories");

async function ensureDir() {
  await fs.mkdir(MEMORIES_DIR, { recursive: true });
}

function filePath(conversationId: string) {
  return path.join(MEMORIES_DIR, `${conversationId}.md`);
}

// ─── Read memory for a conversation ───────────────────────────────────────────

export async function readMemory(
  conversationId: string
): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath(conversationId), "utf-8");
    const content = decryptString(raw, process.env.FINWISE_DB_KEY);
    return content.trim() || null;
  } catch {
    return null;
  }
}

// ─── Append an exchange to the memory file ────────────────────────────────────

export async function appendExchange(
  conversationId: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  await ensureDir();
  const fp = filePath(conversationId);

  let existing = "";
  try {
    const raw = await fs.readFile(fp, "utf-8");
    existing = decryptString(raw, process.env.FINWISE_DB_KEY);
  } catch {
    // File doesn't exist yet — start fresh
    existing = `# Chat Memory: ${conversationId}\n\n`;
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const exchange = [
    `---`,
    `**[${timestamp}] User:** ${userMessage.trim()}`,
    ``,
    `**Assistant:** ${assistantMessage.trim()}`,
    ``,
  ].join("\n");

  const updated = existing + exchange;
  const encrypted = encryptString(updated, process.env.FINWISE_DB_KEY);
  await fs.writeFile(fp, encrypted, "utf-8");
}

// ─── Delete memory for a conversation ─────────────────────────────────────────

export async function deleteMemory(conversationId: string): Promise<void> {
  try {
    await fs.unlink(filePath(conversationId));
  } catch {
    // Already gone — no-op
  }
}
