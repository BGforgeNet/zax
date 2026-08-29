/**
 * The one interface through which everything outside the process is reached: files, directories, per-user paths,
 * child processes, the network and archives. No other package calls `fs`, `child_process` or `fetch` directly.
 *
 * Two reasons for the seam. Domain tests run against the in-memory implementation in `./memory`, with no Node
 * built-ins loaded at all. And a future native shell replaces one module rather than every call site.
 */

export type OperatingSystem = "windows" | "macos" | "linux";

/**
 * The processor a build has to match. `other` is every architecture ZAX names no build for, which is a real
 * answer rather than a gap: a caller that has no build for the pair falls back to a portable one, and a wrong
 * guess here would hand a host a binary it cannot execute.
 */
export type Architecture = "x64" | "arm64" | "other";

export type FileKind = "file" | "dir" | "other";

export interface FileStat {
  kind: FileKind;
  /** Bytes for a file, unspecified for anything else. */
  size: number;
  /** Last modification, in milliseconds since the epoch. */
  modified: number;
}

export interface DirEntry {
  name: string;
  kind: FileKind;
}

/**
 * Bytes in and bytes out, never decoded text: config files are read as latin1 and application state as UTF-8,
 * and which one applies is the caller's business rather than this layer's.
 */
export interface FileSystem {
  /** Rejects when the path does not exist. Use `stat` to ask whether it does. */
  read(path: string): Promise<Uint8Array>;
  /** Creates parent directories as needed, so a caller never has to order the two calls. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Adds to the end of a file, creating it and its parents when absent. Separate from `write` because the log is
   * appended to a line at a time, and rewriting it whole per line makes its cost grow with its length.
   */
  append(path: string, bytes: Uint8Array): Promise<void>;
  /** Null rather than a rejection when the path does not exist - absence is an ordinary answer here. */
  stat(path: string): Promise<FileStat | null>;
  /** Rejects when the path is not a directory. */
  list(path: string): Promise<readonly DirEntry[]>;
  /** Recursive, and silent when the directory already exists. */
  mkdir(path: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** Recursive, and silent when the path is already gone. */
  remove(path: string): Promise<void>;
  /**
   * Moves a file or directory. Distinct from copy-and-delete because a rename that only changes case is not a
   * copy anywhere - on a case-insensitive filesystem the two paths are one file - and because copying RPU's
   * gigabyte to change a letter is not something to do at all.
   */
  rename(from: string, to: string): Promise<void>;
  /**
   * Bytes available on the filesystem holding this path, or null where the host cannot say - a browser has no
   * answer, and neither has a path that is not there. A check that cannot run is not a check that failed.
   */
  freeSpace(path: string): Promise<number | null>;
  /**
   * Marks a file runnable. Needed because a script that arrives inside an archive may arrive without its
   * mode, and a mod's installer that cannot be executed is an install that cannot happen. A no-op where the
   * host has no such bit.
   */
  makeExecutable(path: string): Promise<void>;
}

/**
 * Where this application's own files live, and how to build a path. Joining is here rather than in a utility
 * because the separator is a property of the host, and the in-memory implementation is deliberately not the host.
 */
export interface Paths {
  /** Per-user configuration directory for this application. `zax.yml` sits directly in it. */
  readonly config: string;
  /** Per-user cache directory. Backups, debug archives and the log sit under it. */
  readonly cache: string;
  readonly home: string;
  readonly separator: string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
}

export interface LaunchOptions {
  cwd?: string;
  /** Added to the inherited environment rather than replacing it, so a Wine prefix does not cost the user PATH. */
  env?: Readonly<Record<string, string>>;
  /**
   * A file to send both output streams to, replacing what is there. Only `launch` honours it: a program ZAX
   * waits for answers with its output, while one that outlives ZAX would otherwise write to a console the
   * desktop build does not have.
   */
  log?: string;
}

/** What a program that ran to completion left behind. */
export interface RunOutcome {
  /** Its exit code, or null when a signal killed it rather than it exiting. */
  code: number | null;
  /**
   * What it wrote, both streams interleaved as they arrived, and the tail where there was too much of it: a
   * failing installer says why at the end, and the beginning of its log is the part nobody needs.
   */
  output: string;
}

export interface ProcessLauncher {
  /**
   * Starts a program and resolves once it has started, not once it has exited: the game outlives the click that
   * launched it, and a manager that blocks until the user quits Fallout is not a manager.
   */
  launch(program: string, args: readonly string[], options?: LaunchOptions): Promise<void>;
  /**
   * Starts a program and resolves once it has EXITED, with its code and its output - the opposite of `launch`
   * and for the opposite case: an installer's whole result is what it did and what it said about it, and
   * everything ZAX does afterwards reads what it wrote. A program that could not be started at all rejects; a
   * program that ran and failed answers with its code, which is a result rather than an error.
   */
  run(program: string, args: readonly string[], options?: LaunchOptions): Promise<RunOutcome>;
  /** Hands a file or directory to the desktop's own handler - the file manager, the text editor, the browser. */
  open(target: string): Promise<void>;
  /**
   * Runs a WebAssembly module compiled against WASI and answers as `run` does. Separate from `run` because a
   * module is not a program the operating system can start: something has to host it, and which something is
   * the host's business rather than the caller's.
   *
   * The module is given the whole filesystem, which is the authority a native build of the same tool would
   * have had - the point of running one is that ZAX has no native build for this machine, not that it trusts
   * the tool less.
   */
  runWasm(module: string, args: readonly string[]): Promise<RunOutcome>;
}

/**
 * Why a network operation failed. Carried so a caller can say which of these happened rather than passing on
 * whatever the runtime called it - every one of them arrives from `fetch` as the single word "failed".
 */
export type NetworkFailure =
  /** The host did not resolve, or refused the connection. Usually no network at all. */
  | "offline"
  /** Nothing arrived for long enough that the transfer was abandoned. */
  | "timeout"
  /** The server answered, with something other than success. */
  | "status"
  /** The body ended before the length the server declared. */
  | "incomplete";

/**
 * A network failure with its cause named. The message is written for the user, because it is the one that
 * reaches them: an Electron channel carries an error's message across processes and drops its class and its
 * fields, so anything a caller in the interface needs has to be in the text.
 */
export class NetworkError extends Error {
  /** The response status, when there was a response at all. Decides whether trying again is worth anything. */
  readonly status: number | undefined;

