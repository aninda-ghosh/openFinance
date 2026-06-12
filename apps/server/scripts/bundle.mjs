/**
 * esbuild bundler for the openFinance server.
 * Produces a fully self-contained dist/sidecar/index.js — only Node.js
 * built-ins are external, so no node_modules is needed at runtime.
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
  // Resolve @openfinance/shared/* to the shared package source
  alias: {
    "@openfinance/shared/types": path.join(sharedRoot, "types/index.ts"),
    "@openfinance/shared/schemas": path.join(sharedRoot, "schemas/index.ts"),
    "@openfinance/shared/api-contracts": path.join(
      sharedRoot,
      "api-contracts/index.ts"
    ),
    "@openfinance/shared/utils": path.join(sharedRoot, "utils/index.ts"),
    "@openfinance/shared/utils/hash": path.join(sharedRoot, "utils/hash.ts"),
    "@openfinance/shared": path.join(sharedRoot, "index.ts"),
  },
  // Mark Node.js built-ins as external — everything else (all pure-JS) is
  // bundled, so the output runs standalone with no node_modules.
  external: [
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
