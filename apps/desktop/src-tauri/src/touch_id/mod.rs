//! Unlock with Touch ID.
//!
//! **How it is protected (read this before changing anything).** The app is
//! unsigned / ad-hoc signed, so it cannot create data-protection Keychain
//! items guarded by `kSecAccessControlBiometryCurrentSet` (those need a team ID
//! and the keychain-access-groups entitlement). Instead:
//!
//! - the passcode is a normal generic-password item in the user's **login
//!   keychain** (service `com.anindaghosh.openfinance`, account `db-passcode`);
//! - **this app** asks LocalAuthentication for a Touch ID match
//!   (`LAPolicyDeviceOwnerAuthenticationWithBiometrics`) before it reads that
//!   item.
//!
//! The fingerprint check is therefore enforced by the app, not by the
//! Keychain. Anything else running as the same user that the Keychain lets
//! read the item (after its own access prompt) could read the passcode
//! without a fingerprint. See `docs/TOUCH-ID.md`.
//!
//! To mimic `BiometryCurrentSet`, enrolment records a SHA-256 hash of
//! LAContext's `evaluatedPolicyDomainState`; if it differs at unlock time
//! (fingers added or removed) the stored passcode is deleted and the feature
//! turned off.
//!
//! The passcode stays in Rust: it is never returned to the UI. All logic sits
//! behind [`SecretStore`] and [`Biometrics`] so it can be tested with fakes;
//! the real macOS implementations are in `macos.rs`.

#[cfg(target_os = "macos")]
mod macos;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Keychain service for the stored passcode (the app's bundle identifier).
pub const KEYCHAIN_SERVICE: &str = "com.anindaghosh.openfinance";
/// Keychain account for the stored passcode.
pub const KEYCHAIN_ACCOUNT: &str = "db-passcode";
/// Shown by macOS in the Touch ID dialog: "openFinance is trying to unlock openFinance."
pub const REASON: &str = "unlock openFinance";
/// The Touch ID settings file, next to the database. Never holds the passcode.
pub const SETTINGS_FILE: &str = "touch-id.json";
/// How long the passcode typed at a passcode unlock is kept in memory so the
/// "Unlock with Touch ID next time?" prompt can store it.
pub const PENDING_TTL: Duration = Duration::from_secs(120);

/// A secret the platform keeps for us (the login keychain on macOS).
pub trait SecretStore: Send + Sync {
    /// The stored passcode, or `None` when there is none.
    fn get(&self) -> Result<Option<Zeroizing<String>>, String>;
    /// Stores (replacing any previous) passcode.
    fn set(&self, secret: &str) -> Result<(), String>;
    /// Deletes the passcode. Not an error when there is none.
    fn delete(&self) -> Result<(), String>;
}

/// Whether Touch ID can be used on this Mac right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    /// The hardware is there but no finger is enrolled.
    NotEnrolled,
    /// No Touch ID (no sensor, lid closed, not macOS…).
    Unavailable,
}

/// Why a Touch ID check did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BioError {
    /// The user cancelled, chose "Use Password…", or the system cancelled.
    Cancelled,
    /// Too many failed attempts; macOS wants the login password first.
    Lockout,
    NotEnrolled,
    Unavailable,
    /// Anything else (the message is for the log, never contains secrets).
    Failed(String),
}

/// The Touch ID check. A success returns the biometric domain state, an
/// opaque value that changes when fingers are added or removed.
pub trait Biometrics: Send + Sync {
    fn availability(&self) -> Availability;
    fn authenticate(&self, reason: &str) -> impl Future<Output = Result<Vec<u8>, BioError>> + Send;
}

/// Why starting the backend with a passcode failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartFailure {
    WrongPasscode,
    Other(String),
}

/// What the UI gets back from a failed Touch ID action. Only these codes
/// cross to JS: never the passcode, never the domain state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TouchIdError {
    /// The user cancelled. The UI shows nothing.
    Cancelled,
    Lockout,
    Unavailable,
    NotEnabled,
    /// Fingerprints changed since enrolment: the passcode was deleted and the
    /// feature turned off.
    BiometryChanged,
    /// The stored passcode was missing or no longer opens the database: it was
    /// deleted and the feature turned off.
    Invalidated,
    /// No passcode from a recent unlock to store (the prompt expired).
    NoPendingPasscode,
    /// The passcode typed in Settings does not open the database.
    WrongPassword,
    Keychain(String),
    Failed(String),
}

impl TouchIdError {
    /// The string the Tauri command rejects with.
    pub fn code(&self) -> String {
        match self {
            Self::Cancelled => "cancelled".into(),
            Self::Lockout => "lockout".into(),
            Self::Unavailable => "unavailable".into(),
            Self::NotEnabled => "not_enabled".into(),
            Self::BiometryChanged => "biometry_changed".into(),
            Self::Invalidated => "invalidated".into(),
            Self::NoPendingPasscode => "no_pending_passcode".into(),
            Self::WrongPassword => "wrong_password".into(),
            // Details go to the log; the UI only needs the kind.
            Self::Keychain(_) => "keychain".into(),
            Self::Failed(_) => "failed".into(),
        }
    }
}

