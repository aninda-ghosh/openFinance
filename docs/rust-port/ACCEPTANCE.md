# Manual acceptance: the Rust backend build (Wave 4)

This is the manual acceptance checklist for the Rust backend, step by step. The new build runs the API
server inside the app (no Node sidecar). It reads and writes the same database,
uploads and chat memories as the current app, without any migration. Even so,
**back everything up first**: these steps use your real data.

Commands go in Terminal. `DATA` below is shorthand for
`~/Library/Application Support/com.anindaghosh.openfinance`.

## 0. Before you start: back up, and keep the old app

1. **Export a backup in the current app.** Open openFinance, unlock, go to
   **Settings → Backup & Restore → Export**, and save the `.ofb` file somewhere
   outside `DATA` (e.g. `~/Documents`). This is your portable copy.
2. **Quit openFinance** (⌘Q). Check that nothing is still running:
   ```bash
   pgrep -fl openFinance        # expect no output
   lsof -nP -iTCP:3001 -sTCP:LISTEN   # expect no output
   ```
   If the old sidecar is still listening, wait a few seconds and check again.
3. **Copy the data folder** while the app is closed:
   ```bash
   STAMP=$(date +%Y%m%d-%H%M)
   cp -R ~/Library/Application\ Support/com.anindaghosh.openfinance ~/openfinance-data-backup-$STAMP
   ls -la ~/openfinance-data-backup-$STAMP   # openfinance.db, uploads/, chat-memories/, …
   ```
4. **Keep the current (Node sidecar) app** so you can roll back without rebuilding:
   ```bash
   ditto /Applications/openFinance.app ~/openFinance-node-sidecar.app
   ```

## 1. Install the new build

Either build and install in one go (this quits the running app, replaces
`/Applications/openFinance.app` and opens it):
```bash
./scripts/rebuild-and-install.command
```
or build with `./scripts/build-mac.sh`, open the `.dmg` from
`apps/desktop/src-tauri/target/release/bundle/dmg/`, drag openFinance to
Applications (replace the old one), then run
`xattr -cr /Applications/openFinance.app` and open it.

Check that the app is a single binary with no Node inside:
```bash
ls /Applications/openFinance.app/Contents/MacOS          # one file: openfinance-desktop
ls /Applications/openFinance.app/Contents/Resources      # no "binaries" folder
```

## 2. Unlock, including a wrong passcode

- [ ] Type a **wrong** passcode and press Unlock. The message
      "Wrong password — the database could not be unlocked." appears **at once**
      (the old build took about 15 seconds). Press **Try again**.
- [ ] Try a wrong passcode a second time; same result.
- [ ] Type the **right** passcode. "Starting openFinance…" shows briefly, then the dashboard.
- [ ] While unlocked, only one process serves the API, and it is the app:
      ```bash
      lsof -nP -iTCP:3001 -sTCP:LISTEN   # one line, COMMAND openfinanc…, 127.0.0.1:3001
      pgrep -fl node                     # nothing from openFinance
      ```

## 3. Every page loads

Open each page and check that it shows your data and no error toast:

- [ ] Accounts
- [ ] Transactions
- [ ] Bulk Add (paste a couple of rows and preview; you don't need to save)
- [ ] Budget (envelopes, this month and the previous month)
- [ ] Investments (including a physical asset, if you have one)
- [ ] Policies (list, timeline, payouts)
- [ ] Life insurance
- [ ] Dashboard
- [ ] Net worth (history chart)
- [ ] Reports
- [ ] Documents (open one: it should open in the default viewer)
- [ ] AI chat (if Ollama is running: send a message, watch the reply stream,
      and reopen an older conversation; if it isn't, the chat should say the
      AI service is unavailable, as before)
- [ ] Settings (AI assistant settings, base currency, backup section)

## 4. Add, edit and delete a transaction

- [ ] Note an account's balance. Add a transaction to it; the balance changes by that amount.
- [ ] Edit the amount; the balance follows.
- [ ] Delete it; the balance is back to the noted value.
- [ ] The envelope it was filed under shows the spend while it exists, and not after.

## 5. Export a backup, then import it

- [ ] **Settings → Backup & Restore → Export** saves an `.ofb` file.
- [ ] Import **that same file** (import replaces all data, so only ever import
      the backup you have just exported). The app reloads with the same data:
      spot-check an account balance, a document and an AI conversation.

## 6. Quit, and check nothing is left running

- [ ] Quit with ⌘Q, then:
      ```bash
      pgrep -fl openFinance              # no output
      lsof -nP -iTCP:3001 -sTCP:LISTEN   # no output
      ls ~/Library/Application\ Support/com.anindaghosh.openfinance
      ```
      The last listing should not show `openfinance.db-wal` / `openfinance.db-shm`
      (the database was closed cleanly). If one is there, that is not data loss
      (SQLite replays it on the next unlock), but please report it.
- [ ] Reopen the app and unlock; your data is all there, including the
      changes from step 4.
- [ ] Optional: close the window with the red button instead of ⌘Q and run the
      same checks.

## 7. Check the `.dmg` size

```bash
du -h apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
du -sh /Applications/openFinance.app
```
- [ ] The `.dmg` is about 9–10 MB and the app about 25 MB. (Wave 4's build: 9.3 MB
      `.dmg`, 25 MB `.app`. The last Node sidecar build: 46 MB `.dmg`, 133 MB
      `.app`, of which the Node binary alone was 116 MB.)

## Not on real data

**Reset App / Wipe Database** on the passcode screen deletes `openfinance.db`
(and its `-wal`/`-shm`/`-journal` files), `uploads/` and `chat-memories/`, then
restarts the app. It is covered by automated tests on a temp folder
(`apps/desktop/src-tauri/tests/lifecycle.rs`). Do **not** try it on your real
data. If you want to see it work, do it only after step 8's restore is
rehearsed and you have the backup from step 0. With Touch ID on, it also
deletes the saved keychain item and `touch-id.json`.

## Touch ID (5.1.0)

Unlock with Touch ID has its own checklist: see the "Manual test checklist"
section of [`docs/TOUCH-ID.md`](../TOUCH-ID.md).

## If something is wrong: diagnose

- The backend's log is `DATA/server.log` (recreated at each launch). It holds
  startup messages, every request line and any error. It never contains your
  passcode. Attach it to the report.
- Note the page, what you did, and what you saw.

## 8. Roll back to the Node sidecar build

The database format did not change, so the old app opens whatever the new one
wrote. Roll back like this:

1. Quit openFinance (⌘Q) and check `lsof -nP -iTCP:3001 -sTCP:LISTEN` is empty.
2. Put the old app back:
   ```bash
   rm -rf /Applications/openFinance.app
   ditto ~/openFinance-node-sidecar.app /Applications/openFinance.app
   xattr -cr /Applications/openFinance.app
   ```
   No saved copy? Rebuild it from the last sidecar release. The Node server
   (`apps/server`) no longer exists on this branch, but `main` (or `v4.3.0`,
   commit `1502e08`) still has it and still builds: in a separate clone or
   worktree, `git checkout 1502e08` and run `./scripts/build-mac.sh` there; it
   needs Node 22+ and downloads the Node runtime.
3. If the data itself looks wrong, restore the folder copy from step 0 (the app
   must be closed):
   ```bash
   mv ~/Library/Application\ Support/com.anindaghosh.openfinance ~/openfinance-data-rejected
   cp -R ~/openfinance-data-backup-<STAMP> ~/Library/Application\ Support/com.anindaghosh.openfinance
   ```
   Or, in the old app, import the `.ofb` exported in step 0.
4. Open the app, unlock, and check the data.
