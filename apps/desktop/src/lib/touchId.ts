import { invoke } from "@tauri-apps/api/core";

/**
 * Unlock with Touch ID. The passcode is stored and read by the Rust side
 * (`src-tauri/src/touch_id`); none of these calls ever returns it. Failures
 * reject with a short code string (see `touchIdMessage`).
 */
export interface TouchIdStatus {
  availability: "available" | "not_enrolled" | "unavailable";
  enabled: boolean;
  /** Show "Unlock with Touch ID next time?" now. */
  offer: boolean;
}

export const touchId = {
  status: () => invoke<TouchIdStatus>("touch_id_status"),
  /** Stores the passcode typed at the last unlock (kept in Rust). */
  enable: () => invoke<void>("touch_id_enable"),
  /** `remember: true` is "Not now": don't ask again. */
  dismiss: (remember: boolean) =>
    invoke<void>("touch_id_dismiss", { remember }),
  enableWithPassword: (password: string) =>
    invoke<void>("touch_id_enable_with_password", { password }),
  disable: () => invoke<void>("touch_id_disable"),
  unlock: () => invoke<void>("unlock_with_touch_id"),
};

/**
 * A short message for a rejected Touch ID unlock, or `null` when nothing
 * should be shown (a plain cancel).
 */
export function touchIdUnlockMessage(code: unknown): string | null {
  switch (code) {
    case "cancelled":
    case "not_enabled":
      return null;
    case "biometry_changed":
      return "Your fingerprints changed, so Touch ID was turned off. Enter your password.";
    case "invalidated":
      return "Touch ID was turned off. Enter your password.";
    case "lockout":
      return "Touch ID is locked. Enter your password.";
    case "unavailable":
      return "Touch ID isn't available right now. Enter your password.";
    case "keychain":
      return "Couldn't read the saved password. Enter your password.";
    default:
      return "Touch ID didn't work. Enter your password.";
  }
}

/**
 * A short message for a failed attempt to turn Touch ID on, or `null` for a
 * plain cancel.
 */
export function touchIdEnableMessage(code: unknown): string | null {
  switch (code) {
    case "cancelled":
      return null;
    case "wrong_password":
      return "That password is wrong.";
    case "no_pending_passcode":
      return "That took too long. Turn on Touch ID in Settings.";
    case "lockout":
      return "Touch ID is locked. Try again later.";
    case "unavailable":
      return "Touch ID isn't available on this Mac.";
    case "keychain":
      return "Couldn't save to the keychain.";
    default:
      return "Couldn't turn on Touch ID.";
  }
}
