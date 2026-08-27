/**
 * Runs one 7-Zip operation - an extraction, or a listing - and exits. A worker rather than the caller's
 * thread because `callMain` is synchronous CPU work: run where the Electron shell dispatches IPC, it stalls
 * every other operation for the whole run. The worker is throwaway - the mounts and the WASM instance die
 * with it, so nothing here unmounts or caches.
 */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { dirname, basename } = require("node:path");

(async () => {
  // Resolved from this file's own location: beside the sources in development, beside the bundle when packaged.
  const SevenZip = require("7z-wasm");
  // A listing is 7-Zip's stdout, one line per print call; an extraction's chatter is dropped as before.
  const lines = [];
  const listing = workerData.list === true;
  const sz = await SevenZip({ print: listing ? (line) => lines.push(line) : () => {}, printErr: () => {} });
  const inside = "/zax-in";
  sz.FS.mkdir(inside);
  // Both sides are mounted as host directories rather than copied through the WebAssembly heap, so a large
  // archive does not have to fit in memory twice.
  sz.FS.mount(sz.NODEFS, { root: dirname(workerData.archive) }, inside);
  const archive = `${inside}/${basename(workerData.archive)}`;

  if (listing) {
    // `-slt` prints one field-per-line block per entry; `-ba` drops the banner and column headers; `-bsp0`
    // silences the progress indicator, which otherwise prints itself onto the first entry's line.
    const code = sz.callMain(["l", "-slt", "-ba", "-bsp0", archive]);
    parentPort.postMessage({ code: typeof code === "number" ? code : 0, lines });
    return;
  }

  const outside = "/zax-out";
  sz.FS.mkdir(outside);
  sz.FS.mount(sz.NODEFS, { root: workerData.destination }, outside);
  sz.FS.chdir(outside);
  // Named files only when the caller asked for some; 7-Zip treats no names as "everything".
  const wanted = workerData.only ?? [];
  // Emscripten's `callMain` returns the program's exit status; 7z-wasm's declaration says `void`.
  const code = sz.callMain(["x", archive, "-y", ...wanted]);
  parentPort.postMessage({ code: typeof code === "number" ? code : 0 });
})().catch((error) => {
  // Posted as it was caught rather than as text: emscripten throws plain objects whose fields are the whole
  // diagnosis, and the caller is what turns one into a message.
  parentPort.postMessage({ error });
});
