/**
 * esbuild bundler for the Finwise server sidecar.
 * Replaces @vercel/ncc — esbuild is already available via drizzle-kit/tsx.
 *
 * Native modules (better-sqlite3) are marked external and must be present
 * alongside the bundle at runtime (copied by copy-sidecar.mjs).
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const sharedRoot = path.resolve(serverRoot, "../../packages/shared/src");

mkdirSync(path.join(serverRoot, "dist/sidecar"), { recursive: true });

await build({
  entryPoints: [path.join(serverRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(serverRoot, "dist/sidecar/index.js"),
  minify: true,
  // Resolve @finwise/shared/* to the shared package source
  alias: {
    "@finwise/shared/types": path.join(sharedRoot, "types/index.ts"),
    "@finwise/shared/schemas": path.join(sharedRoot, "schemas/index.ts"),
    "@finwise/shared/api-contracts": path.join(
      sharedRoot,
      "api-contracts/index.ts"
    ),
    "@finwise/shared/utils": path.join(sharedRoot, "utils/index.ts"),
    "@finwise/shared/utils/hash": path.join(sharedRoot, "utils/hash.ts"),
    "@finwise/shared": path.join(sharedRoot, "index.ts"),
  },
  // Mark native modules, helper libraries, and Node.js built-ins as external
  external: [
    "better-sqlite3",
    "better-sqlite3-multiple-ciphers",
    "bindings",
    "file-uri-to-path",
    "fs",
    "node:fs",
    "path",
    "node:path",
    "crypto",
    "node:crypto",
    "os",
    "node:os",
    "events",
    "node:events",
    "stream",
    "node:stream",
    "http",
    "node:http",
    "https",
    "node:https",
    "url",
    "node:url",
    "zlib",
    "node:zlib",
    "child_process",
    "node:child_process",
    "util",
    "node:util",
    "net",
    "node:net",
    "tls",
    "node:tls"
  ],
  // Suppress esbuild's "dynamic require" warning for CommonJS interop
  logOverride: {
    "commonjs-variable-in-esm": "silent",
  },
  banner: {
    js: "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);",
  },
});

console.log("Bundle written to dist/sidecar/index.js");
