//! Port of `apps/server/src/utils/crypto.ts` (Wave 0) plus the key derivation
//! from `apps/server/src/services/auth.service.ts` (`deriveBackupKey`).
//!
//! Formats (byte-compatible with Node):
//! - `OFE1`: `[ "OFE1" ][ 12-byte IV ][ 16-byte tag ][ ciphertext ]`, AES-256-GCM,
//!   key = PBKDF2-HMAC-SHA256(password, "finwise-salt-key-998877", 10_000, 32).
//! - legacy desktop: the same without the magic.
//! - `FWB1`: `[ "FWB1" ][ IV ][ tag ][ ciphertext ]` with a pre-derived 64-char hex key.
//!
//! Never log keys, passwords or plaintext from this module.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use rand::RngCore;
use sha2::Sha256;

const IV_LENGTH: usize = 12;
const AUTH_TAG_LENGTH: usize = 16;
const SALT: &str = "finwise-salt-key-998877";
const FILE_MAGIC: &[u8; 4] = b"OFE1";
const BACKUP_MAGIC: &[u8; 4] = b"FWB1";

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("Unsupported state or unable to authenticate data")]
    Decrypt,
    #[error("Invalid key length")]
    InvalidKey,
}

fn is_blank(password: Option<&str>) -> Option<&str> {
    match password {
        Some(p) if !js_trim(p).is_empty() => Some(p),
        _ => None,
    }
}

/// `String.prototype.trim()`. JS whitespace is Unicode `White_Space` minus
/// U+0085 (NEL), plus U+FEFF (BOM).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

pub fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// PBKDF2-HMAC-SHA256(password, SALT, 10000, 32), cached per password like Node.
fn get_encryption_key(password: &str) -> [u8; 32] {
    static CACHE: OnceLock<Mutex<HashMap<String, [u8; 32]>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(key) = guard.get(password) {
            return *key;
        }
    }
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), SALT.as_bytes(), 10_000, &mut key);
    if let Ok(mut guard) = cache.lock() {
        guard.insert(password.to_string(), key);
    }
    key
}

/// `getFileEncryptionKey()`: the desktop passcode when running as the desktop
/// backend, else the server-wide `ENCRYPTION_KEY`. Inputs are passed in so the
/// in-process (Wave 4) caller need not use environment variables.
pub fn resolve_file_encryption_key(
    desktop_key: Option<&str>,
    server_key: Option<&str>,
) -> Option<String> {
    if let Some(k) = is_blank(desktop_key) {
        return Some(k.to_string());
    }
    if let Some(k) = is_blank(server_key) {
        return Some(k.to_string());
    }
    None
}

/// `isEncryptedFile`: longer than the magic and starts with `OFE1`.
pub fn is_encrypted_file(buffer: &[u8]) -> bool {
    buffer.len() > FILE_MAGIC.len() && buffer.starts_with(FILE_MAGIC)
}

fn random_iv() -> [u8; IV_LENGTH] {
    let mut iv = [0u8; IV_LENGTH];
    rand::thread_rng().fill_bytes(&mut iv);
    iv
}

/// AES-256-GCM encrypt; returns `iv || tag || ciphertext`.
fn seal(key: &[u8; 32], plaintext: &[u8]) -> Option<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let iv = random_iv();
    let sealed = cipher.encrypt(Nonce::from_slice(&iv), plaintext).ok()?;
    // aes-gcm returns ciphertext || tag; Node writes tag before ciphertext.
    let split = sealed.len().checked_sub(AUTH_TAG_LENGTH)?;
    let (ct, tag) = sealed.split_at(split);
    let mut out = Vec::with_capacity(IV_LENGTH + sealed.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(tag);
    out.extend_from_slice(ct);
    Some(out)
}

/// Decrypts `iv || tag || ciphertext`.
fn open_payload(key: &[u8], payload: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if key.len() != 32 {
        return Err(CryptoError::InvalidKey);
    }
    if payload.len() < IV_LENGTH + AUTH_TAG_LENGTH {
        // Node would try with a short/empty tag and fail authentication.
        return Err(CryptoError::Decrypt);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::InvalidKey)?;
    let iv = &payload[..IV_LENGTH];
    let tag = &payload[IV_LENGTH..IV_LENGTH + AUTH_TAG_LENGTH];
    let data = &payload[IV_LENGTH + AUTH_TAG_LENGTH..];
    let mut joined = Vec::with_capacity(data.len() + AUTH_TAG_LENGTH);
    joined.extend_from_slice(data);
    joined.extend_from_slice(tag);
    cipher
        .decrypt(Nonce::from_slice(iv), joined.as_slice())
        .map_err(|_| CryptoError::Decrypt)
}

