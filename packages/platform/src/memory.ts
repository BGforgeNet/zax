/**
 * The platform, in memory. Domain tests run against this so they exercise the real code paths without a
 * filesystem, a network or a child process, and so a failing test names a domain defect rather than a fixture
 * that was not cleaned up. It is also the production platform of the browser preview, which seeds one with
 * bundled fixtures and refuses the operations a browser cannot perform.
 *
 * Everything the outside world would have done is recorded instead: launches, downloads, opened paths and
 * archives written. Asserting on those records is how a test checks an effect that has no return value.
 */

import SparkMD5 from "spark-md5";
import {
  NetworkError,
  OperationCancelled,
  type Architecture,
  type Archive,
  type ArchiveEntry,
  type ArchiveEntryInfo,
  type DirEntry,
  type FileStat,
  type FileSystem,
  type Hashing,
  type LaunchOptions,
  type Network,
  type OperatingSystem,
  type Paths,
  type Platform,
  type ProcessLauncher,
  type Registry,
  type RunOutcome,
} from "./index.js";

/** Bytes for a string, one byte per code point. Lossless for the latin1 config files, and ASCII is ASCII. */
export function bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function text(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return s;
}

/** Collapses repeated and trailing separators so two spellings of one path are one key. */
function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/");
}

function dirname(path: string): string {
  const at = normalize(path);
  const cut = at.lastIndexOf("/");
  if (cut < 0) return "";
  return cut === 0 ? "/" : at.slice(0, cut);
}

export interface MemoryOptions {
  os?: OperatingSystem;
  arch?: Architecture;
  home?: string;
  config?: string;
  cache?: string;
  /** Initial files, by absolute path. A string is stored as its bytes; pass a `Uint8Array` for binary content. */
  files?: Readonly<Record<string, string | Uint8Array>>;
  /** Directories that exist while holding no files - an empty `mods/`, a game folder with nothing in it. */
  dirs?: readonly string[];
  /**
   * Canned responses for `net.fetchText`, by URL: a body, or a status number for a server that answered with
   * a failure. A URL with no entry rejects, as an unreachable host would.
   */
  responses?: Readonly<Record<string, string | number>>;
  /** What `net.download` writes at the destination, by URL. A URL with no entry rejects, as fetching does. */
  downloads?: Readonly<Record<string, string | Uint8Array>>;
  /**
   * What `archive.extract` produces: file contents keyed by path inside the archive. Keyed by the archive's
   * path, or by the text it holds - which is what a path that carries different archives at different times
   * needs, an install's working directory being one.
   */
  archives?: Readonly<Record<string, Readonly<Record<string, string | Uint8Array>>>>;
  /**
   * Canned `archive.list` answers, for archives whose declared directory must differ from their contents - a
   * bombed size declaration, a symlink entry. An archive with none is listed from its `archives` contents.
   */
  listings?: Readonly<Record<string, readonly ArchiveEntryInfo[]>>;
  /** Registry values, by key and then by value name. Both are matched case-insensitively, as Windows does. */
  registry?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * What `process.run` answers, by program, or by program and subcommand where a tool answers its own
   * subcommands differently - `"/cache/dat3 l"` before `"/cache/dat3"`. A program with no entry rejects, as a
   * host answers one that is not installed - so a test reaches the installer path only by saying what the
   * installer does.
   */
  runs?: Readonly<Record<string, RunOutcome>>;
  /**
   * What `fs.freeSpace` answers. Null by default because this platform has no disk, which is also the arm
   * where a preflight's check cannot run; a test that means to exercise the refusal states a number.
   *
   * A function where the answer has to vary: ZAX's cache and a game folder are usually different drives, and
   * a drive's room changes as an install fills it, so a single number cannot express either.
   */
  freeSpace?: number | ((path: string) => number | null);
}

export class MemoryPlatform implements Platform {
  readonly os: OperatingSystem;
  readonly arch: Architecture;
  readonly fs: FileSystem;
  readonly paths: Paths;
  readonly process: ProcessLauncher;
  readonly net: Network;
  readonly archive: Archive;
  readonly hash: Hashing;
  readonly registry: Registry;

