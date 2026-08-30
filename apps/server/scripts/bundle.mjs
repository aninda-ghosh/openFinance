/**
 * esbuild bundler for the openFinance server.
 *
 * Produces dist/sidecar/index.js — a single file containing every pure-JS
 * dependency — plus a minimal dist/sidecar/node_modules holding the one
 * dependency that cannot be bundled: the better-sqlite3-multiple-ciphers
 * native addon. Node built-ins are external automatically (platform: "node").
 *
 * The result runs under a bare Node binary with no install step, which is what
 * the Tauri sidecar does inside the packaged .app.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const sharedRoot = path.resolve(serverRoot, "../../packages/shared/src");
const outDir = path.join(serverRoot, "dist/sidecar");

// Installed as an npm alias for better-sqlite3-multiple-ciphers.
// The native addon is loaded through `bindings`, which walks up from
// lib/database.js looking for build/Release/*.node — so the package has to stay
// a real directory on disk rather than being inlined into the bundle.
const NATIVE_PACKAGE = "better-sqlite3";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(serverRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(outDir, "index.js"),
  minify: true,
  // Resolve @openfinance/shared/* to the shared package source
  alias: {
    "@openfinance/shared/types": path.join(sharedRoot, "types/index.ts"),
    "@openfinance/shared/schemas": path.join(sharedRoot, "schemas/index.ts"),
    "@openfinance/shared/constants": path.join(
      sharedRoot,
      "constants/index.ts"
    ),
    "@openfinance/shared/api-contracts": path.join(
      sharedRoot,
      "api-contracts/index.ts"
    ),
    "@openfinance/shared/utils": path.join(sharedRoot, "utils/index.ts"),
    "@openfinance/shared/utils/hash": path.join(sharedRoot, "utils/hash.ts"),
    // NOTE: no bare "@openfinance/shared" alias — esbuild aliases also match
    // subpaths, so it would swallow every "@openfinance/shared/*" import that
    // is not listed above and rewrite it to <sharedRoot>/index.ts/<subpath>
    // (a file that does not exist). The package has no root export anyway.
  },
  // Node built-ins are external by virtue of platform: "node". The native
  // addon is external because it is a .node binary, not JavaScript.
  external: [NATIVE_PACKAGE],
  // Suppress esbuild's "dynamic require" warning for CommonJS interop
  logOverride: {
    "commonjs-variable-in-esm": "silent",
  },
  banner: {
    js: "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);",
  },
});

// ── Stage the native addon next to the bundle ─────────────────────────────────
// Resolution goes through Node itself rather than guessing at directory
// layouts: pnpm keeps transitive dependencies in a virtual store instead of
// hoisting them, so `bindings` is not sitting in apps/server/node_modules.

/** Directory of the package that owns `entry`, found by walking up to its package.json. */
function packageDirOf(entry) {
  let dir = path.dirname(entry);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find the package directory for ${entry}`);
    }
    dir = parent;
  }
}

const requireFromServer = createRequire(path.join(serverRoot, "package.json"));

let addonEntry;
try {
  addonEntry = requireFromServer.resolve(NATIVE_PACKAGE);
} catch {
  throw new Error(
    `Could not resolve ${NATIVE_PACKAGE}. Run \`pnpm install\` before bundling.`
  );
}

// `bindings` and `file-uri-to-path` are resolved from the addon's own location,
// which is where a pnpm install puts them.
const requireFromAddon = createRequire(addonEntry);
const packageDirs = {
  [NATIVE_PACKAGE]: packageDirOf(addonEntry),
  bindings: packageDirOf(requireFromAddon.resolve("bindings")),
};
const requireFromBindings = createRequire(requireFromAddon.resolve("bindings"));
packageDirs["file-uri-to-path"] = packageDirOf(
  requireFromBindings.resolve("file-uri-to-path")
);

// A flat node_modules is enough: better-sqlite3 requires bindings, which
// requires file-uri-to-path, and each walks up into this same directory.
for (const [name, from] of Object.entries(packageDirs)) {
  const to = path.join(outDir, "node_modules", name);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    // deps/ and src/ are the SQLite and addon C sources (~14 MB) — needed to
    // compile the addon, never to run it.
    filter: (src) =>
      !src.includes(`${path.sep}deps${path.sep}`) &&
      !src.includes(`${path.sep}src${path.sep}`),
  });
}

const addon = path.join(
  outDir,
  "node_modules",
  NATIVE_PACKAGE,
  "build/Release/better_sqlite3.node"
);
if (!existsSync(addon)) {
  throw new Error(
    `The ${NATIVE_PACKAGE} native addon is missing at ${addon}.\n` +
      "Reinstall it so its prebuilt binary is fetched for this platform."
  );
}

console.log(`Bundle written to ${path.relative(serverRoot, outDir)}/index.js`);
console.log(`Native addon staged at ${path.relative(serverRoot, addon)}`);
