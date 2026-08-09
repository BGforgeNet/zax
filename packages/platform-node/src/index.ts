/**
 * The platform, on a real machine. This is the only module in the project that imports Node built-ins.
 */

import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import {
  NetworkError,
  type ArchiveEntry,
  type DirEntry,
  type FileKind,
  type FileStat,
  type LaunchOptions,
  type OperatingSystem,
  type Platform,
} from "@zax/platform";
import { downloadFile, type AttemptNote } from "./download.js";
import { applicationDirectories } from "./paths.js";
import { registryValue } from "./registry.js";

/**
 * What the shell wants told about work that happens out of sight. A failed download is the one thing a bug
 * report cannot reconstruct from the interface, so the shell passes a sink for it here.
 */
export interface PlatformOptions {
  log?: (line: string) => void;
}

const APP_NAME = "zax";

/** A hung mirror without this leaves the interface's busy state stuck with no failure to show. */
const FETCH_TIMEOUT_MS = 30_000;

function operatingSystem(os: NodeJS.Platform): OperatingSystem {
  if (os === "win32") return "windows";
  if (os === "darwin") return "macos";
  return "linux";
}

/** The desktop's own way of handing a path to whatever handles it - the file manager, the default editor. */
function openCommand(os: NodeJS.Platform): { program: string; args: readonly string[] } {
  if (os === "win32") return { program: "cmd", args: ["/c", "start", ""] };
  if (os === "darwin") return { program: "open", args: [] };
  return { program: "xdg-open", args: [] };
}

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean }): FileKind {
  return entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
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

/**
 * Runs one throwaway worker and answers with its message, or with why there was not one. Resolve-once:
 * whichever of the three arrives first decides, and the rest fall on an already-settled promise.
 */
async function inWorker<T>(script: URL, what: string, workerData: unknown): Promise<T | { error: string }> {
  const worker = new Worker(script, { workerData });
  return new Promise<T | { error: string }>((resolve) => {
    worker.once("message", resolve);
    worker.once("error", (error) => resolve({ error: error instanceof Error ? error.message : String(error) }));
    worker.once("exit", (status) => resolve({ error: `the ${what} worker exited with ${status}` }));
  }).finally(() => void worker.terminate());
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
    options.log?.(`download ${note.outcome}: ${note.url} attempt ${note.attempt}, ${size} in ${note.ms}ms${resumed}`);
  };

  return {
    os: operatingSystem(os),

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
    },

    process: {
      launch: async (program, args, options?: LaunchOptions) => {
        // Detached with its handles closed: the game outlives this process, and a manager that holds the game's
        // stdout open would keep it alive after the user quits ZAX.
        const child = spawn(program, [...args], {
          detached: true,
          stdio: "ignore",
          ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
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
        const outcome = await inWorker<{ code: number }>(EXTRACT_WORKER, "extraction", {
          archive,
          destination,
          // Spread rather than passed through: a readonly array from the caller may be a reactive proxy by
          // the time it gets here, and the structured clone into the worker refuses one.
          only: options?.only ? [...options.only] : [],
        });
        if ("error" in outcome) throw new Error(`Could not extract ${archive}: ${outcome.error}`);
        if (outcome.code !== 0) throw new Error(`Could not extract ${archive}: 7-Zip exited with ${outcome.code}`);
      },

      createZip: async (destination, entries: readonly ArchiveEntry[]) => {
        const outcome = await inWorker<{ ok: true }>(ZIP_WORKER, "zip", {
          destination,
          entries: entries.map((entry) => ({ source: entry.source, name: entry.name })),
        });
        if ("error" in outcome) throw new Error(`Could not write ${destination}: ${outcome.error}`);
      },
    },
  };
}
