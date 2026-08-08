/**
 * The platform, on a real machine. This is the only module in the project that imports Node built-ins.
 */

import { execFile, spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { zipSync } from "fflate";
import type {
  ArchiveEntry,
  DirEntry,
  FileKind,
  FileStat,
  LaunchOptions,
  OperatingSystem,
  Platform,
} from "@zax/platform";
import { userDirectories } from "./paths.js";
import { registryValue } from "./registry.js";

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

/** A wedged `reg` must not hold the scan that asked; there is nothing here worth waiting seconds for. */
const REGISTRY_TIMEOUT_MS = 5_000;

const runProgram = promisify(execFile);

export function nodePlatform(): Platform {
  const os = process.platform;
  const home = homedir();
  const { config, cache } = userDirectories(os, process.env, home, APP_NAME);

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
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
        return response.text();
      },
      download: async (url, destination) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
      },
    },

    archive: {
      extract: async (archive, destination) => {
        await mkdir(destination, { recursive: true });
        const worker = new Worker(EXTRACT_WORKER, { workerData: { archive, destination } });
        // Resolve-once: whichever of the three arrives first decides, and the rest fall on a settled promise.
        const outcome = await new Promise<{ code: number } | { error: string }>((resolve) => {
          worker.once("message", resolve);
          worker.once("error", (error) => resolve({ error: error instanceof Error ? error.message : String(error) }));
          worker.once("exit", (status) => resolve({ error: `the extraction worker exited with ${status}` }));
        }).finally(() => void worker.terminate());
        if ("error" in outcome) throw new Error(`Could not extract ${archive}: ${outcome.error}`);
        if (outcome.code !== 0) throw new Error(`Could not extract ${archive}: 7-Zip exited with ${outcome.code}`);
      },

      createZip: async (destination, entries: readonly ArchiveEntry[]) => {
        const contents: Record<string, Uint8Array> = {};
        for (const entry of entries) contents[entry.name] = await readFile(entry.source);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, zipSync(contents, { level: 6 }));
      },
    },
  };
}