  /** Everything the outside world was asked to do, in the order it was asked. */
  readonly launched: Array<{ program: string; args: readonly string[]; options?: LaunchOptions }> = [];
  /**
   * Programs run to completion, which is what asserts the command an installer was invoked with. A module run
   * through `runWasm` is recorded here too, marked, so a test asserting the command need not know the route
   * and one asserting the route can.
   */
  readonly ran: Array<{ program: string; args: readonly string[]; options?: LaunchOptions; wasm?: true }> = [];
  /** Paths marked runnable - there is no mode here, so the record is the effect. */
  readonly executable: string[] = [];
  readonly opened: string[] = [];
  readonly fetched: string[] = [];
  readonly downloaded: Array<{ url: string; destination: string }> = [];
  readonly extracted: Array<{ archive: string; destination: string; only?: readonly string[] }> = [];
  readonly listed: string[] = [];
  /**
   * Archives written, each with what was in it at the time. The contents are captured rather than looked up
   * later because an archive routinely outlives the scratch files that went into it.
   */
  readonly zipped: Array<{
    destination: string;
    entries: readonly ArchiveEntry[];
    contents: Record<string, string>;
  }> = [];

  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(["/"]);
  private readonly times = new Map<string, number>();
  private readonly responses: Record<string, string | number>;
  private readonly payloads: Record<string, string | Uint8Array>;
  private readonly contents: Record<string, Readonly<Record<string, string | Uint8Array>>>;
  private readonly listings: Record<string, readonly ArchiveEntryInfo[]>;
  /** Advanced by one on each write, so a rewritten file is detectably newer without a real clock. */
  private clock = 1_700_000_000_000;

  constructor(options: MemoryOptions = {}) {
    this.os = options.os ?? "linux";
    this.arch = options.arch ?? "x64";
    const home = normalize(options.home ?? "/home/tester");
    const config = normalize(options.config ?? `${home}/.config/zax`);
    const cache = normalize(options.cache ?? `${home}/.cache/zax`);
    this.responses = { ...options.responses };
    this.payloads = { ...options.downloads };
    this.contents = { ...options.archives };
    this.listings = { ...options.listings };

    for (const dir of options.dirs ?? []) this.makeDirs(normalize(dir));
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.put(normalize(path), typeof content === "string" ? bytes(content) : content);
    }

    this.paths = {
      config,
      cache,
      home,
      separator: "/",
      join: (...parts) => normalize(parts.filter((p) => p !== "").join("/")),
      dirname,
      basename: (path) => normalize(path).split("/").pop() ?? "",
    };

    this.fs = {
      read: async (path) => {
        const found = this.files.get(normalize(path));
        if (!found) throw new Error(`No such file: ${path}`);
        return found;
      },
      write: async (path, data) => this.put(normalize(path), data),
      append: async (path, data) => {
        const at = normalize(path);
        const before = this.files.get(at);
        if (!before) return this.put(at, data);
        const joined = new Uint8Array(before.length + data.length);
        joined.set(before);
        joined.set(data, before.length);
        this.put(at, joined);
      },
      stat: async (path) => this.statOf(normalize(path)),
      list: async (path) => this.listOf(normalize(path)),
      mkdir: async (path) => this.makeDirs(normalize(path)),
      copy: async (from, to) => {
        const found = this.files.get(normalize(from));
        if (!found) throw new Error(`No such file: ${from}`);
        this.put(normalize(to), found);
      },
      remove: async (path) => this.removeAt(normalize(path)),
      rename: async (from, to) => this.renameAt(normalize(from), normalize(to)),
      makeExecutable: async (path) => {
        this.executable.push(normalize(path));
      },
      freeSpace: async (path) =>
        typeof options.freeSpace === "function" ? options.freeSpace(normalize(path)) : (options.freeSpace ?? null),
    };

