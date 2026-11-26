//! Every branch of the Touch ID logic, with in-memory fakes. Nothing here
//! touches the real Keychain, LocalAuthentication or the real data folder.

use std::future::Future;
use std::sync::{Arc, Mutex};

use zeroize::Zeroizing;

use super::*;

const PASSCODE: &str = "correct horse battery";
const STATE: &[u8] = b"fingers-v1";

#[derive(Clone, Default)]
struct FakeStore {
    secret: Arc<Mutex<Option<String>>>,
    fail_get: Arc<Mutex<bool>>,
}

impl FakeStore {
    fn stored(&self) -> Option<String> {
        self.secret.lock().unwrap().clone()
    }
}

impl SecretStore for FakeStore {
    fn get(&self) -> Result<Option<Zeroizing<String>>, String> {
        if *self.fail_get.lock().unwrap() {
            return Err("denied".into());
        }
        Ok(self.secret.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn set(&self, secret: &str) -> Result<(), String> {
        *self.secret.lock().unwrap() = Some(secret.to_owned());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.secret.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Clone)]
struct FakeBio {
    availability: Arc<Mutex<Availability>>,
    next: Arc<Mutex<Result<Vec<u8>, BioError>>>,
    calls: Arc<Mutex<u32>>,
}

impl FakeBio {
    fn new() -> Self {
        Self {
            availability: Arc::new(Mutex::new(Availability::Available)),
            next: Arc::new(Mutex::new(Ok(STATE.to_vec()))),
            calls: Arc::new(Mutex::new(0)),
        }
    }
    fn answer(&self, result: Result<Vec<u8>, BioError>) {
        *self.next.lock().unwrap() = result;
    }
    fn calls(&self) -> u32 {
        *self.calls.lock().unwrap()
    }
}

impl Biometrics for FakeBio {
    fn availability(&self) -> Availability {
        *self.availability.lock().unwrap()
    }
    fn authenticate(&self, reason: &str) -> impl Future<Output = Result<Vec<u8>, BioError>> + Send {
        assert_eq!(reason, "unlock openFinance");
        *self.calls.lock().unwrap() += 1;
        std::future::ready(self.next.lock().unwrap().clone())
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    store: FakeStore,
    bio: FakeBio,
    touch_id: TouchId<FakeStore, FakeBio>,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = FakeStore::default();
    let bio = FakeBio::new();
    let touch_id = TouchId::new(store.clone(), bio.clone(), dir.path());
    Harness {
        _dir: dir,
        store,
        bio,
        touch_id,
    }
}

fn block_on<F: Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(f)
}

/// A backend stand-in: opens only with `correct`, and records what it got.
fn starter(
    correct: &'static str,
    seen: Arc<Mutex<Option<String>>>,
) -> impl FnOnce(Zeroizing<String>) -> std::future::Ready<Result<(), StartFailure>> {
    move |passcode| {
        *seen.lock().unwrap() = Some(passcode.to_string());
        std::future::ready(if passcode.as_str() == correct {
            Ok(())
        } else {
            Err(StartFailure::WrongPasscode)
        })
    }
}

fn enrolled() -> Harness {
    let h = harness();
    h.touch_id.after_passcode_unlock(PASSCODE);
    block_on(h.touch_id.enable_from_pending()).unwrap();
    h
}

#[test]
fn offers_after_a_passcode_unlock_only_when_it_makes_sense() {
    let h = harness();
    assert!(!h.touch_id.status().offer, "nothing before an unlock");
    h.touch_id.after_passcode_unlock(PASSCODE);
    let status = h.touch_id.status();
    assert!(status.offer);
    assert!(!status.enabled);
    assert_eq!(status.availability, Availability::Available);

    for availability in [Availability::NotEnrolled, Availability::Unavailable] {
        let h = harness();
        *h.bio.availability.lock().unwrap() = availability;
        h.touch_id.after_passcode_unlock(PASSCODE);
        assert!(!h.touch_id.status().offer);
        assert!(h.touch_id.take_pending().is_none(), "not even kept");
    }
}

#[test]
fn enable_from_the_prompt_stores_the_typed_passcode() {
    let h = harness();
    h.touch_id.after_passcode_unlock(PASSCODE);
    block_on(h.touch_id.enable_from_pending()).unwrap();
    assert_eq!(h.bio.calls(), 1, "one Touch ID check");
    assert_eq!(h.store.stored().as_deref(), Some(PASSCODE));
    let status = h.touch_id.status();
    assert!(status.enabled);
    assert!(!status.offer);
    // The pending copy is gone, and the settings file holds only a hash.
    assert!(h.touch_id.take_pending().is_none());
    let file = std::fs::read_to_string(&h.touch_id.settings_path).unwrap();
    assert!(!file.contains(PASSCODE));
    assert!(!file.contains("fingers-v1"));
    assert!(file.contains(&hash_state(STATE)));
}

#[test]
fn enable_without_a_recent_unlock_is_refused() {
    let h = harness();
    assert_eq!(
        block_on(h.touch_id.enable_from_pending()),
        Err(TouchIdError::NoPendingPasscode)
    );
    assert_eq!(h.bio.calls(), 0);
}

#[test]
fn cancelling_enrolment_stores_nothing() {
    let h = harness();
    h.touch_id.after_passcode_unlock(PASSCODE);
    h.bio.answer(Err(BioError::Cancelled));
    assert_eq!(
        block_on(h.touch_id.enable_from_pending()),
        Err(TouchIdError::Cancelled)
    );
    assert_eq!(h.store.stored(), None);
    assert!(!h.touch_id.status().enabled);
    assert!(h.touch_id.take_pending().is_none(), "wiped even on cancel");
}

#[test]
fn enable_from_settings_uses_the_given_passcode() {
    let h = harness();
    block_on(h.touch_id.enable(Zeroizing::new(PASSCODE.into()))).unwrap();
    assert_eq!(h.store.stored().as_deref(), Some(PASSCODE));
    assert!(h.touch_id.status().enabled);
}

#[test]
fn enable_is_refused_without_touch_id() {
    let h = harness();
    *h.bio.availability.lock().unwrap() = Availability::NotEnrolled;
    assert_eq!(
        block_on(h.touch_id.enable(Zeroizing::new(PASSCODE.into()))),
        Err(TouchIdError::Unavailable)
    );
    assert_eq!(h.store.stored(), None);
}

#[test]
fn unlock_success_passes_the_stored_passcode_to_the_backend_only() {
    let h = enrolled();
    let seen = Arc::new(Mutex::new(None));
    let result = block_on(h.touch_id.unlock(starter(PASSCODE, seen.clone())));
    assert_eq!(result, Ok(()));
    assert_eq!(seen.lock().unwrap().as_deref(), Some(PASSCODE));
    assert!(h.touch_id.status().enabled);
    assert_eq!(h.store.stored().as_deref(), Some(PASSCODE));
}

#[test]
fn unlock_cancel_leaves_everything_in_place() {
    let h = enrolled();
    h.bio.answer(Err(BioError::Cancelled));
    let seen = Arc::new(Mutex::new(None));
    let result = block_on(h.touch_id.unlock(starter(PASSCODE, seen.clone())));
    assert_eq!(result, Err(TouchIdError::Cancelled));
    assert_eq!(seen.lock().unwrap().as_deref(), None, "backend not started");
    assert!(h.touch_id.status().enabled);
    assert_eq!(h.store.stored().as_deref(), Some(PASSCODE));
}

#[test]
fn unlock_lockout_and_unavailable_keep_the_feature() {
    for (bio, expected) in [
        (BioError::Lockout, TouchIdError::Lockout),
        (BioError::Unavailable, TouchIdError::Unavailable),
        (
            BioError::Failed("x".into()),
            TouchIdError::Failed("x".into()),
        ),
    ] {
        let h = enrolled();
        h.bio.answer(Err(bio));
        let seen = Arc::new(Mutex::new(None));
        assert_eq!(
            block_on(h.touch_id.unlock(starter(PASSCODE, seen))),
            Err(expected)
        );
        assert!(h.touch_id.status().enabled);
        assert_eq!(h.store.stored().as_deref(), Some(PASSCODE));
    }
}

#[test]
fn changed_fingerprints_invalidate() {
    let h = enrolled();
    h.bio.answer(Ok(b"fingers-v2".to_vec()));
    let seen = Arc::new(Mutex::new(None));
    let result = block_on(h.touch_id.unlock(starter(PASSCODE, seen.clone())));
    assert_eq!(result, Err(TouchIdError::BiometryChanged));
    assert_eq!(seen.lock().unwrap().as_deref(), None, "passcode never read");
    assert_eq!(h.store.stored(), None, "passcode deleted");
    let status = h.touch_id.status();
    assert!(!status.enabled);
    // Can be offered again after the next passcode unlock.
    h.touch_id.after_passcode_unlock(PASSCODE);
    assert!(h.touch_id.status().offer);
}

#[test]
fn removing_every_finger_invalidates() {
    let h = enrolled();
    h.bio.answer(Err(BioError::NotEnrolled));
    let seen = Arc::new(Mutex::new(None));
    assert_eq!(
        block_on(h.touch_id.unlock(starter(PASSCODE, seen))),
        Err(TouchIdError::BiometryChanged)
    );
    assert_eq!(h.store.stored(), None);
    assert!(!h.touch_id.status().enabled);
}

#[test]
fn wrong_stored_passcode_invalidates() {
    let h = enrolled();
    let seen = Arc::new(Mutex::new(None));
    let result = block_on(h.touch_id.unlock(starter("a newer passcode", seen.clone())));
    assert_eq!(result, Err(TouchIdError::Invalidated));
    assert_eq!(h.store.stored(), None);
    assert!(!h.touch_id.status().enabled);
}

#[test]
fn missing_keychain_item_invalidates() {
    let h = enrolled();
    h.store.delete().unwrap();
    let seen = Arc::new(Mutex::new(None));
    assert_eq!(
        block_on(h.touch_id.unlock(starter(PASSCODE, seen))),
        Err(TouchIdError::Invalidated)
    );
    assert!(!h.touch_id.status().enabled);
}

#[test]
fn keychain_read_error_keeps_the_item() {
    let h = enrolled();
    *h.store.fail_get.lock().unwrap() = true;
    let seen = Arc::new(Mutex::new(None));
    let result = block_on(h.touch_id.unlock(starter(PASSCODE, seen)));
    assert_eq!(result.map_err(|e| e.code()), Err("keychain".to_string()));
    assert!(h.touch_id.status().enabled);
    *h.store.fail_get.lock().unwrap() = false;
    assert_eq!(h.store.stored().as_deref(), Some(PASSCODE));
}

#[test]
fn other_start_failures_keep_the_feature() {
    let h = enrolled();
    let result =
        block_on(h.touch_id.unlock(|_passcode| {
            std::future::ready(Err(StartFailure::Other("port in use".into())))
        }));
    assert_eq!(result, Err(TouchIdError::Failed("port in use".into())));
    assert!(h.touch_id.status().enabled);
}

#[test]
fn unlock_when_off_does_not_prompt() {
    let h = harness();
    let seen = Arc::new(Mutex::new(None));
    assert_eq!(
        block_on(h.touch_id.unlock(starter(PASSCODE, seen))),
        Err(TouchIdError::NotEnabled)
    );
    assert_eq!(h.bio.calls(), 0);
}

#[test]
fn disable_deletes_the_passcode_and_hash() {
    let h = enrolled();
    h.touch_id.disable().unwrap();
    assert_eq!(h.store.stored(), None);
    assert!(!h.touch_id.status().enabled);
    let file = std::fs::read_to_string(&h.touch_id.settings_path).unwrap();
    assert!(!file.contains("domain_state_sha256"));
    // Turned off on purpose: don't nag after the next unlock.
    h.touch_id.after_passcode_unlock(PASSCODE);
    assert!(!h.touch_id.status().offer);
}

#[test]
fn wipe_forgets_everything() {
    let h = enrolled();
    h.touch_id.dismiss_offer(true).unwrap();
    h.touch_id.wipe();
    assert_eq!(h.store.stored(), None);
    assert!(!h.touch_id.settings_path.exists());
    let status = h.touch_id.status();
    assert!(!status.enabled);
    // "Not now" was forgotten too.
    h.touch_id.after_passcode_unlock(PASSCODE);
    assert!(h.touch_id.status().offer);
}

#[test]
fn not_now_is_remembered() {
    let h = harness();
    h.touch_id.after_passcode_unlock(PASSCODE);
    h.touch_id.dismiss_offer(true).unwrap();
    assert!(!h.touch_id.status().offer);
    assert!(h.touch_id.take_pending().is_none(), "passcode wiped");
    // Survives a restart (a new instance on the same folder).
    let again = TouchId::new(h.store.clone(), h.bio.clone(), h._dir.path());
    again.after_passcode_unlock(PASSCODE);
    assert!(!again.status().offer);
    assert!(again.take_pending().is_none());
}

#[test]
fn closing_the_prompt_without_answering_does_not_remember() {
    let h = harness();
    h.touch_id.after_passcode_unlock(PASSCODE);
    h.touch_id.dismiss_offer(false).unwrap();
    assert!(!h.touch_id.status().offer);
    h.touch_id.after_passcode_unlock(PASSCODE);
    assert!(h.touch_id.status().offer, "asked again next time");
}

#[test]
fn pending_passcode_expires() {
    let h = harness();
    h.touch_id.after_passcode_unlock(PASSCODE);
    if let Some(p) = h.touch_id.pending.lock().unwrap().as_mut() {
        p.since = Instant::now() - PENDING_TTL - Duration::from_secs(1);
    }
    h.touch_id.expire_pending();
    assert!(h.touch_id.pending.lock().unwrap().is_none());
    assert_eq!(
        block_on(h.touch_id.enable_from_pending()),
        Err(TouchIdError::NoPendingPasscode)
    );
}

#[test]
fn the_passcode_never_reaches_the_ui_layer() {
    // Everything that crosses to JS is a `Status` (JSON) or an error code.
    let mut outputs = Vec::new();
    let h = harness();
    h.touch_id.after_passcode_unlock(PASSCODE);
    outputs.push(serde_json::to_string(&h.touch_id.status()).unwrap());
    block_on(h.touch_id.enable_from_pending()).unwrap();
    outputs.push(serde_json::to_string(&h.touch_id.status()).unwrap());
    let seen = Arc::new(Mutex::new(None));
    for answer in [
        Err(BioError::Cancelled),
        Ok(STATE.to_vec()),
        Ok(b"fingers-v2".to_vec()),
    ] {
        h.bio.answer(answer);
        if let Err(err) = block_on(h.touch_id.unlock(starter("other", seen.clone()))) {
            outputs.push(err.code());
        }
        outputs.push(serde_json::to_string(&h.touch_id.status()).unwrap());
    }
    for output in &outputs {
        assert!(!output.contains(PASSCODE), "{output}");
        assert!(!output.contains("fingers"), "{output}");
    }
    // Error details (logged, not shown) also never carry secrets by
    // construction: the codes are fixed strings.
    for err in [
        TouchIdError::Keychain(PASSCODE.into()),
        TouchIdError::Failed(PASSCODE.into()),
    ] {
        assert!(!err.code().contains(PASSCODE));
    }
}