/// `encryptBuffer`: OFE1 when a non-blank password is given, else unchanged.
pub fn encrypt_buffer(buffer: &[u8], password: Option<&str>) -> Vec<u8> {
    let Some(password) = is_blank(password) else {
        return buffer.to_vec();
    };
    let key = get_encryption_key(password);
    match seal(&key, buffer) {
        Some(sealed) => {
            let mut out = Vec::with_capacity(FILE_MAGIC.len() + sealed.len());
            out.extend_from_slice(FILE_MAGIC);
            out.extend_from_slice(&sealed);
            out
        }
        None => {
            tracing::error!("[crypto] Encryption failed");
            buffer.to_vec()
        }
    }
}

/// `decryptBuffer`: OFE1, then (desktop only) the legacy layout, else the
/// input unchanged. `desktop` is `OPENFINANCE_DESKTOP === "true"`.
pub fn decrypt_buffer(buffer: &[u8], password: Option<&str>, desktop: bool) -> Vec<u8> {
    let Some(password) = is_blank(password) else {
        return buffer.to_vec();
    };
    if is_encrypted_file(buffer) {
        let key = get_encryption_key(password);
        return match open_payload(&key, &buffer[FILE_MAGIC.len()..]) {
            Ok(plain) => plain,
            Err(_) => {
                tracing::error!("[crypto] Decryption failed (wrong key?)");
                buffer.to_vec()
            }
        };
    }
    if !desktop || buffer.len() < IV_LENGTH + AUTH_TAG_LENGTH {
        return buffer.to_vec();
    }
    let key = get_encryption_key(password);
    open_payload(&key, buffer).unwrap_or_else(|_| buffer.to_vec())
}

/// `encryptString`: base64 of `encryptBuffer(utf8)`, or the text unchanged.
pub fn encrypt_string(text: &str, password: Option<&str>) -> String {
    if is_blank(password).is_none() {
        return text.to_string();
    }
    let encrypted = encrypt_buffer(text.as_bytes(), password);
    base64::engine::general_purpose::STANDARD.encode(encrypted)
}

/// `decryptString`. Mirrors Node exactly, including that in desktop mode a
/// plain (never-encrypted) string is base64-decoded and returned as lossy
/// UTF-8 (see QUIRKS.md).
pub fn decrypt_string(encrypted_base64: &str, password: Option<&str>, desktop: bool) -> String {
    if is_blank(password).is_none() {
        return encrypted_base64.to_string();
    }
    let buffer = node_base64_decode(encrypted_base64);
    if !is_encrypted_file(&buffer) && !desktop {
        return encrypted_base64.to_string();
    }
    let decrypted = decrypt_buffer(&buffer, password, desktop);
    String::from_utf8_lossy(&decrypted).into_owned()
}

/// `encryptBackup`: FWB1 with a pre-derived hex key. Like Node, an unusable key
/// makes it return the input unencrypted.
pub fn encrypt_backup(zip: &[u8], key_hex: &str) -> Vec<u8> {
    let key = node_hex_decode(key_hex);
    let Ok(key) = <[u8; 32]>::try_from(key.as_slice()) else {
        tracing::error!("[crypto] Backup encryption failed: Invalid key length");
        return zip.to_vec();
    };
    match seal(&key, zip) {
        Some(sealed) => {
            let mut out = Vec::with_capacity(BACKUP_MAGIC.len() + sealed.len());
            out.extend_from_slice(BACKUP_MAGIC);
            out.extend_from_slice(&sealed);
            out
        }
        None => zip.to_vec(),
    }
}

/// `decryptBackup`: `Ok(None)` when there is no FWB1 header (legacy ZIP),
/// `Err` when the header is present but decryption fails.
pub fn decrypt_backup(buffer: &[u8], key_hex: &str) -> Result<Option<Vec<u8>>, CryptoError> {
    if !buffer.starts_with(BACKUP_MAGIC) {
        return Ok(None);
    }
    let key = node_hex_decode(key_hex);
    open_payload(&key, &buffer[BACKUP_MAGIC.len()..]).map(Some)
}

/// `deriveBackupKey`: PBKDF2-HMAC-SHA256(password, "finwise-backup-<username>",
/// 200_000, 32) as lowercase hex.
pub fn derive_backup_key(password: &str, username: &str) -> String {
    let mut key = [0u8; 32];
    let salt = format!("finwise-backup-{username}");
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt.as_bytes(), 200_000, &mut key);
    hex::encode(key)
}

/// `Buffer.from(s, "hex")`: decodes pairs until the first invalid one.
pub fn node_hex_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let (Some(hi), Some(lo)) = (hex_val(pair[0]), hex_val(pair[1])) else {
            break;
        };
        out.push((hi << 4) | lo);
    }
    out
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `Buffer.from(s, "base64")`: accepts the standard and URL-safe alphabets,
/// skips any other character, stops at the first `=`, and decodes a trailing
/// partial group (2 chars → 1 byte, 3 chars → 2 bytes, 1 char → nothing).
pub fn node_base64_decode(s: &str) -> Vec<u8> {
    let mut sextets = Vec::with_capacity(s.len());
    for &c in s.as_bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        sextets.push(v as u32);
    }
    let mut out = Vec::with_capacity(sextets.len() * 3 / 4);
    for group in sextets.chunks(4) {
        match group.len() {
            4 => {
                let n = (group[0] << 18) | (group[1] << 12) | (group[2] << 6) | group[3];
                out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]);
            }
            3 => {
                let n = (group[0] << 18) | (group[1] << 12) | (group[2] << 6);
                out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8]);
            }
            2 => {
                let n = (group[0] << 18) | (group[1] << 12);
                out.push((n >> 16) as u8);
            }
            _ => {}
        }
    }
    out
}