    this.registry = {
      read: async (key, value) => {
        const wantedKey = key.toLowerCase();
        for (const [name, values] of Object.entries(options.registry ?? {})) {
          if (name.toLowerCase() !== wantedKey) continue;
          const wantedValue = value.toLowerCase();
          for (const [held, data] of Object.entries(values)) if (held.toLowerCase() === wantedValue) return data;
        }
        return null;
      },
    };

    this.process = {
      launch: async (program, args, launchOptions) => {
        this.launched.push({ program, args, ...(launchOptions ? { options: launchOptions } : {}) });
      },
      run: async (program, args, launchOptions) => {
        this.ran.push({ program, args, ...(launchOptions ? { options: launchOptions } : {}) });
        const canned = options.runs?.[`${program} ${args[0] ?? ""}`.trim()] ?? options.runs?.[program];
        if (canned === undefined) throw new Error(`No such program: ${program}`);
        return canned;
      },
      open: async (target) => {
        this.opened.push(target);
      },
      // Answered from the same table as `run`, keyed by the module's path: which of the two routes a tool
      // took is the host's business, and a test that stated what the tool says should not have to know.
      runWasm: async (module, args) => {
        this.ran.push({ program: module, args, wasm: true });
        const canned = options.runs?.[`${module} ${args[0] ?? ""}`.trim()] ?? options.runs?.[module];
        if (canned === undefined) throw new Error(`No such program: ${module}`);
        return canned;
      },
    };

    this.net = {
      fetchText: async (url) => {
        this.fetched.push(url);
        const body = this.responses[url];
        // A URL with no canned response stands for a host that is not there, which is what the real one
        // reports as well - so a test of the offline path gets the same error type the interface handles.
        if (body === undefined) throw new NetworkError("offline", url, `No canned response for ${url}`);
        // A number is a server that answered without a body - the missing-file case a caller may act on.
        if (typeof body === "number")
          throw new NetworkError("status", url, `${url} answered ${body}`, { status: body });
        return body;
      },
      download: async (url, destination, options) => {
        this.downloaded.push({ url, destination });
        // Refused before the payload is looked up, so a test can cancel a download this platform has no canned
        // answer for and still get the cancel rather than the absence.
        if (options?.signal?.aborted) throw new OperationCancelled();
        const payload = this.payloads[url];
        if (payload === undefined) throw new NetworkError("offline", url, `No canned download for ${url}`);
        const data = typeof payload === "string" ? bytes(payload) : payload;
        // Reported in one go rather than in pieces: there is nothing here to be slow, and a caller that draws
        // progress should still see it reach the end.
        options?.onProgress?.({ received: data.length, total: data.length });
        this.put(normalize(destination), data);
      },
    };

    this.archive = {
      extract: async (archive, destination, options) => {
        this.extracted.push({ archive, destination, ...(options?.only ? { only: [...options.only] } : {}) });
        const inside = this.cannedContents(archive);
        if (!inside) throw new Error(`No canned contents for ${archive}`);
        const wanted = options?.only;
        for (const [name, content] of Object.entries(inside)) {
          if (wanted && !wanted.includes(name)) continue;
          this.put(normalize(`${destination}/${name}`), typeof content === "string" ? bytes(content) : content);
        }
      },
      list: async (archive) => {
        this.listed.push(archive);
        const canned = this.listings[normalize(archive)] ?? this.listings[archive];
        if (canned) return canned;
        const inside = this.cannedContents(archive);
        if (!inside) throw new Error(`No canned contents for ${archive}`);
        return Object.entries(inside).map(([name, content]) => ({ name, kind: "file", size: content.length }));
      },

      createZip: async (destination, entries) => {
        const contents: Record<string, string> = {};
        for (const entry of entries) {
          const found = this.files.get(normalize(entry.source));
          if (!found) throw new Error(`No such file: ${entry.source}`);
          contents[entry.name] = text(found);
        }
        this.zipped.push({ destination, entries, contents });
        this.put(normalize(destination), bytes(entries.map((e) => e.name).join("\n")));
      },
    };

