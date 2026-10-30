/**
 * Verifies the chokidar override declared in pnpm-workspace.yaml.
 *
 * svelte-check asks for chokidar ^4, whose 4.0.2 and 4.0.3 were hand-published without provenance; the override
 * puts it on 5 instead, a major its authors do not test against. No other gate would notice that breaking:
 * chokidar is reached only from svelte-check's watch mode, and `pnpm check` runs a single pass.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ui = join(root, "packages", "ui");

/** A cold first pass checks all 426 files; the re-check after it revisits only what changed. */
const FIRST_PASS_MS = 180_000;
const RECHECK_MS = 60_000;

function fail(message) {
  console.error(`chokidar override: ${message}`);
  process.exit(1);
}

const manifestPath = createRequire(join(ui, "package.json")).resolve("svelte-check/package.json");
const fromSvelteCheck = createRequire(manifestPath);
const manifest = fromSvelteCheck(manifestPath);

// The override exists only because svelte-check pins the major. Once it moves, that is a decision to retake
// rather than an entry nobody reads again.
const declared = manifest.dependencies?.chokidar;
if (typeof declared !== "string" || !declared.startsWith("^4.")) {
  fail(`svelte-check ${manifest.version} asks for chokidar ${declared}, no longer ^4.x - reassess the override.`);
}

/** Walks up from a resolved entry point to the manifest of the package owning it. chokidar 5's export map has
 * no "./package.json", so its version cannot simply be required. */
function versionOf(entry, name) {
  for (let dir = dirname(entry), parent = ""; dir !== parent; parent = dir, dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf8"));
    if (parsed.name === name) return parsed.version;
  }
  return null;
}

// Resolved through svelte-check itself, which is the copy that matters: an override that stopped applying looks
// identical from the workspace root.
const resolved = versionOf(fromSvelteCheck.resolve("chokidar"), "chokidar");
if (resolved === null || !resolved.startsWith("5.")) {
  fail(`svelte-check resolves chokidar ${resolved ?? "not at all"} - the override is not applying.`);
}

const child = spawn(
  process.execPath,
  [join(dirname(manifestPath), manifest.bin), "--tsconfig", "./tsconfig.json", "--watch", "--output", "machine"],
  { cwd: ui, stdio: ["ignore", "pipe", "pipe"] },
);

let completed = 0;
let stopped = null;
let errors = "";
const waiting = new Set();
const announce = () => {
  for (const listener of [...waiting]) listener();
};

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  for (const line of chunk.split("\n")) if (line.includes("COMPLETED")) completed += 1;
  announce();
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => (errors += chunk));

// A watcher that dies is the failure under test, so it ends the wait rather than leaving it to time out.
child.on("exit", (code) => {
  stopped = `svelte-check exited with ${code}`;
  announce();
});
child.on("error", (error) => {
  stopped = error.message;
  announce();
});

/**
 * Resolves once `target` checks have reported, and rejects if the watcher dies or the wait runs out.
 * @returns {Promise<void>}
 */
async function waitForChecks(target, ms, what) {
  return new Promise((resolve, reject) => {
    const settle = () => {
      if (completed >= target) {
        stop();
        resolve();
      } else if (stopped !== null) {
        stop();
        reject(new Error(`${stopped} while waiting for ${what}`));
      }
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out after ${ms}ms waiting for ${what}`));
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      waiting.delete(settle);
    };
    waiting.add(settle);
    settle();
  });
}

// Only the timestamp changes: the point is that the watcher notices, not that the file differs.
const TOUCHED = join("src", "App.svelte");
const touched = join(ui, TOUCHED);
let failure = null;

try {
  await waitForChecks(1, FIRST_PASS_MS, "the first check");
  const now = new Date();
  await utimes(touched, now, now);
  await waitForChecks(2, RECHECK_MS, "a re-check after touching src/App.svelte");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}

child.kill();

if (failure !== null) fail(`${failure}${errors === "" ? "" : `\n${errors.trim()}`}`);
console.log(
  `chokidar override verified: svelte-check ${manifest.version} re-checked on a change under chokidar ${resolved}`,
);
