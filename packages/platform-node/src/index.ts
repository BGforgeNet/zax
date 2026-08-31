/**
 * The platform, on a real machine. This is the only module in the project that imports Node built-ins.
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, openSync, statSync } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import {
  NetworkError,
  type Architecture,
  type ArchiveEntry,
  type ArchiveEntryInfo,
  type DirEntry,
  type FileKind,
  type FileStat,
  type LaunchOptions,
  type OperatingSystem,
  type Platform,
  type RunOutcome,
} from "@zax/platform";
import { downloadFile, type AttemptNote } from "./download.js";
import { throughGzip } from "./gunzip.js";
import { applicationDirectories } from "./paths.js";
import { registryValue } from "./registry.js";
import { failureText } from "./worker-failure.js";

/**
 * What the shell wants told about work that happens out of sight. A failed download is the one thing a bug
 * report cannot reconstruct from the interface, so the shell passes a sink for it here.
 */
export interface PlatformOptions {
  log?: (level: "info" | "warn", line: string) => void;
}

const APP_NAME = "zax";

/** How much of a run's output is kept. An Inno log runs to tens of kilobytes; a bomb of one is not evidence. */
const RUN_OUTPUT_CAP = 64 * 1024;

/** A hung mirror without this leaves the interface's busy state stuck with no failure to show. */
const FETCH_TIMEOUT_MS = 30_000;

function operatingSystem(os: NodeJS.Platform): OperatingSystem {
  if (os === "win32") return "windows";
  if (os === "darwin") return "macos";
  return "linux";
}

/**
 * Only the two ZAX has builds for. Anything else answers `other` rather than being rounded to the nearer of
 * them: a 32-bit ARM host told it is `arm64` gets handed a binary it cannot run, where `other` gets it the
 * portable route.
 */
function architecture(arch: NodeJS.Architecture): Architecture {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  return "other";
}

/**
 * The desktop's own way of handing a path to whatever handles it - the file manager, the default editor.
 *
 * Windows goes to `explorer` rather than through `cmd /c start`: the latter hands the target to two more
 * parsers, cmd's and start's, each with its own metacharacters, and the target can be a URL that arrived over
 * the network. `explorer` takes it as one argument and opens it with whatever handles it, same as start did.
 */
function openCommand(os: NodeJS.Platform): { program: string; args: readonly string[] } {
  if (os === "win32") return { program: "explorer.exe", args: [] };
  if (os === "darwin") return { program: "open", args: [] };
  return { program: "xdg-open", args: [] };
}

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean }): FileKind {
  return entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
}

// Streamed rather than read whole: the largest thing this hashes is a downloaded mod archive, and RPU's runs
// to a gigabyte.
function streamHash(path: string, algorithm: "sha256" | "md5"): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const digest = createHash(algorithm);
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => digest.update(chunk))
      .on("end", () => resolve(digest.digest("hex")));
  });
}

/**
 * 7-Zip compiled to WebAssembly - sfall ships its releases as `.7z` and nothing in Node reads that format; a
 * WebAssembly build keeps this to one portable artifact rather than a native binary per platform that then has
 * to survive being packaged. It runs in a worker because its `callMain` is synchronous CPU work: on the
 * Electron main process it would stall IPC and window events for the whole extraction. A fresh worker per call
 * trades a moment of WASM instantiation for never sharing mutable emscripten filesystem state between runs.
 * The worker is a plain `.cjs` file loaded by path; the app's build step copies it beside the bundle.
 */
const EXTRACT_WORKER = new URL("./extract-worker.cjs", import.meta.url);

/**
 * Zipping runs off the main process for the same reason: fflate compresses synchronously, which measured
 * 850 ms of frozen window on a debug package carrying 24 MB of saves.
 */
const ZIP_WORKER = new URL("./zip-worker.cjs", import.meta.url);

/** Where a WASI module runs, off the main process for the reason the other two are. */
const WASI_WORKER = new URL("./wasi-worker.cjs", import.meta.url);

