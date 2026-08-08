/**
 * Runs one 7-Zip extraction and exits. A worker rather than the caller's thread because `callMain` is
 * synchronous CPU work: run where the Electron shell dispatches IPC, it stalls every other operation for the
 * whole extraction. The worker is throwaway - the mounts and the WASM instance die with it, so nothing here
 * unmounts or caches.
 */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { dirname, basename } = require("node:path");

(async () => {
  // Resolved from this file's own location: beside the sources in development, beside the bundle when packaged.
  const SevenZip = require("7z-wasm");
  const sz = await SevenZip({ print: () => {}, printErr: () => {} });
  const inside = "/zax-in";
  const outside = "/zax-out";
  sz.FS.mkdir(inside);
  sz.FS.mkdir(outside);
  // Both sides are mounted as host directories rather than copied through the WebAssembly heap, so a large
  // archive does not have to fit in memory twice.
  sz.FS.mount(sz.NODEFS, { root: dirname(workerData.archive) }, inside);
  sz.FS.mount(sz.NODEFS, { root: workerData.destination }, outside);
  sz.FS.chdir(outside);
  // Emscripten's `callMain` returns the program's exit status; 7z-wasm's declaration says `void`.
  const code = sz.callMain(["x", `${inside}/${basename(workerData.archive)}`, "-y"]);
  parentPort.postMessage({ code: typeof code === "number" ? code : 0 });
})().catch((error) => {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
});
