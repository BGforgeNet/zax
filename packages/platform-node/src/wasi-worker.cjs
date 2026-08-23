/**
 * Runs one WASI module to completion and answers with what it did. A worker rather than the caller's thread
 * for the reason the 7-Zip one is: `wasi.start` is synchronous CPU work, and unpacking a game archive on the
 * thread that dispatches IPC freezes the window for the whole run.
 *
 * The module is given `/` as its single preopen. WASI resolves the absolute paths ZAX passes against it, and
 * the authority is the same a native build of the tool would have had - the module is here because there is
 * no native build for this machine, not because the tool is trusted less.
 */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { WASI } = require("node:wasi");
const { closeSync, openSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// Both streams to one file, in arrival order, because that is the shape `RunOutcome.output` promises. A file
// rather than a pipe: WASI writes to a descriptor synchronously, and nothing is draining a pipe meanwhile.
const log = join(tmpdir(), `zax-wasi-${process.pid}-${workerData.nonce}.log`);
let fd;

/**
 * The last thing this worker does, both ways out: the caller terminates the thread the moment its message
 * arrives, so anything after the post - a `finally`, a cleanup line - is a race the file loses. Everything
 * that has to happen happens before the message.
 */
const finish = (message) => {
  if (fd !== undefined) {
    closeSync(fd);
    fd = undefined;
  }
  rmSync(log, { force: true });
  parentPort.postMessage(message);
};

try {
  fd = openSync(log, "w");
  const wasi = new WASI({
    version: "preview1",
    // Every WASI program expects its own name first, as any other program does.
    args: [workerData.name, ...workerData.args],
    env: {},
    preopens: { "/": "/" },
    stdout: fd,
    stderr: fd,
    // Without this the module's exit calls `process.exit`, which takes the worker down before it can answer.
    returnOnExit: true,
  });
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(readFileSync(workerData.module)),
    wasi.getImportObject(),
  );
  const code = wasi.start(instance);
  closeSync(fd);
  fd = undefined;
  const output = readFileSync(log, "utf8");
  finish({ code: typeof code === "number" ? code : 0, output });
} catch (error) {
  finish({ error: error instanceof Error ? error.message : String(error) });
}