/**
 * Runs one throwaway worker and answers with its message, or with why there was not one. Resolve-once:
 * whichever of the three arrives first decides, and the rest fall on an already-settled promise.
 *
 * A worker reports a failure by posting what it caught, not a description of it: turning a thrown value into
 * text is `failureText`'s business, and doing it here is what keeps the three workers from each having their
 * own idea of what a thrown object says.
 */
async function inWorker<T>(script: URL, what: string, workerData: unknown): Promise<T | { error: string }> {
  const worker = new Worker(script, { workerData });
  return new Promise<T | { error: string }>((resolve) => {
    worker.once("message", (message: T | { error: unknown }) =>
      resolve(threw(message) ? { error: failureText(message.error) } : message),
    );
    worker.once("error", (error) => resolve({ error: failureText(error) }));
    worker.once("exit", (status) => resolve({ error: `the ${what} worker exited with ${status}` }));
  }).finally(() => void worker.terminate());
}

/** No answer a worker gives carries an `error` key, so its presence is what marks the message a failure. */
const threw = <T>(message: T | { error: unknown }): message is { error: unknown } =>
  typeof message === "object" && message !== null && "error" in message;

/**
 * One entry from 7-Zip's `-slt` listing: field-per-line blocks, blank lines between entries. A link names its
 * target in `Symbolic Link` or `Hard Link`, or carries a mode string starting `l` in `Attributes` (zip with
 * Unix attributes); all are folded to the one kind.
 */
function listedEntry(fields: Readonly<Record<string, string>>): ArchiveEntryInfo | null {
  const name = fields["Path"];
  if (name === undefined) return null;
  const attributes = fields["Attributes"] ?? "";
  // A tar prints this field for every entry and leaves it empty unless the entry really is a link; a zip with
  // Unix attributes says so in the mode string instead.
  const link =
    (fields["Symbolic Link"] ?? "") !== "" ||
    (fields["Hard Link"] ?? "") !== "" ||
    /(^|\s)l[rwxst-]{9}$/.test(attributes);
  const kind = link
    ? "link"
    : fields["Folder"] === "+" || /(^|\s)D/.test(attributes.split(" ")[0] ?? "")
      ? "dir"
      : "file";
  const size = Number(fields["Size"]);
  return { name: name.replace(/\\/g, "/"), kind, size: Number.isFinite(size) ? size : 0 };
}

function parseListing(lines: readonly string[]): ArchiveEntryInfo[] {
  const entries: ArchiveEntryInfo[] = [];
  let fields: Record<string, string> = {};
  const flush = () => {
    const entry = listedEntry(fields);
    if (entry) entries.push(entry);
    fields = {};
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const cut = line.indexOf(" = ");
    if (cut !== -1) fields[line.slice(0, cut)] = line.slice(cut + 3);
  }
  flush();
  return entries;
}

/** A wedged `reg` must not hold the scan that asked; there is nothing here worth waiting seconds for. */
const REGISTRY_TIMEOUT_MS = 5_000;

const runProgram = promisify(execFile);