impl From<BioError> for TouchIdError {
    fn from(err: BioError) -> Self {
        match err {
            BioError::Cancelled => Self::Cancelled,
            BioError::Lockout => Self::Lockout,
            BioError::NotEnrolled | BioError::Unavailable => Self::Unavailable,
            BioError::Failed(msg) => Self::Failed(msg),
        }
    }
}

/// What the UI needs to show the button, the prompt and the Settings row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub availability: Availability,
    pub enabled: bool,
    /// Show "Unlock with Touch ID next time?" now: a passcode unlock just
    /// happened, Touch ID is available, the feature is off, and the user has
    /// not said "Not now".
    pub offer: bool,
}

/// `touch-id.json`. Non-secret flags only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    enabled: bool,
    /// The user chose "Not now" (or turned the feature off in Settings).
    #[serde(default)]
    declined: bool,
    /// Hex SHA-256 of the domain state at enrolment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    domain_state_sha256: Option<String>,
}

struct Pending {
    passcode: Zeroizing<String>,
    since: Instant,
}

fn hash_state(state: &[u8]) -> String {
    let digest = Sha256::digest(state);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The Touch ID feature: enable, unlock, invalidate, disable, wipe.
pub struct TouchId<S, B> {
    store: S,
    bio: B,
    settings_path: PathBuf,
    /// Serialises read-modify-write of the settings file.
    settings_lock: Mutex<()>,
    pending: Mutex<Option<Pending>>,
}

impl<S: SecretStore, B: Biometrics> TouchId<S, B> {
    pub fn new(store: S, bio: B, data_dir: &Path) -> Self {
        Self {
            store,
            bio,
            settings_path: data_dir.join(SETTINGS_FILE),
            settings_lock: Mutex::new(()),
            pending: Mutex::new(None),
        }
    }

    fn load(&self) -> Settings {
        std::fs::read(&self.settings_path)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let _guard = lock(&self.settings_lock);
        let mut settings = self.load();
        change(&mut settings);
        let raw = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&self.settings_path, raw).map_err(|e| e.to_string())
    }

    fn has_fresh_pending(&self) -> bool {
        let mut pending = lock(&self.pending);
        if pending
            .as_ref()
            .is_some_and(|p| p.since.elapsed() > PENDING_TTL)
        {
            *pending = None; // Zeroizing wipes it on drop.
        }
        pending.is_some()
    }

    fn take_pending(&self) -> Option<Zeroizing<String>> {
        let taken = lock(&self.pending).take()?;
        (taken.since.elapsed() <= PENDING_TTL).then_some(taken.passcode)
    }

    pub fn status(&self) -> Status {
        let availability = self.bio.availability();
        let settings = self.load();
        let offer = availability == Availability::Available
            && !settings.enabled
            && !settings.declined
            && self.has_fresh_pending();
        Status {
            availability,
            enabled: settings.enabled,
            offer,
        }
    }

    /// Called after the user unlocked by typing the passcode. Keeps a copy
    /// for [`PENDING_TTL`] only when the prompt will be offered.
    pub fn after_passcode_unlock(&self, passcode: &str) {
        let settings = self.load();
        let keep = !settings.enabled
            && !settings.declined
            && self.bio.availability() == Availability::Available;
        *lock(&self.pending) = keep.then(|| Pending {
            passcode: Zeroizing::new(passcode.to_owned()),
            since: Instant::now(),
        });
    }

    /// Drops the in-memory passcode if it has outlived [`PENDING_TTL`].
    pub fn expire_pending(&self) {
        self.has_fresh_pending();
    }

    /// The prompt was answered "Not now" (`remember`) or closed without an
    /// answer. Either way the in-memory passcode is wiped.
    pub fn dismiss_offer(&self, remember: bool) -> Result<(), TouchIdError> {
        *lock(&self.pending) = None;
        if remember {
            self.update(|s| s.declined = true)
                .map_err(TouchIdError::Failed)?;
        }
        Ok(())
    }

    /// "Enable" on the prompt: one Touch ID check, then store the passcode
    /// typed at the last unlock.
    pub async fn enable_from_pending(&self) -> Result<(), TouchIdError> {
        let passcode = self.take_pending().ok_or(TouchIdError::NoPendingPasscode)?;
        self.enable(passcode).await
    }

    /// Turns the feature on with a passcode the caller has already verified
    /// against the database: one Touch ID check, then store it.
    pub async fn enable(&self, passcode: Zeroizing<String>) -> Result<(), TouchIdError> {
        if self.bio.availability() != Availability::Available {
            return Err(TouchIdError::Unavailable);
        }
        let state = self.bio.authenticate(REASON).await?;
        let hash = hash_state(&state);
        // Delete first so the new item gets a fresh access list for this build.
        self.store.delete().map_err(TouchIdError::Keychain)?;
        self.store
            .set(passcode.as_str())
            .map_err(TouchIdError::Keychain)?;
        drop(passcode);
        if let Err(err) = self.update(|s| {
            s.enabled = true;
            s.declined = false;
            s.domain_state_sha256 = Some(hash);
        }) {
            let _ = self.store.delete();
            return Err(TouchIdError::Failed(err));
        }
        tracing::info!("[touch-id] enabled");
        Ok(())
    }

    /// Unlock: Touch ID check, domain-state check, read the passcode, then
    /// `start` it (the same path as a typed passcode). The passcode only ever
    /// goes to `start`.
    pub async fn unlock<F, Fut>(&self, start: F) -> Result<(), TouchIdError>
    where
        F: FnOnce(Zeroizing<String>) -> Fut,
        Fut: Future<Output = Result<(), StartFailure>>,
    {
        let settings = self.load();
        if !settings.enabled {
            return Err(TouchIdError::NotEnabled);
        }
        let state = match self.bio.authenticate(REASON).await {
            Ok(state) => state,
            Err(BioError::NotEnrolled) => {
                // Every finger was removed: the enrolled set changed.
                self.invalidate("no finger is enrolled any more");
                return Err(TouchIdError::BiometryChanged);
            }
            Err(err) => return Err(err.into()),
        };
        if settings.domain_state_sha256.as_deref() != Some(hash_state(&state).as_str()) {
            self.invalidate("the enrolled fingerprints changed");
            return Err(TouchIdError::BiometryChanged);
        }
        let passcode = match self.store.get() {
            Ok(Some(passcode)) => passcode,
            Ok(None) => {
                self.invalidate("the keychain item is missing");
                return Err(TouchIdError::Invalidated);
            }
            // E.g. the user denied the Keychain access prompt: keep the item.
            Err(err) => return Err(TouchIdError::Keychain(err)),
        };
        match start(passcode).await {
            Ok(()) => Ok(()),
            Err(StartFailure::WrongPasscode) => {
                self.invalidate("the stored passcode does not open the database");
                Err(TouchIdError::Invalidated)
            }
            Err(StartFailure::Other(msg)) => Err(TouchIdError::Failed(msg)),
        }
    }

    /// Deletes the stored passcode and turns the feature off. The prompt may
    /// be offered again after the next passcode unlock.
    fn invalidate(&self, why: &str) {
        tracing::warn!("[touch-id] turned off: {why}");
        if let Err(err) = self.store.delete() {
            tracing::error!("[touch-id] could not delete the keychain item: {err}");
        }
        if let Err(err) = self.update(|s| {
            s.enabled = false;
            s.domain_state_sha256 = None;
        }) {
            tracing::error!("[touch-id] could not save settings: {err}");
        }
    }

    /// Settings toggle off: delete the passcode and the hash, and don't offer
    /// the prompt again.
    pub fn disable(&self) -> Result<(), TouchIdError> {
        *lock(&self.pending) = None;
        self.store.delete().map_err(TouchIdError::Keychain)?;
        self.update(|s| {
            s.enabled = false;
            s.declined = true;
            s.domain_state_sha256 = None;
        })
        .map_err(TouchIdError::Failed)?;
        tracing::info!("[touch-id] disabled");
        Ok(())
    }

    /// Wipe: forget everything (keychain item and settings file).
    pub fn wipe(&self) {
        *lock(&self.pending) = None;
        if let Err(err) = self.store.delete() {
            tracing::error!("[touch-id] could not delete the keychain item: {err}");
        }
        let _guard = lock(&self.settings_lock);
        let _ = std::fs::remove_file(&self.settings_path);
    }
}

