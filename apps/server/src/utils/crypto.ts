import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT = "finwise-salt-key-998877"; // stable salt to derive keys

// 4-byte header marking the current encrypted-at-rest format. Desktop-era
// files were written without it; see the legacy paths below.
const FILE_MAGIC = Buffer.from("OFE1");

const keyCache = new Map<string, Buffer>();

// Helper to derive a 256-bit key from the password
function getEncryptionKey(password: string): Buffer {
  let key = keyCache.get(password);
  if (!key) {
    key = crypto.pbkdf2Sync(password, SALT, 10000, 32, "sha256");
    keyCache.set(password, key);
  }
  return key;
}

/**
 * Resolves the key used for at-rest encryption of uploaded documents and
 * chat memories: the desktop passcode-derived key when running as a Tauri
 * sidecar, otherwise the server-wide ENCRYPTION_KEY (generated into .env by
 * scripts/deploy.sh for Docker deployments).
 */
export function getFileEncryptionKey(): string | undefined {
  const desktopKey = process.env.OPENFINANCE_DB_KEY;
  if (desktopKey && desktopKey.trim() !== "") return desktopKey;
  const serverKey = process.env.ENCRYPTION_KEY;
  if (serverKey && serverKey.trim() !== "") return serverKey;
  return undefined;
}

/** True when the buffer was written by encryptBuffer in the current format. */
export function isEncryptedFile(buffer: Buffer): boolean {
  return buffer.length > FILE_MAGIC.length && buffer.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);
}

/**
 * Encrypts a buffer using AES-256-GCM whenever a key is provided.
 * Output format: [4-byte magic "OFE1"] [12-byte IV] [16-byte AuthTag] [ciphertext]
 */
export function encryptBuffer(buffer: Buffer, password?: string): Buffer {
  if (!password || password.trim() === "") {
    return buffer;
  }

  try {
    const key = getEncryptionKey(password);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([FILE_MAGIC, iv, authTag, encrypted]);
  } catch (err) {
    console.error("[crypto] Encryption failed:", err);
    return buffer;
  }
}

function decryptPayload(payload: Buffer, password: string): Buffer {
  const key = getEncryptionKey(password);
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encryptedData = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}

/**
 * Decrypts a buffer using AES-256-GCM.
 * Handles the current magic-prefixed format, the legacy desktop format
 * (IV + AuthTag + data, no magic), and plain unencrypted data — the latter
 * two fall back to returning the original buffer when decryption fails.
 */
export function decryptBuffer(buffer: Buffer, password?: string): Buffer {
  if (!password || password.trim() === "") {
    return buffer;
  }

  if (isEncryptedFile(buffer)) {
    try {
      return decryptPayload(buffer.subarray(FILE_MAGIC.length), password);
    } catch (err) {
      console.error("[crypto] Decryption failed (wrong key?):", err);
      return buffer;
    }
  }

  // No magic header. Desktop-era files were encrypted without one — try the
  // legacy layout there; everywhere else the data is plain.
  if (process.env.OPENFINANCE_DESKTOP !== "true") {
    return buffer;
  }
  if (buffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    return buffer;
  }
  try {
    return decryptPayload(buffer, password);
  } catch {
    // If decryption fails, assume the file is unencrypted (backward compatibility)
    return buffer;
  }
}

/**
 * Encrypts a string to a base64 encoded string whenever a key is provided.
 */
export function encryptString(text: string, password?: string): string {
  if (!password || password.trim() === "") {
    return text;
  }
  const buffer = Buffer.from(text, "utf8");
  const encrypted = encryptBuffer(buffer, password);
  return encrypted.toString("base64");
}

/**
 * Decrypts a base64 encoded string back to plain text.
 * Plain (legacy) strings are returned unchanged.
 */
export function decryptString(encryptedBase64: string, password?: string): string {
  if (!password || password.trim() === "") {
    return encryptedBase64;
  }
  try {
    const buffer = Buffer.from(encryptedBase64, "base64");
    if (!isEncryptedFile(buffer) && process.env.OPENFINANCE_DESKTOP !== "true") {
      return encryptedBase64;
    }
    const decrypted = decryptBuffer(buffer, password);
    return decrypted.toString("utf8");
  } catch (err) {
    return encryptedBase64;
  }
}

// ─── Backup-specific encryption (key already derived, no extra PBKDF2) ─────────

const BACKUP_MAGIC = Buffer.from("FWB1"); // 4-byte header to detect encrypted backups

/**
 * Encrypts a ZIP buffer using a pre-derived 64-char hex key.
 * Output format: [4-byte magic "FWB1"] [12-byte IV] [16-byte AuthTag] [ciphertext]
 */
export function encryptBackup(zipBuffer: Buffer, keyHex: string): Buffer {
  try {
    const key = Buffer.from(keyHex, "hex"); // 32 bytes
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(zipBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([BACKUP_MAGIC, iv, authTag, encrypted]);
  } catch (err) {
    console.error("[crypto] Backup encryption failed:", err);
    return zipBuffer;
  }
}

/**
 * Decrypts a backup buffer encrypted by encryptBackup.
 * Returns null if the buffer doesn't start with the magic header (i.e. legacy unencrypted ZIP).
 * Throws if the magic is present but decryption fails (wrong key).
 */
export function decryptBackup(buffer: Buffer, keyHex: string): Buffer | null {
  // Not an encrypted backup — legacy ZIP
  if (!buffer.subarray(0, 4).equals(BACKUP_MAGIC)) return null;

  const payload = buffer.subarray(4); // strip magic
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encryptedData = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const key = Buffer.from(keyHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // Will throw if key is wrong — caller handles this
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}
