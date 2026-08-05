/**
 * The platform, on a real machine. This is the only module in the project that imports Node built-ins.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { zipSync } from "fflate";
import SevenZip from "7z-wasm";
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

const APP_NAME = "zax";

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
 * 7-Zip compiled to WebAssembly, loaded on first use. sfall ships its releases as `.7z` and nothing in Node
 * reads that format; a WebAssembly build keeps this to one portable artifact rather than a native binary per
 * platform that then has to survive being packaged.
 */
let sevenZip: Promise<Awaited<ReturnType<typeof SevenZip>>> | undefined;
function loadSevenZip() {
  sevenZip ??= SevenZip({ print: () => {}, printErr: () => {} });
  return sevenZip;
}

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
        await writeFile(path, bytes);
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

    net: {
      fetchText: async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
        return response.text();
      },
      download: async (url, destination) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
      },
    },

    archive: {
      extract: async (archive, destination) => {
        await mkdir(destination, { recursive: true });
        const sz = await loadSevenZip();
        // Both sides are mounted as host directories rather than copied through the WebAssembly heap, so a
        // large archive does not have to fit in memory twice.
        const inside = "/zax-in";
        const outside = "/zax-out";
        sz.FS.mkdir(inside);
        sz.FS.mkdir(outside);
        sz.FS.mount(sz.NODEFS, { root: dirname(archive) }, inside);
        sz.FS.mount(sz.NODEFS, { root: destination }, outside);
        try {
          sz.FS.chdir(outside);
          // Emscripten's `callMain` returns the program's exit status; 7z-wasm's declaration says `void`.
          const code = sz.callMain(["x", `${inside}/${basename(archive)}`, "-y"]) as unknown as number;
          if (code !== 0) throw new Error(`Could not extract ${archive}: 7-Zip exited with ${code}`);
        } finally {
          sz.FS.chdir("/");
          sz.FS.unmount(inside);
          sz.FS.unmount(outside);
          sz.FS.rmdir(inside);
          sz.FS.rmdir(outside);
        }
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