// ── Platform implementations ─────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub use macos::{Keychain as PlatformStore, LocalAuth as PlatformBiometrics};

/// Off macOS the feature reports unavailable.
#[cfg(not(target_os = "macos"))]
pub struct PlatformStore;
#[cfg(not(target_os = "macos"))]
impl PlatformStore {
    pub fn new(_service: &str, _account: &str) -> Self {
        Self
    }
}
#[cfg(not(target_os = "macos"))]
impl SecretStore for PlatformStore {
    fn get(&self) -> Result<Option<Zeroizing<String>>, String> {
        Ok(None)
    }
    fn set(&self, _secret: &str) -> Result<(), String> {
        Err("Touch ID is only available on macOS".into())
    }
    fn delete(&self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
pub struct PlatformBiometrics;
#[cfg(not(target_os = "macos"))]
impl Biometrics for PlatformBiometrics {
    fn availability(&self) -> Availability {
        Availability::Unavailable
    }
    fn authenticate(
        &self,
        _reason: &str,
    ) -> impl Future<Output = Result<Vec<u8>, BioError>> + Send {
        std::future::ready(Err(BioError::Unavailable))
    }
}

/// The real feature for this platform.
pub type PlatformTouchId = TouchId<PlatformStore, PlatformBiometrics>;

pub fn platform(data_dir: &Path) -> PlatformTouchId {
    TouchId::new(
        PlatformStore::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT),
        PlatformBiometrics,
        data_dir,
    )
}

#[cfg(test)]
mod tests;
