#!/usr/bin/env node
/**
 * convert-backup.mjs
 *
 * Decrypts a legacy Finwise encrypted backup (.fwb) and writes an
 * unencrypted ZIP that the new openFinance app can import directly.
 *
 * Usage:
 *   node scripts/convert-backup.mjs <path-to-backup.fwb>
 *
 * It will ask for the old Finwise username and password interactively.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ─── Crypto constants (must match the app's crypto.ts) ─────────────────────
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const BACKUP_MAGIC = Buffer.from("FWB1");

// ─── Key derivation (must match auth.service.ts deriveBackupKey) ───────────
function deriveBackupKey(password, username) {
  return crypto
    .pbkdf2Sync(password, `finwise-backup-${username}`, 200_000, 32, "sha256")
    .toString("hex");
}

// ─── Decrypt backup (must match crypto.ts decryptBackup) ───────────────────
function decryptBackup(buffer, keyHex) {
  if (!buffer.subarray(0, 4).equals(BACKUP_MAGIC)) {
    return null; // Not encrypted
  }

  const payload = buffer.subarray(4); // strip magic
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encryptedData = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const key = Buffer.from(keyHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}

// ─── Interactive prompt helper ─────────────────────────────────────────────
function prompt(question, hide = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hide) {
      // Hide password input
      const stdout = process.stdout;
      rl.question(question, (answer) => {
        rl.close();
        stdout.write("\n");
        resolve(answer);
      });
      rl._writeToOutput = function _writeToOutput(stringToWrite) {
        if (stringToWrite.includes(question)) {
          stdout.write(stringToWrite);
        } else {
          stdout.write("*");
        }
      };
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const inputPath = process.argv[2];

  if (!inputPath) {
    console.error("Usage: node scripts/convert-backup.mjs <path-to-backup.fwb>");
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found: ${inputPath}`);
    process.exit(1);
  }

  const rawBuffer = fs.readFileSync(inputPath);

  // Check if it's actually encrypted
  if (!rawBuffer.subarray(0, 4).equals(BACKUP_MAGIC)) {
    console.log("This backup is not encrypted (no FWB1 magic header).");
    console.log("It should import directly into openFinance without conversion.");
    process.exit(0);
  }

  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║         openFinance — Backup Conversion Tool             ║");
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log("║  This tool decrypts a legacy Finwise encrypted backup    ║");
  console.log("║  (.fwb) into a plain ZIP that openFinance can import.    ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`Input file: ${path.basename(inputPath)}`);
  console.log(`File size:  ${(rawBuffer.length / 1024).toFixed(1)} KB`);
  console.log();

  const username = await prompt("Enter the old Finwise username: ");
  const password = await prompt("Enter the old Finwise password: ", true);

  if (!username.trim() || !password.trim()) {
    console.error("Error: Username and password are required.");
    process.exit(1);
  }

  console.log();
  console.log("Deriving decryption key (this may take a moment)...");

  const keyHex = deriveBackupKey(password, username);

  try {
    const decrypted = decryptBackup(rawBuffer, keyHex);
    if (!decrypted) {
      console.error("Error: Could not decrypt — the file does not have an encrypted backup header.");
      process.exit(1);
    }

    // Verify it's a valid ZIP (PK magic bytes)
    if (decrypted[0] !== 0x50 || decrypted[1] !== 0x4b) {
      console.error("Error: Decryption produced invalid data. The username or password is likely incorrect.");
      process.exit(1);
    }

    // Write unencrypted ZIP
    const basename = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(path.dirname(inputPath), `${basename}-converted.zip`);
    fs.writeFileSync(outputPath, decrypted);

    console.log();
    console.log("✅ Backup decrypted successfully!");
    console.log();
    console.log(`Output: ${outputPath}`);
    console.log();
    console.log("You can now import this file in the openFinance app:");
    console.log("  Settings → Backup & Restore → Import Backup → select the .zip file");
    console.log();
  } catch (err) {
    console.error();
    console.error("❌ Decryption failed — incorrect username or password.");
    console.error(`   (${err.message})`);
    console.error();
    console.error("Make sure you're using the exact same username and password");
    console.error("that were used to set up the original Finwise app.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
