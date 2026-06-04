import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT = "finwise-salt-key-998877"; // stable salt to derive keys

// Helper to derive a 256-bit key from the password
function getEncryptionKey(password: string): Buffer {
  return crypto.pbkdf2Sync(password, SALT, 10000, 32, "sha256");
}

/**
 * Encrypts a buffer using AES-256-GCM.
 * Only encrypts if running in desktop mode with a passcode set.
 */
export function encryptBuffer(buffer: Buffer, password?: string): Buffer {
  if (process.env.FINWISE_DESKTOP !== "true" || !password || password.trim() === "") {
    return buffer;
  }

  try {
    const key = getEncryptionKey(password);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Concatenate IV + AuthTag + Encrypted Data
    return Buffer.concat([iv, authTag, encrypted]);
  } catch (err) {
    console.error("[crypto] Encryption failed:", err);
    return buffer;
  }
}

/**
 * Decrypts a buffer using AES-256-GCM.
 * If decryption fails (e.g. file is not encrypted, or wrong password),
 * it returns the original buffer as a backward-compatibility fallback.
 */
export function decryptBuffer(buffer: Buffer, password?: string): Buffer {
  if (process.env.FINWISE_DESKTOP !== "true" || !password || password.trim() === "") {
    return buffer;
  }

  // An encrypted buffer must be at least IV + AuthTag long
  if (buffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    return buffer;
  }

  try {
    const key = getEncryptionKey(password);
    const iv = buffer.subarray(0, IV_LENGTH);
    const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encryptedData = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  } catch (err) {
    // If decryption fails, assume the file is unencrypted (backward compatibility)
    return buffer;
  }
}

/**
 * Encrypts a string to a base64 encoded string.
 */
export function encryptString(text: string, password?: string): string {
  if (process.env.FINWISE_DESKTOP !== "true" || !password || password.trim() === "") {
    return text;
  }
  const buffer = Buffer.from(text, "utf8");
  const encrypted = encryptBuffer(buffer, password);
  return encrypted.toString("base64");
}

/**
 * Decrypts a base64 encoded string back to plain text.
 */
export function decryptString(encryptedBase64: string, password?: string): string {
  if (process.env.FINWISE_DESKTOP !== "true" || !password || password.trim() === "") {
    return encryptedBase64;
  }
  try {
    const buffer = Buffer.from(encryptedBase64, "base64");
    const decrypted = decryptBuffer(buffer, password);
    return decrypted.toString("utf8");
  } catch (err) {
    return encryptedBase64;
  }
}
