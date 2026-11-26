//! The real macOS implementations: the login keychain (`security-framework`)
//! and LocalAuthentication (`objc2-local-authentication`). All `unsafe` FFI of
//! the Touch ID feature is in this file, behind the safe [`SecretStore`] and
//! [`Biometrics`] traits.
//!
//! Remember: the Keychain item has no biometric access control (an ad-hoc
//! signed app can't create one). The Touch ID check below is enforced by the
//! app before it reads the item.

use std::future::Future;
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};
use security_framework::passwords;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use super::{Availability, BioError, Biometrics, SecretStore};

/// `errSecItemNotFound`.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

// LAError codes (LAError.h). Raw values, as some of the generated constants
// are deprecated aliases.
const LA_AUTHENTICATION_FAILED: isize = -1;
const LA_USER_CANCEL: isize = -2;
const LA_USER_FALLBACK: isize = -3;
const LA_SYSTEM_CANCEL: isize = -4;
const LA_BIOMETRY_NOT_AVAILABLE: isize = -6;
const LA_BIOMETRY_NOT_ENROLLED: isize = -7;
const LA_BIOMETRY_LOCKOUT: isize = -8;
const LA_APP_CANCEL: isize = -9;

const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;

/// A generic password in the login keychain.
pub struct Keychain {
    service: String,
    account: String,
}

impl Keychain {
    pub fn new(service: &str, account: &str) -> Self {
        Self {
            service: service.to_owned(),
            account: account.to_owned(),
        }
    }
}

impl SecretStore for Keychain {
    fn get(&self) -> Result<Option<Zeroizing<String>>, String> {
        match passwords::get_generic_password(&self.service, &self.account) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| "the stored passcode is not UTF-8".to_string())?;
                Ok(Some(Zeroizing::new(text.to_owned())))
            }
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(err) => Err(format!("keychain read failed ({})", err.code())),
        }
    }

    fn set(&self, secret: &str) -> Result<(), String> {
        passwords::set_generic_password(&self.service, &self.account, secret.as_bytes())
            .map_err(|err| format!("keychain write failed ({})", err.code()))
    }

    fn delete(&self) -> Result<(), String> {
        match passwords::delete_generic_password(&self.service, &self.account) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(err) => Err(format!("keychain delete failed ({})", err.code())),
        }
    }
}

fn map_error(code: isize) -> BioError {
    match code {
        LA_USER_CANCEL | LA_USER_FALLBACK | LA_SYSTEM_CANCEL | LA_APP_CANCEL => BioError::Cancelled,
        LA_BIOMETRY_LOCKOUT => BioError::Lockout,
        LA_BIOMETRY_NOT_ENROLLED => BioError::NotEnrolled,
        LA_BIOMETRY_NOT_AVAILABLE => BioError::Unavailable,
        LA_AUTHENTICATION_FAILED => BioError::Failed("authentication failed".into()),
        other => BioError::Failed(format!("LAError {other}")),
    }
}

fn new_context() -> Retained<LAContext> {
    // SAFETY: `+[LAContext new]` has no preconditions.
    unsafe { LAContext::new() }
}

/// A fresh context that has passed `canEvaluatePolicy` for Touch ID.
fn checked_context() -> Result<Retained<LAContext>, BioError> {
    let context = new_context();
    // SAFETY: a valid context and a valid policy value; called outside any
    // reply block (Apple warns that can deadlock).
    unsafe { context.canEvaluatePolicy_error(POLICY) }.map_err(|err| map_error(err.code()))?;
    Ok(context)
}

/// Touch ID through LocalAuthentication.
pub struct LocalAuth;

impl Biometrics for LocalAuth {
    fn availability(&self) -> Availability {
        match checked_context() {
            Ok(_) => Availability::Available,
            // Locked out still means a sensor with enrolled fingers.
            Err(BioError::Lockout) => Availability::Available,
            Err(BioError::NotEnrolled) => Availability::NotEnrolled,
            Err(_) => Availability::Unavailable,
        }
    }

    fn authenticate(&self, reason: &str) -> impl Future<Output = Result<Vec<u8>, BioError>> + Send {
        let started = start(reason);
        async move {
            let (state, reply) = started?;
            reply
                .await
                .map_err(|_| BioError::Failed("no reply from LocalAuthentication".into()))??;
            Ok(state)
        }
    }
}

type Reply = oneshot::Receiver<Result<(), BioError>>;

/// Starts a Touch ID evaluation without blocking. Returns the domain state
/// (read after `canEvaluatePolicy`, when Apple documents it as set) and a
/// receiver for the result.
fn start(reason: &str) -> Result<(Vec<u8>, Reply), BioError> {
    let context = checked_context()?;

    // `evaluatedPolicyDomainState` is deprecated in macOS 15 in favour of
    // `domainState.biometry.stateHash`, which doesn't exist on older macOS.
    // The deprecated property still works everywhere.
    #[allow(deprecated)]
    // SAFETY: a plain property read on a valid context.
    let state = unsafe { context.evaluatedPolicyDomainState() }
        .map(|data| data.to_vec())
        .ok_or_else(|| BioError::Failed("no biometric domain state".into()))?;

    let (tx, rx) = oneshot::channel();
    let tx = Mutex::new(Some(tx));
    // The block holds a strong reference to the context: Apple cancels the
    // evaluation if the context is deallocated, and the block lives until the
    // framework has called it.
    let keep_alive = context.clone();
    let block = RcBlock::new(move |success: Bool, error: *mut NSError| {
        let _ = &keep_alive;
        let result = if success.as_bool() {
            Ok(())
        } else {
            // SAFETY: LocalAuthentication passes either nil or a valid NSError
            // that lives for the duration of the call.
            let code = unsafe { error.as_ref() }.map_or(LA_AUTHENTICATION_FAILED, |e| e.code());
            Err(map_error(code))
        };
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(result);
        }
    });
    let reason = NSString::from_str(reason);
    // SAFETY: the reason is a non-empty NSString. The reply block is
    // "sendable" as required: it runs on a private LocalAuthentication queue
    // and only touches a Mutex-protected oneshot sender (Send) and the
    // retained context, whose retain/release is thread-safe and which is not
    // otherwise used from the block.
    unsafe { context.evaluatePolicy_localizedReason_reply(POLICY, &reason, &block) };
    Ok((state, rx))
}
