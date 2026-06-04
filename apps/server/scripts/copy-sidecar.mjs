/**
 * Universal sidecar bundler.
 * Copies the native host Node.js binary and downloads/extracts the alternative
 * macOS architecture binary (Intel or Apple Silicon) from nodejs.org, storing
 * both inside apps/desktop/src-tauri/binaries/ to enable Universal macOS builds.
 */

import { execSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const desktopRoot = path.resolve(serverRoot, "../desktop");
const binariesDir = path.resolve(desktopRoot, "src-tauri/binaries");

// 1. Copy the esbuild bundle into binaries/server-bundle/
const bundleDir = path.join(binariesDir, "server-bundle");
if (existsSync(bundleDir)) rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
cpSync(path.resolve(serverRoot, "dist/sidecar"), bundleDir, { recursive: true, dereference: true });
console.log(`Copied server bundle → ${bundleDir}`);

// Copy native Node packages (better-sqlite3-multiple-ciphers and helpers)
const nativePkgs = [
  "better-sqlite3-multiple-ciphers",
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
];
const nodeModulesOut = path.join(bundleDir, "node_modules");
mkdirSync(nodeModulesOut, { recursive: true });

for (const pkg of nativePkgs) {
  const candidates = [
    path.resolve(serverRoot, "node_modules", pkg),
    path.resolve(serverRoot, "../../node_modules", pkg),
  ];
  const pnpmStore = path.resolve(serverRoot, "../../node_modules/.pnpm");
  if (existsSync(pnpmStore)) {
    const storeEntries = (await import("node:fs"))
      .readdirSync(pnpmStore)
      .filter((d) => d.startsWith(`${pkg}@`))
      .map((d) => path.join(pnpmStore, d, "node_modules", pkg));
    candidates.push(...storeEntries);
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const dest = path.join(nodeModulesOut, pkg);
      cpSync(candidate, dest, { recursive: true, dereference: true });
      console.log(`Copied package ${pkg} → ${dest}`);
      break;
    }
  }
}

// 2. Resolve both aarch64 and x86_64 Node.js executables
const nodeBin = process.execPath;
const version = process.version; // e.g. v20.11.0

function downloadNodeBinary(targetArch, outputPath) {
  const nodeArch = targetArch === "aarch64" ? "arm64" : "x64";
  const url = `https://nodejs.org/dist/${version}/node-${version}-darwin-${nodeArch}.tar.gz`;
  const tempTar = path.join(serverRoot, `node-${targetArch}.tar.gz`);
  const tempExtractDir = path.join(serverRoot, `node-temp-${targetArch}`);

  console.log(`Downloading Node.js ${version} for ${targetArch} (${nodeArch}) from ${url}...`);
  try {
    execSync(`curl -sL "${url}" -o "${tempTar}"`);
    if (existsSync(tempExtractDir)) rmSync(tempExtractDir, { recursive: true, force: true });
    mkdirSync(tempExtractDir, { recursive: true });
    execSync(`tar -xzf "${tempTar}" -C "${tempExtractDir}" --strip-components=1`);
    
    const extractedNode = path.join(tempExtractDir, "bin/node");
    if (existsSync(extractedNode)) {
      if (existsSync(outputPath)) rmSync(outputPath, { force: true });
      cpSync(extractedNode, outputPath);
      chmodSync(outputPath, 0o755);
      console.log(`Successfully placed Node.js executable for ${targetArch} → ${outputPath}`);
    } else {
      throw new Error("Extracted node binary not found in bin/node");
    }
  } catch (err) {
    console.error(`Failed to download Node.js for ${targetArch}:`, err.message);
    console.log(`Falling back: copying host Node.js binary as sidecar for ${targetArch}`);
    if (existsSync(outputPath)) rmSync(outputPath, { force: true });
    cpSync(nodeBin, outputPath);
    chmodSync(outputPath, 0o755);
  } finally {
    if (existsSync(tempTar)) rmSync(tempTar, { force: true });
    if (existsSync(tempExtractDir)) rmSync(tempExtractDir, { recursive: true, force: true });
  }
}

// Determine host architecture
let hostArch = "aarch64";
try {
  const archOutput = execSync("uname -m", { encoding: "utf8" }).trim();
  if (archOutput === "x86_64") {
    hostArch = "x86_64";
  }
} catch {
  // default to aarch64
}

const aarch64Path = path.join(binariesDir, "server-aarch64-apple-darwin");
const x86_64Path = path.join(binariesDir, "server-x86_64-apple-darwin");

// Place the host binary
if (hostArch === "aarch64") {
  if (existsSync(aarch64Path)) rmSync(aarch64Path, { force: true });
  cpSync(nodeBin, aarch64Path);
  chmodSync(aarch64Path, 0o755);
  console.log(`Copied host Node.js binary to sidecar aarch64 → ${aarch64Path}`);

  // Download/Extract Intel binary if missing
  if (!existsSync(x86_64Path)) {
    downloadNodeBinary("x86_64", x86_64Path);
  } else {
    console.log(`Using existing sidecar x86_64 → ${x86_64Path}`);
  }
} else {
  if (existsSync(x86_64Path)) rmSync(x86_64Path, { force: true });
  cpSync(nodeBin, x86_64Path);
  chmodSync(x86_64Path, 0o755);
  console.log(`Copied host Node.js binary to sidecar x86_64 → ${x86_64Path}`);

  // Download/Extract Apple Silicon binary if missing
  if (!existsSync(aarch64Path)) {
    downloadNodeBinary("aarch64", aarch64Path);
  } else {
    console.log(`Using existing sidecar aarch64 → ${aarch64Path}`);
  }
}

console.log("\nZero-dependency universal sidecars ready!");
