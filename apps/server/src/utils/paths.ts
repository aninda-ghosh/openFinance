import * as path from "node:path";

/**
 * Root directory for on-disk data the server owns — uploaded documents and AI
 * chat memories.
 *
 * These used to hang off process.cwd(), which worked for a server started from
 * its own directory but not for a packaged app: macOS launches a bundled app
 * with the working directory set to "/", so every write landed in an
 * unwritable place. The Tauri host passes DB_PATH inside the app's data
 * directory, so anchor to that instead and keep the data together. The Rust
 * side's "wipe database" removes these same two folders next to the database.
 */
export const DATA_DIR = process.env.DB_PATH
  ? path.dirname(path.resolve(process.env.DB_PATH))
  : process.cwd();