/// The at-rest file crypto settings for this process: the resolved key and
/// whether we run as the desktop backend. Held by `AppState`.
#[derive(Clone, Default)]
pub struct FileCrypto {
    key: Option<String>,
    desktop: bool,
}

impl std::fmt::Debug for FileCrypto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileCrypto")
            .field("key", &self.key.as_ref().map(|_| "<redacted>"))
            .field("desktop", &self.desktop)
            .finish()
    }
}

impl FileCrypto {
    pub fn new(key: Option<String>, desktop: bool) -> Self {
        Self { key, desktop }
    }
    /// `getFileEncryptionKey()`.
    pub fn key(&self) -> Option<&str> {
        self.key.as_deref()
    }
    pub fn desktop(&self) -> bool {
        self.desktop
    }
    pub fn encrypt_buffer(&self, buffer: &[u8]) -> Vec<u8> {
        encrypt_buffer(buffer, self.key())
    }
    pub fn decrypt_buffer(&self, buffer: &[u8]) -> Vec<u8> {
        decrypt_buffer(buffer, self.key(), self.desktop)
    }
    pub fn encrypt_string(&self, text: &str) -> String {
        encrypt_string(text, self.key())
    }
    pub fn decrypt_string(&self, text: &str) -> String {
        decrypt_string(text, self.key(), self.desktop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        hex::encode(b)
    }

    // Expected values captured from Node 24 `Buffer.from(s, "base64")`.
    #[test]
    fn base64_matches_node() {
        let cases = [
            ("aGVsbG8=", "68656c6c6f"),
            ("aGVsbG8", "68656c6c6f"),
            ("aGV sbG8", "68656c6c6f"),
            ("a=GVsbG8", ""),
            ("aGVsbA", "68656c6c"),
            ("aGVsb", "68656c"),
            ("a", ""),
            ("-_-_", "fbffbf"),
            ("+/+/", "fbffbf"),
            ("!!aGVs!!bG8=xyz", "68656c6c6f"),
            ("hello world", "85e965a30a2b95"),
            ("plain memory text", "a656a29e67a6a2bcad7b1b"),
            ("", ""),
            ("aGVsbG8==aGVs", "68656c6c6f"),
            ("YQ=YQ", "61"),
            ("YQ\nYQ", "610610"),
        ];
        for (input, expected) in cases {
            assert_eq!(hex(&node_base64_decode(input)), expected, "input {input:?}");
        }
    }

    // Expected values captured from Node 24 `Buffer.from(s, "hex")`.
    #[test]
    fn hex_matches_node() {
        assert_eq!(hex(&node_hex_decode("616263zz6465")), "616263");
        assert_eq!(hex(&node_hex_decode("abc")), "ab");
        assert_eq!(hex(&node_hex_decode("0g12")), "");
        assert_eq!(hex(&node_hex_decode("ABcd")), "abcd");
    }

    #[test]
    fn utf8_lossy_matches_node() {
        let bytes = [0x61, 0xff, 0x62, 0xe2, 0x82, 0x63, 0xf0, 0x9f, 0x98];
        assert_eq!(String::from_utf8_lossy(&bytes), "a\u{fffd}b\u{fffd}c\u{fffd}");
    }

    #[test]
    fn roundtrips() {
        let pw = Some("pw");
        let enc = encrypt_buffer(b"hello", pw);
        assert!(is_encrypted_file(&enc));
        assert_eq!(decrypt_buffer(&enc, pw, false), b"hello");
        assert_eq!(decrypt_buffer(&enc, Some("nope"), false), enc);
        assert_eq!(encrypt_buffer(b"hello", Some("  ")), b"hello");
        let s = encrypt_string("memo", pw);
        assert_eq!(decrypt_string(&s, pw, false), "memo");
        assert_eq!(decrypt_string("plain", pw, false), "plain");
        let key = "11".repeat(32);
        let b = encrypt_backup(b"zip", &key);
        assert!(b.starts_with(b"FWB1"));
        assert_eq!(decrypt_backup(&b, &key).ok().flatten().as_deref(), Some(&b"zip"[..]));
        assert!(decrypt_backup(&b, &"22".repeat(32)).is_err());
        assert!(matches!(decrypt_backup(b"PK..", &key), Ok(None)));
        // Unusable key: Node's createCipheriv throws and the ZIP goes out as-is.
        assert_eq!(encrypt_backup(b"zip", "abc"), b"zip");
    }
}
