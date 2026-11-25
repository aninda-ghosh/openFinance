# Unlock with Touch ID

openFinance can unlock with your fingerprint instead of your password. It is
off until you turn it on.

## Turning it on and off

- **After you unlock with your password**, a small prompt asks
  "Unlock with Touch ID next time?". **Enable** asks for your fingerprint once
  and saves the password you just typed. **Not now** hides the prompt for good
  (you can still turn it on in Settings). Closing the prompt without choosing
  asks again next time.
  The prompt only appears when the Mac has Touch ID with at least one finger
  enrolled.
- **Settings → Session Security → Unlock with Touch ID** is an on/off switch.
  Turning it on asks for your password (checked against the database), then
  your fingerprint. Turning it off deletes the saved password. Without Touch ID
  hardware or enrolled fingers the switch is disabled and says why.

When it is on, the unlock screen asks for your fingerprint by itself when it
appears (at launch, after the 5-minute auto-lock and after locking by hand) and
has an **Unlock with Touch ID** button. Cancelling just leaves the password
field ready to type.

## How it works

1. The password is saved as a normal **generic password in your login
   keychain**: service `com.anindaghosh.openfinance`, account `db-passcode`.
   You can see it in Keychain Access.
2. Before reading it, the app asks macOS for a Touch ID match
   (LocalAuthentication, `LAPolicyDeviceOwnerAuthenticationWithBiometrics`,
   reason "unlock openFinance").
3. On a match the Rust side reads the password and opens the database the
   same way a typed password does. The password never goes back to the UI.

Non-secret settings live in `touch-id.json` in the app data folder
(`~/Library/Application Support/com.anindaghosh.openfinance/`): whether the
feature is on, whether you chose "Not now", and a SHA-256 hash of the Touch ID
"domain state" (see below). The password is never written there or to the log.

After a password unlock, the password you typed is kept in memory (Rust only)
for at most two minutes so the prompt can save it; it is wiped as soon as you
answer or close the prompt.

### Honest security note

The fingerprint check is **enforced by the app, not by the Keychain**.

The strongest setup would be a Keychain item that macOS itself refuses to
release without a fingerprint (`kSecAccessControlBiometryCurrentSet`). Those
items need a signed app with an Apple Developer team ID and the
keychain-access-groups entitlement, which this build doesn't have.

So the saved password is protected like any other login-keychain password:
it is encrypted with your login password and released only to the app that
created it, and macOS asks you before giving it to any other app. Malware
running as your user that you allow through that prompt, or that can control
openFinance itself, could get the password without your fingerprint. If that
is a concern, leave Touch ID off.

### Fingerprint changes turn it off

When you turn it on, the app records a hash of LocalAuthentication's
`evaluatedPolicyDomainState`, a value that changes whenever fingers are added
or removed. If it differs at unlock time, the app deletes the saved password,
turns Touch ID off and asks for your password with a one-line explanation. You
can turn it on again afterwards. This imitates what `BiometryCurrentSet` does
for signed apps. (Apple notes the value can also change across major macOS
updates; then you simply get asked for your password once.)

The saved password is also deleted and the feature turned off when it no longer
opens the database, or when the keychain item has gone missing.

## Keychain prompts after rebuilding

The keychain lets the app that saved an item read it without asking. macOS
recognises "the same app" by its code signature. A locally built openFinance is
unsigned or ad-hoc signed, so **every rebuild looks like a different app**, and
macOS may show "openFinance wants to use your confidential information stored
in "com.anindaghosh.openfinance" in your keychain" the first time you use
Touch ID after updating. Choose **Always Allow** (enter your login password),
or **Deny** and type your password instead (Touch ID stays on and is tried
again next time).

To avoid the prompt, sign every build with the same self-made certificate.

### Optional: a stable local signing identity

You only do this once. It creates a certificate that is trusted only for code
signing, only on this Mac.

1. Open **Keychain Access** → menu **Keychain Access → Certificate Assistant →
   Create a Certificate…**
2. Name: `openFinance Local`. Identity Type: **Self Signed Root**. Certificate
   Type: **Code Signing**. Click **Create**, then **Done**. It is saved in your
   login keychain.
3. Check it is usable:
   ```bash
   security find-identity -v -p codesigning   # lists "openFinance Local"
   ```
   If it is listed as not valid (`CSSMERR_TP_NOT_TRUSTED`), open the certificate
   in Keychain Access, expand **Trust**, set **Code Signing** to **Always
   Trust**, close the window and enter your password.
