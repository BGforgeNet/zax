/**
 * One writer at a time in a game directory, across processes.
 *
 * The store's own gate already serialises everything one ZAX does, so what this is for is the writers that
 * gate cannot see: another machine reaching the same folder over a share, another account on this one, and -
 * the case it was built for - an installer still running from a ZAX that died. That last one is why the lock
 * names the installer's process id rather than ZAX's: ZAX's id is gone precisely when the question is asked,
 * while the installer's is still there to be found, so a lock naming ZAX would read as abandoned at the one
 * moment it is not.
 *
 * It does not stop that installer from writing - nothing here can, it is upstream's program and knows nothing
 * about ZAX. What it stops is the second writer: the retry the next run would otherwise offer over the top.
 *
 * A lock nobody holds must not strand the install, so a stale one is broken rather than reported: an id this
 * machine is not running is an id nothing is writing under. The unknown cases all answer "not running", which
 * frees the lock - the direction that costs a warning rather than an install nobody can perform.
 */

import type { Platform } from "@zax/platform";

/** The file, at the top of the install beside the config files ZAX already writes there. */
const LOCK_NAME = ".zax-lock";

/** What a lock says about itself. Every field is for the message a refusal has to write. */
interface LockRecord {
  /** The machine that took it, which is the only thing a lock on a share can be judged by from elsewhere. */
  host: string;
  /** The process writing under it - the installer where one is running, ZAX itself until then. */
  pid: number;
  /** What is being done, so a refusal names the operation rather than only its directory. */
  what: string;
  /**
   * The program the id was started as, once one has been handed the claim. What it settles is reuse: the
   * system hands ids out again, so an id that is alive may be alive as something with nothing to do with this
   * install, and the command is the only thing that tells those apart.
   */
  command?: string;
  /** When it was taken, in milliseconds since the epoch. Reported, never used to decide staleness. */
  taken: number;
}

const lockPath = (platform: Platform, install: string): string => platform.paths.join(install, LOCK_NAME);

const encode = (record: LockRecord): Uint8Array => new TextEncoder().encode(`${JSON.stringify(record)}\n`);

/**
 * What a lock file holds, or nothing where it holds something this version cannot read. A lock ZAX cannot
 * parse is treated as absent rather than as a refusal: the alternative is a truncated write from a killed
 * process locking the directory for good, and the file is ZAX's own rather than anything a user wrote.
 */
function decode(bytes: Uint8Array): LockRecord | null {
  let held: unknown;
  try {
    held = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof held !== "object" || held === null) return null;
  const record = held as Partial<LockRecord>;
  if (typeof record.host !== "string" || typeof record.pid !== "number") return null;
  return {
    host: record.host,
    pid: record.pid,
    what: typeof record.what === "string" ? record.what : "an operation",
    taken: typeof record.taken === "number" ? record.taken : 0,
    ...(typeof record.command === "string" ? { command: record.command } : {}),
  };
}

/** The refusal a held lock produces, naming what holds it and where, which is what tells the user what to do. */
function refusal(record: LockRecord, here: string): string {
  const where = record.host === here ? "on this machine" : `on ${record.host}`;
  return (
    `${record.what} is already running in this game folder ${where}, as process ${record.pid}. ` +
    `Wait for it to finish, or close it, before starting another.`
  );
}

/** Held by the caller for as long as it writes: `release` in a `finally`, `handOver` when it spawns. */
export interface InstallLock {
  /**
   * Names a different process as the writer - the installer, once it has started. Until this is called the
   * lock names ZAX, which is right while ZAX is the one writing and wrong the moment it is not.
   */
  handOver(pid: number, command: string): Promise<void>;
  release(): Promise<void>;
}

/**
 * Claims the directory, or answers why it could not. Takes the lock over where the one already there names a
 * process that is not running, since that is a lock whose owner is gone rather than a directory in use.
 */
export async function takeInstallLock(
  platform: Platform,
  install: string,
  what: string,
): Promise<InstallLock | { refused: string }> {
  const at = lockPath(platform, install);
  const { host, pid } = platform.process.self;
  const mine: LockRecord = { host, pid, what, taken: Date.now() };

  if (await platform.fs.createExclusive(at, encode(mine))) return holder(platform, at, mine);

  const existing = decode(await platform.fs.read(at).catch(() => new Uint8Array()));
  // Only this machine can answer for an id. A lock from elsewhere is left alone whatever its age: the run
  // that took it is somebody else's to finish, and breaking it would be the second writer this prevents.
  if (existing !== null && existing.host !== host) return { refused: refusal(existing, host) };
  if (existing !== null && (await platform.process.alive(existing.pid)) && (await stillIt(platform, existing)))
    return { refused: refusal(existing, host) };
  // Nobody is writing under it: an id this machine is not running, a file too damaged to name one, or one
  // that went away between the claim and the read. Cleared rather than deferred to, since each of those
  // stands between the user and an install that nothing is actually performing.
  await platform.fs.remove(at);
  return claimAgain(platform, at, mine);
}

/**
 * Whether a live id is still the program the claim was handed to, rather than a number the system has since
 * given to something else. Only a positive disagreement counts: a host that cannot say what an id is running
 * answers null, and treating that as a mismatch would break claims on every host without the answer.
 *
 * A claim that never reached an installer names no command, and the id in it is ZAX's own - alive means
 * another ZAX, which is a refusal on its own terms.
 */
async function stillIt(platform: Platform, existing: LockRecord): Promise<boolean> {
  if (existing.command === undefined) return true;
  const running = await platform.process.commandOf(existing.pid);
  if (running === null) return true;
  return running.includes(platform.paths.basename(existing.command));
}

/**
 * One more attempt, after clearing a lock nobody held. Once only: a third would be racing whoever took it in
 * between, and losing that race twice is an answer rather than a reason to keep trying.
 */
async function claimAgain(
  platform: Platform,
  at: string,
  mine: LockRecord,
): Promise<InstallLock | { refused: string }> {
  if (await platform.fs.createExclusive(at, encode(mine))) return holder(platform, at, mine);
  const won = decode(await platform.fs.read(at).catch(() => new Uint8Array()));
  return { refused: won === null ? "Another ZAX is writing to this game folder." : refusal(won, mine.host) };
}

function holder(platform: Platform, at: string, mine: LockRecord): InstallLock {
  let held = true;
  return {
    handOver: async (pid, command) => {
      if (!held) return;
      await platform.fs.write(at, encode({ ...mine, pid, command }));
    },
    release: async () => {
      held = false;
      await platform.fs.remove(at);
    },
  };
}