/** Synchronous because it decides where this process reads its own settings from, before anything else runs. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function nodePlatform(options: PlatformOptions = {}): Platform {
  const os = process.platform;
  const home = homedir();
  const { config, cache } = applicationDirectories(os, process.env, home, APP_NAME, process.execPath, isDirectory);

  /** One line per attempt, so a report from a user on a poor connection says which part failed and how far it got. */
  const noteDownload = (note: AttemptNote): void => {
    const size = note.total === null ? `${note.received} bytes` : `${note.received}/${note.total} bytes`;
    const resumed = note.resumedFrom > 0 ? `, resumed from ${note.resumedFrom}` : "";
    // An attempt that did not finish is a warning even though the download as a whole may still succeed: it is
    // the line a report from a poor connection is read for, and it should not sit among the ordinary ones.
    const level = note.outcome === "ok" ? "info" : "warn";
    options.log?.(
      level,
      `download ${note.outcome}: ${note.url} attempt ${note.attempt}, ${size} in ${note.ms}ms${resumed}`,
    );
  };

  return {
    os: operatingSystem(os),
    arch: architecture(process.arch),

    paths: { config, cache, home, separator: os === "win32" ? "\\" : "/", join, dirname, basename },

    fs: {
      read: (path) => readFile(path),
      write: async (path, bytes) => {
        await mkdir(dirname(path), { recursive: true });
        // Written beside the target and renamed over it: a crash mid-write must not leave a truncated file,
        // because one of these files is the user's install list.
        const partial = `${path}.zax-partial`;
        await writeFile(partial, bytes);
        await rename(partial, path);
      },
      append: async (path, bytes) => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, bytes);
      },
      stat: async (path): Promise<FileStat | null> => {
        try {
          const found = await stat(path);
          return { kind: kindOf(found), size: found.size, modified: found.mtimeMs };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      list: async (path): Promise<readonly DirEntry[]> => {
        const found = await readdir(path, { withFileTypes: true });
        return found.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
      },
      mkdir: async (path) => void (await mkdir(path, { recursive: true })),
      copy: async (from, to) => {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
      },
      remove: (path) => rm(path, { recursive: true, force: true }),
      rename: async (from, to) => {
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
      },
      makeExecutable: async (path) => {
        // Windows has no execute bit and rejects the call; everywhere else, the owner's is what running it
        // from here needs. The existing mode is read first so this only adds.
        if (os === "win32") return;
        const held = await stat(path);
        await chmod(path, held.mode | 0o100);
      },
      freeSpace: async (path) => {
        try {
          const info = await statfs(path);
          // Available to this user rather than free in total: the difference is the reserve only root may
          // spend, and an install that fills it is not an install that succeeded.
          return info.bsize * info.bavail;
        } catch {
          // A path that is not there says nothing about the disk, and neither does a host without statfs.
          return null;
        }
      },
    },

    process: {
      launch: async (program, args, options?: LaunchOptions) => {
        // A folder ZAX cannot write to is not a reason to refuse to start the game, so a log that will not open
        // is dropped rather than raised - the launch is what the user asked for.
        let log: number | null = null;
        if (options?.log !== undefined) {
          try {
            log = openSync(options.log, "w");
          } catch {
            log = null;
          }
        }
        try {
          // Detached with its handles closed: the game outlives this process, and a manager that holds the
          // game's stdout open would keep it alive after the user quits ZAX. A log file is the exception - the
          // child holds its own copy of the descriptor, so closing this one here leaves the child writing.
          const child = spawn(program, [...args], {
            detached: true,
            stdio: log === null ? "ignore" : ["ignore", log, log],
            ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
            ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
          });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          child.unref();
        } finally {
          if (log !== null) closeSync(log);
        }
      },
      run: async (program, args, options?: LaunchOptions) => {
        // Attached rather than detached, with its output captured: the caller is waiting for this one, and
        // what it printed is the only account of a failure that exists afterwards.
        const child = spawn(program, [...args], {
          stdio: ["ignore", "pipe", "pipe"],
          ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
        });
        let output = "";
        const keep = (chunk: Buffer | string) => {
          output += String(chunk);
          // The tail, because the end of an installer's log is where it says what went wrong.
          if (output.length > RUN_OUTPUT_CAP) output = output.slice(-RUN_OUTPUT_CAP);
        };
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        return new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, output }));
        });
      },
      runWasm: async (module, args) => {
        // A nonce so two concurrent runs cannot land on one another's capture file; the worker names it from
        // this and its own pid.
        const answer = await inWorker<RunOutcome>(WASI_WORKER, "WebAssembly", {
          module,
          args: [...args],
          name: basename(module),
          nonce: randomUUID(),
        });
        if ("error" in answer) throw new Error(`Could not run ${basename(module)}: ${answer.error}`);
        // Capped as a spawned program's output is, and for the same reason.
        return answer.output.length > RUN_OUTPUT_CAP
          ? { ...answer, output: answer.output.slice(-RUN_OUTPUT_CAP) }
          : answer;
      },
      open: async (target) => {
        const { program, args } = openCommand(os);
        const child = spawn(program, [...args, target], { detached: true, stdio: "ignore" });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
      },
    },

    registry: {
      read: async (key, value) => {
        // Nothing to read off Windows, and spawning `reg` elsewhere would either fail or find some other program
        // of that name. The null is the answer, not a failure to get one.
        if (os !== "win32") return null;
        try {
          const { stdout } = await runProgram("reg", ["query", key, "/v", value], {
            timeout: REGISTRY_TIMEOUT_MS,
            windowsHide: true,
          });
          return registryValue(stdout, value);
        } catch {
          // `reg` exits non-zero for a key that is not there, which is the common case rather than a fault.
          return null;
        }
      },
    },

    net: {
      fetchText: async (url) => {
        // A feed is a few kilobytes, so a deadline on the whole request is the right shape here - unlike a
        // download, where it would fail a slow link that is still making progress.
        let response: Response;
        try {
          response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        } catch (error) {
          const kind = (error as { name?: string }).name === "TimeoutError" ? "timeout" : "offline";
          const host = (() => {
            try {
              return new URL(url).host;
            } catch {
              return url;
            }
          })();
          const reason =
            kind === "timeout"
              ? `${host} did not answer in time.`
              : `${host} could not be reached - check the network connection.`;
          throw new NetworkError(kind, url, reason, { cause: error });
        }
        if (!response.ok) {
          const detail = `${response.status} ${response.statusText}`.trim();
          throw new NetworkError("status", url, `${new URL(url).host} answered with ${detail}.`, {
            status: response.status,
          });
        }
        return response.text();
      },
      download: (url, destination, options) => downloadFile(url, destination, { ...options, note: noteDownload }),
    },

    archive: {
      extract: async (archive, destination, options) => {
        await mkdir(destination, { recursive: true });
        return throughGzip(archive, async (path) => {
          const outcome = await inWorker<{ code: number }>(EXTRACT_WORKER, "extraction", {
            archive: path,
            destination,
            // Spread rather than passed through: a readonly array from the caller may be a reactive proxy by
            // the time it gets here, and the structured clone into the worker refuses one.
            only: options?.only ? [...options.only] : [],
          });
          // Both folders named, because the worker reads both before 7-Zip runs and a failure there says only
          // what went wrong, not which of the two it was.
          const where = `${archive} into ${destination}`;
          if ("error" in outcome) throw new Error(`Could not extract ${where}: ${outcome.error}`);
          if (outcome.code !== 0) throw new Error(`Could not extract ${where}: 7-Zip exited with ${outcome.code}`);
        });
      },

      list: async (archive) =>
        throughGzip(archive, async (path) => {
          const outcome = await inWorker<{ code: number; lines: string[] }>(EXTRACT_WORKER, "listing", {
            archive: path,
            list: true,
          });
          if ("error" in outcome) throw new Error(`Could not read ${archive}: ${outcome.error}`);
          if (outcome.code !== 0) throw new Error(`Could not read ${archive}: 7-Zip exited with ${outcome.code}`);
          return parseListing(outcome.lines);
        }),

      createZip: async (destination, entries: readonly ArchiveEntry[]) => {
        const outcome = await inWorker<{ ok: true }>(ZIP_WORKER, "zip", {
          destination,
          entries: entries.map((entry) => ({ source: entry.source, name: entry.name })),
        });
        if ("error" in outcome) throw new Error(`Could not write ${destination}: ${outcome.error}`);
      },
    },

    hash: {
      sha256: (path) => streamHash(path, "sha256"),
      md5: (path) => streamHash(path, "md5"),
    },
  };
}
