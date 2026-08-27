/**
 * Builds one zip and exits. A worker for the same reason the extraction one is: fflate's `zipSync` is
 * synchronous CPU work, and a debug package carrying save games measured 175 ms of blocking at 4 MB and
 * 850 ms at 24 MB - on the Electron main process that is the window frozen for the whole compression. Its
 * async form still ran most of the work on the calling thread, so the thread is what has to move.
 *
 * The files are read here rather than passed in, so a package the size of a save folder never crosses the
 * boundary between the threads.
 */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { zipSync } = require("fflate");

try {
  const contents = {};
  for (const entry of workerData.entries) contents[entry.name] = new Uint8Array(readFileSync(entry.source));
  mkdirSync(dirname(workerData.destination), { recursive: true });
  writeFileSync(workerData.destination, zipSync(contents, { level: 6 }));
  parentPort.postMessage({ ok: true });
} catch (error) {
  // As it was caught: the caller describes it, so the three workers cannot disagree about what one says.
  parentPort.postMessage({ error });
}
