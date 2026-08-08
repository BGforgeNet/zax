/**
 * Builds the three pieces the desktop shell needs: the main process, the preload, and the interface.
 *
 * The two process entry points differ in module format by necessity rather than taste - a sandboxed preload is
 * loaded as CommonJS, while the main process is ESM like the rest of the workspace. `electron` itself stays
 * external in both: it is provided by the runtime, not bundled into it.
 */

import { build } from "esbuild";
import { copyFile, rm, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");

// `electron` is provided by the runtime. `7z-wasm` loads its own `.wasm` from beside its module, which a
// bundle would move away from it - so it stays a real import resolved from node_modules. Everything else,
// workspace sources included, is bundled: the workspace packages are TypeScript that Node cannot load.
const common = {
  bundle: true,
  platform: "node",
  // The Node line Electron 43 embeds.
  target: "node24",
  external: ["electron", "7z-wasm"],
  sourcemap: true,
  logLevel: "warning",
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  ...common,
  entryPoints: [join(here, "src/main.ts")],
  outfile: join(dist, "main.mjs"),
  format: "esm",
  // Some dependencies ship CommonJS, which esbuild inlines with its own `require` shim - and that shim cannot
  // resolve Node's own built-ins from an ESM output. This gives it a real `require` to fall back on.
  banner: {
    js: "import { createRequire as zaxCreateRequire } from 'node:module';\nconst require = zaxCreateRequire(import.meta.url);",
  },
});
// The extraction worker is loaded by path at runtime rather than imported, so the bundler never sees it; it is
// copied beside the bundle, where the main process's `new URL` resolution expects it.
await copyFile(join(here, "../platform-node/src/extract-worker.cjs"), join(dist, "extract-worker.cjs"));

// The preload bundles whole: a sandboxed one has no module resolution of its own. It imports only the list of
// operation names, whose module has no runtime imports, so this stays a few lines.
await build({
  ...common,
  entryPoints: [join(here, "src/preload.ts")],
  outfile: join(dist, "preload.cjs"),
  format: "cjs",
});

await new Promise((resolve, reject) => {
  const child = spawn(
    "pnpm",
    ["--filter", "@zax/ui", "exec", "vite", "build", "--outDir", join(dist, "renderer"), "--emptyOutDir"],
    { stdio: "inherit", cwd: join(here, "../..") },
  );
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`The interface build exited with ${code}`))));
  child.on("error", reject);
});

console.log(`built into ${dist}`);
