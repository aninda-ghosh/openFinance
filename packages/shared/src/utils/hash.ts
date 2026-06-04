import { createHash } from "node:crypto";

// Compute SHA-256 hash of a raw CSV row string — used as import_hash for deduplication
export function hashRow(row: string): string {
  return createHash("sha256").update(row).digest("hex");
}