4. Build with it:
   ```bash
   CODESIGN_IDENTITY="openFinance Local" ./scripts/build-mac.sh
   ```
   The script signs the `.app` and puts the signed app in the `.dmg`. Without
   `CODESIGN_IDENTITY` the build is exactly as before.

The first launch after switching to the signed build asks once more (the
signature changed one last time); choose **Always Allow**. Later rebuilds signed
with the same certificate don't ask. This certificate does not make the app
trusted by Gatekeeper on other Macs; it is only for your own builds.

## Resetting it

- **Turn it off** in Settings. This deletes the keychain item and the hash.
- **Reset App / Wipe Database** also deletes the keychain item and
  `touch-id.json`.
- By hand, with openFinance quit:
  ```bash
  security delete-generic-password -s com.anindaghosh.openfinance -a db-passcode
  rm ~/Library/Application\ Support/com.anindaghosh.openfinance/touch-id.json
  ```

## Manual test checklist

Use a Mac with Touch ID. Back up first (see `docs/rust-port/ACCEPTANCE.md`
section 0).

**Opt-in after a password unlock**
- [ ] Fresh state (no `touch-id.json`). Unlock with your password: the prompt
      "Unlock with Touch ID next time?" appears.
- [ ] Click **Not now**. Lock (or quit and reopen) and unlock with the password:
      no prompt. `touch-id.json` has `"declined": true` and no password.
- [ ] Delete `touch-id.json` (app quit), unlock: prompt again. Let it close by
      itself after 30 s; unlock again: prompt again.
- [ ] Click **Enable**, cancel the Touch ID dialog: "Touch ID is off. You can
      turn it on in Settings." Nothing saved
      (`security find-generic-password -s com.anindaghosh.openfinance -a db-passcode`
      → "could not be found").
- [ ] Unlock with the password, **Enable**, touch the sensor: "Touch ID is on."
      The keychain item exists. Settings shows the switch on.

**Unlock**
- [ ] Quit and reopen: the Touch ID dialog appears by itself; touch the sensor:
      the app opens.
- [ ] Lock by hand (shortcut): Touch ID dialog appears; cancel it: no error
      text, the password field works, **Unlock with Touch ID** button retries.
- [ ] Wait 5 minutes for auto-lock: Touch ID dialog appears by itself.
- [ ] Wrong finger several times until macOS gives up: a short message, password
      still works.
- [ ] After a rebuild (unsigned): the keychain prompt appears once; **Always
      Allow** unlocks. Repeat with **Deny**: "Couldn't read the saved password",
      password works, Touch ID still on.

**Safety**
- [ ] Add a fingerprint in System Settings → Touch ID & Password, then unlock
      with Touch ID: "Your fingerprints changed, so Touch ID was turned off.
      Enter your password." The keychain item is gone; Settings shows it off.
      The prompt is offered after the password unlock.
- [ ] Re-enable, then remove that extra fingerprint: same result.
- [ ] Re-enable, then, with the app quit, replace the keychain item with a wrong
      password:
      `security add-generic-password -U -s com.anindaghosh.openfinance -a db-passcode -w wrong-password`.
      Open the app, touch the sensor: "Touch ID was turned off. Enter your
      password." The item is deleted.

**Settings**
- [ ] Switch on with a wrong password: "That password is wrong." Nothing saved.
- [ ] Switch on with the right password, touch the sensor: on. The app keeps
      working while this happens (no reload, no lost page).
- [ ] Switch off: the keychain item and the hash are deleted; no prompt after
      the next password unlock.
- [ ] On a Mac without Touch ID (or with no fingers enrolled) the switch is
      disabled with a one-line reason, and no prompt or button appears.

**Wipe**
- [ ] With Touch ID on, Reset App / Wipe Database: after the restart the keychain
      item and `touch-id.json` are gone, and there is no Touch ID button.

**Logs**
- [ ] `grep -i "<your password>" ~/Library/Application\ Support/com.anindaghosh.openfinance/server.log`
      finds nothing.

**Stable signing (optional)**
- [ ] Create "openFinance Local" as above, build with
      `CODESIGN_IDENTITY="openFinance Local" ./scripts/build-mac.sh`,
      `codesign -dvv /Applications/openFinance.app` shows
      `Authority=openFinance Local`. After one **Always Allow**, a second signed
      rebuild unlocks with Touch ID without a keychain prompt.
