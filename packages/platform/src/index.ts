/**
 * The one interface through which everything outside the process is reached: files, directories, per-user paths,
 * child processes, the network and archives. No other package calls `fs`, `child_process` or `fetch` directly.
 *
 * Two reasons for the seam. Domain tests run against the in-memory implementation in `./memory`, with no Node
 * built-ins loaded at all. And a future native shell replaces one module rather than every call site.
 */

export type OperatingSystem = "windows" | "macos" | "linux";

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
}

export interface ProcessLauncher {
  /**
   * Starts a program and resolves once it has started, not once it has exited: the game outlives the click that
   * launched it, and a manager that blocks until the user quits Fallout is not a manager.
   */
  launch(program: string, args: readonly string[], options?: LaunchOptions): Promise<void>;
  /** Hands a file or directory to the desktop's own handler - the file manager, the text editor, the browser. */
  open(target: string): Promise<void>;
}

export interface Network {
  fetchText(url: string): Promise<string>;
  download(url: string, destination: string): Promise<void>;
}

/** One file to put in an archive: where it is now, and the path it should have inside. */
export interface ArchiveEntry {
  source: string;
  name: string;
}

export interface Archive {
  /** Extracts an archive whole. The format is decided by the implementation from the file itself. */
  extract(archive: string, destination: string): Promise<void>;
  /** Writes a zip. Only the debug package creates archives, and a zip is what a bug report can attach. */
  createZip(destination: string, entries: readonly ArchiveEntry[]): Promise<void>;
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
  readonly fs: FileSystem;
  readonly paths: Paths;
  readonly process: ProcessLauncher;
  readonly net: Network;
  readonly archive: Archive;
  readonly registry: Registry;
}