  constructor(
    readonly kind: NetworkFailure,
    readonly url: string,
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options);
    this.name = "NetworkError";
    this.status = options?.status;
  }
}

/** How far a download has got. `total` is null when the server declared no length. */
export interface DownloadProgress {
  received: number;
  total: number | null;
}

/**
 * The user stopped it, as opposed to it failing. Its own type rather than a `NetworkError` kind: nothing went
 * wrong with the network, nothing is worth retrying, and the partial file is worth keeping rather than clearing
 * away - all three the opposite of what a failure means here.
 */
export class OperationCancelled extends Error {
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "OperationCancelled";
  }
}

export interface DownloadOptions {
  /** Called as the body arrives, for an interface that shows how far along a long download is. */
  onProgress?: (progress: DownloadProgress) => void;
  /**
   * Stops the transfer where it is, rejecting with `OperationCancelled` and leaving the partial file for a
   * later call to resume from. Only the transfer: whatever the caller does with the file afterwards is its own
   * to abandon or finish.
   */
  signal?: AbortSignal;
}

export interface Network {
  fetchText(url: string): Promise<string>;
  /**
   * Writes the whole body at the destination, or rejects with a `NetworkError`. Complete is part of the
   * contract: a body that stops short of its declared length is a failure here rather than a short file the
   * caller has to think to check.
   */
  download(url: string, destination: string, options?: DownloadOptions): Promise<void>;
}

/** One file to put in an archive: where it is now, and the path it should have inside. */
export interface ArchiveEntry {
  source: string;
  name: string;
}

/** One entry of an archive's directory, read without extracting anything. */
export interface ArchiveEntryInfo {
  /** The path inside the archive, `/`-separated as archives store it. */
  name: string;
  /** Links are named so a caller can refuse them - an entry that plants a link and then writes through it is
   * the classic installer escape, and extraction is too late to find out. */
  kind: "file" | "dir" | "link";
  /** Declared uncompressed bytes. A declaration to judge - a decompression bomb lies here - not a fact. */
  size: number;
}

export interface ExtractOptions {
  /**
   * Names inside the archive to extract, instead of all of them. Reading one file out of a release is most of
   * what this is asked for, and unpacking the rest to delete it is work nobody wanted.
   */
  only?: readonly string[];
}

export interface Archive {
  /** Extracts an archive. The format is decided by the implementation from the file itself. */
  extract(archive: string, destination: string, options?: ExtractOptions): Promise<void>;
  /**
   * The archive's directory: every entry with its declared size, links flagged. What a mod install's
   * preflight judges - size ceilings, entry counts, link refusal - before anything is extracted.
   */
  list(archive: string): Promise<readonly ArchiveEntryInfo[]>;
  /** Writes a zip. Only the debug package creates archives, and a zip is what a bug report can attach. */
  createZip(destination: string, entries: readonly ArchiveEntry[]): Promise<void>;
}

export interface Hashing {
  /** Lowercase hex SHA-256 of the file at a path - what a release asset's stated digest is checked against. */
  sha256(path: string): Promise<string>;
  /** Lowercase hex MD5 of the file at a path - what SourceForge's own file listing publishes per release. */
  md5(path: string): Promise<string>;
}

/**
 * The Windows registry, which is where the launchers record what they installed and where. Part of the seam
 * rather than a shell-out because reading it needs a program's output, and `ProcessLauncher` deliberately does
 * not offer that - it starts things that outlive the call.
 *
 * Present on every platform and answering null off Windows, so a caller asks the same question everywhere
 * instead of branching on the operating system before every read.
 */
export interface Registry {
  /**
   * A value under a key, or null when the key, the value or the registry itself is not there. Absence is the
   * ordinary answer here: most machines have none of the keys ZAX asks about.
   */
  read(key: string, value: string): Promise<string | null>;
}

export interface Platform {
  readonly os: OperatingSystem;
  readonly arch: Architecture;
  readonly fs: FileSystem;
  readonly paths: Paths;
  readonly process: ProcessLauncher;
  readonly net: Network;
  readonly archive: Archive;
  readonly hash: Hashing;
  readonly registry: Registry;
}