    this.hash = {
      // WebCrypto rather than a Node built-in: this class is also the browser preview's production platform.
      sha256: async (path) => {
        const found = this.files.get(normalize(path));
        if (!found) throw new Error(`No such file: ${path}`);
        // Copied: WebCrypto's types want a plain ArrayBuffer view, which a stored slice may not be.
        const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(found));
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      },
      // WebCrypto has no MD5 - the algorithm was left out of the standard - so this is the one hash the
      // browser preview cannot get from the platform itself; spark-md5 is a pure-JS implementation that runs
      // the same in the browser and in Node, keeping this platform's behavior identical to both.
      md5: async (path) => {
        const found = this.files.get(normalize(path));
        if (!found) throw new Error(`No such file: ${path}`);
        return SparkMD5.ArrayBuffer.hash(new Uint8Array(found).buffer);
      },
    };
  }

  /** The bytes at a path, for asserting on what was written. Undefined when nothing is there. */
  fileAt(path: string): Uint8Array | undefined {
    return this.files.get(normalize(path));
  }

  /** The bytes at a path as a string, one character per byte. */
  textAt(path: string): string | undefined {
    const found = this.files.get(normalize(path));
    return found === undefined ? undefined : text(found);
  }

  /** Every file present, by path, for asserting that a write touched nothing else. */
  allFiles(): string[] {
    return [...this.files.keys()].toSorted();
  }

  /** An archive's canned contents, by its path or by the text sitting at that path. */
  private cannedContents(archive: string): Readonly<Record<string, string | Uint8Array>> | undefined {
    const byPath = this.contents[normalize(archive)] ?? this.contents[archive];
    if (byPath) return byPath;
    const held = this.files.get(normalize(archive));
    return held === undefined ? undefined : this.contents[text(held)];
  }

  private put(path: string, data: Uint8Array): void {
    this.makeDirs(dirname(path));
    this.files.set(path, data);
    this.clock += 1;
    this.times.set(path, this.clock);
  }

  private makeDirs(path: string): void {
    if (path === "" || path === "/") return;
    const parts = path.split("/");
    let at = path.startsWith("/") ? "" : ".";
    for (const part of parts) {
      if (part === "") continue;
      at = at === "." ? part : `${at}/${part}`;
      this.dirs.add(at);
    }
  }

  private statOf(path: string): FileStat | null {
    const file = this.files.get(path);
    if (file) return { kind: "file", size: file.length, modified: this.times.get(path) ?? this.clock };
    if (this.dirs.has(path) || path === "/") return { kind: "dir", size: 0, modified: this.clock };
    return null;
  }

  private listOf(path: string): DirEntry[] {
    if (!this.dirs.has(path) && path !== "/") throw new Error(`Not a directory: ${path}`);
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Map<string, DirEntry["kind"]>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const head = rest.split("/")[0] ?? rest;
      names.set(head, rest.includes("/") ? "dir" : "file");
    }
    for (const key of this.dirs) {
      if (!key.startsWith(prefix) || key === path) continue;
      const rest = key.slice(prefix.length);
      names.set(rest.split("/")[0] ?? rest, "dir");
    }
    return [...names].map(([name, kind]) => ({ name, kind })).toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** Moves a file, or a directory with everything under it - one pass over the keys, as a real rename is. */
  private renameAt(from: string, to: string): void {
    if (this.statOf(from) === null) throw new Error(`No such file or directory: ${from}`);
    for (const key of [...this.files.keys()]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      const moved = key === from ? to : `${to}${key.slice(from.length)}`;
      const held = this.files.get(key);
      this.files.delete(key);
      this.times.delete(key);
      if (held) this.put(moved, held);
    }
    for (const key of [...this.dirs]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      this.dirs.delete(key);
      this.makeDirs(key === from ? to : `${to}${key.slice(from.length)}`);
    }
  }

  private removeAt(path: string): void {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
    for (const key of [...this.dirs]) {
      if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key);
    }
  }
}
