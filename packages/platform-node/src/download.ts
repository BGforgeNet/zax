/**
 * Downloading a file, on a connection that may be slow, lossy, or not there at all.
 *
 * The naive form - `fetch`, `arrayBuffer`, write - fails four ways that all reach the user as the word
 * "failed", so each is named here instead. A cap on the whole transfer kills a slow link that is still making
 * progress, so the deadline measures silence rather than duration. The body is streamed to a partial file
 * rather than held whole in memory, which is also what makes resuming possible. A body that stops short of
 * its declared length is a failure, not a truncated file the caller has to think to check. And an attempt
 * that died mid-transfer resumes where it stopped, because spending minutes of a poor connection and then
 * starting again from nothing is how a download never finishes at all.
 *
 * Hand-written although download libraries with resume and retry exist: the failure taxonomy here - offline
 * vs timeout vs incomplete vs status, each with its own user-facing wording - is the point, and mapping a
 * library's error surface back onto it would cost more than the mechanics being replaced.
 */

import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { NetworkError, OperationCancelled, type DownloadOptions, type NetworkFailure } from "@zax/platform";

/**
 * How long the transfer may produce nothing before it is abandoned. Deliberately not a limit on the whole
 * download: 880 KB of sfall over a weak link legitimately takes minutes, and a total budget makes that
 * indistinguishable from a dead mirror.
 */
const IDLE_TIMEOUT_MS = 20_000;

/** How long to wait for the response head. A server silent this long is not going to answer. */
const RESPONSE_TIMEOUT_MS = 30_000;

/** Attempts in total, not retries after the first. */
const ATTEMPTS = 3;

const BACKOFF_MS = [500, 2_000];

/** Statuses worth trying again: the server is up but cannot answer this moment. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** One line's worth of what an attempt did, for the log a bug report carries. */
export interface AttemptNote {
  url: string;
  attempt: number;
  received: number;
  total: number | null;
  ms: number;
  outcome: string;
  resumedFrom: number;
}

/**
 * How patient to be. Part of the signature rather than fixed constants because it is the policy this function
 * implements, and the stall and retry paths cannot be exercised in a test at production patience - a suite
 * that waits twenty seconds to prove a timeout works is a suite nobody runs.
 */
export interface DownloadPolicy {
  idleTimeoutMs: number;
  responseTimeoutMs: number;
  attempts: number;
  backoffMs: readonly number[];
}

export const DEFAULT_POLICY: DownloadPolicy = {
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  responseTimeoutMs: RESPONSE_TIMEOUT_MS,
  attempts: ATTEMPTS,
  backoffMs: BACKOFF_MS,
};

export interface DownloadDeps extends DownloadOptions {
  note?: (note: AttemptNote) => void;
  policy?: Partial<DownloadPolicy>;
}

/**
 * Whether the transport never reached the host at all, as opposed to reaching it and losing it part way.
 * Both arrive as a rejected `fetch`, and telling a user to check their network connection when the mirror
 * actually dropped a connection mid-file sends them looking in the wrong place. Node keeps the distinction in
 * the error's `cause`.
 */
function unreachable(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
  return (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // Not a URL at all, which is a caller's bug rather than the network's - say what was asked for.
    return url;
  }
}

/** The sentence the user reads. Written here because the kind does not survive the channel to the interface. */
function humanReason(kind: NetworkFailure, url: string, detail: string): string {
  const host = hostOf(url);
  if (kind === "offline") return `${host} could not be reached - check the network connection.`;
  if (kind === "timeout") return `${host} stopped responding part way through the download.`;
  if (kind === "incomplete") return `${host} closed the connection before the file was complete.`;
  return `${host} answered with ${detail}.`;
}

/** Bytes already in the partial file, which is where a resumed attempt starts. */
async function partialSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Removes the bytes and the source record together, so neither can give meaning to the other after failure. */
async function discardPartial(partial: string, identity: string): Promise<void> {
  await Promise.all([rm(partial, { force: true }), rm(identity, { force: true })]);
}

/**
 * Keeps a partial only when it belongs to this request. A destination is routinely reused for another release,
 * and byte count alone cannot say that its prefix came from the URL now asking to append to it.
 */
async function preparePartial(partial: string, identity: string, url: string): Promise<void> {
  let sameSource = false;
  try {
    const saved = JSON.parse(await readFile(identity, "utf8")) as { version?: unknown; url?: unknown };
    sameSource = saved.version === 1 && saved.url === url;
  } catch {
    // A missing or interrupted record grants no identity to the bytes beside it.
  }
  if (!sameSource) await discardPartial(partial, identity);
  await writeFile(identity, JSON.stringify({ version: 1, url }), "utf8");
}

/**
 * One attempt, resolving once the body has been written whole. `from` is where to resume; whether that is
 * honoured is the server's decision, and the answer says which.
 */
async function attempt(
  url: string,
  partial: string,
  from: number,
  options: DownloadDeps,
  policy: DownloadPolicy,
): Promise<{ received: number; total: number | null }> {
  const controller = new AbortController();
  // Armed before the request and rearmed on every chunk, so the deadline measures silence, not length.
  let idle: ReturnType<typeof setTimeout> | undefined;
  let silent = false;
  const arm = (ms: number) => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      silent = true;
      controller.abort();
    }, ms);
  };

  // The caller's cancel and the idle deadline stop the same transfer, so `fetch` is given both as one signal.
  // Composed rather than listened to: the pair is discarded with the attempt, where a listener on the caller's
  // signal would outlive it and accumulate one per retry.
  const cancelled = () => options.signal?.aborted === true;
  if (cancelled()) throw new OperationCancelled();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

  arm(policy.responseTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      // A resumed attempt asks for the rest; a first attempt sends no range, so a mirror that mishandles one
      // is never given the chance.
      ...(from > 0 ? { headers: { Range: `bytes=${from}-` } } : {}),
    });
  } catch (error) {
    clearTimeout(idle);
    if (cancelled()) throw new OperationCancelled();
    // `fetch` rejects only when no response could be had; anything the server said arrives as a Response,
    // however unwelcome. A reused keep-alive socket that the server has since dropped rejects here too, which
    // is a lost connection rather than an absent network.
    const kind: NetworkFailure = silent ? "timeout" : unreachable(error) ? "offline" : "incomplete";
    throw new NetworkError(kind, url, humanReason(kind, url, ""), { cause: error });
  }

  if (!response.ok) {
    clearTimeout(idle);
    const detail = `${response.status} ${response.statusText}`.trim();
    throw new NetworkError("status", url, humanReason("status", url, detail), { status: response.status });
  }

  // A server is free to ignore `Range` and answer 200 with the whole file; appending to the partial then
  // would splice two copies together.
  const resuming = from > 0 && response.status === 206;
  const startAt = resuming ? from : 0;

  const declared = Number(response.headers.get("content-length"));
  const remaining = response.headers.get("content-length") === null || Number.isNaN(declared) ? null : declared;
  const total = remaining === null ? null : startAt + remaining;

  let received = startAt;
  options.onProgress?.({ received, total });

  if (!response.body) throw new NetworkError("incomplete", url, humanReason("incomplete", url, ""));

  const sink = createWriteStream(partial, { flags: resuming ? "a" : "w" });
  // Read through the reader rather than by iteration: the web stream type carries no async iterator, and a
  // cast to say otherwise would be asserting a runtime detail the checker cannot see.
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      arm(policy.idleTimeoutMs);
      options.onProgress?.({ received, total });
      if (!sink.write(value)) await once(sink, "drain");
    }
    sink.end();
    await finished(sink);
  } catch (error) {
    // Closed rather than destroyed: `destroy` drops whatever is still buffered, and those bytes are exactly
    // what the next attempt resumes from. Losing them silently turns resume back into starting over. A cancel
    // wants that flush for the same reason, so it happens before the two part ways.
    sink.end();
    await finished(sink).catch(() => undefined);
    if (cancelled()) throw new OperationCancelled();
    // A connection dropped mid-body and a connection that went quiet are both "the file did not arrive"; the
    // only distinction worth drawing is which of the two the log should say.
    const kind: NetworkFailure = silent ? "timeout" : "incomplete";
    throw new NetworkError(kind, url, humanReason(kind, url, ""), { cause: error });
  } finally {
    clearTimeout(idle);
  }

  // The check the buffered version never made: a chunked body that ends early is indistinguishable from a
  // complete one unless the declared length is compared against what turned up.
  if (total !== null && received !== total) {
    throw new NetworkError(
      "incomplete",
      url,
      `${humanReason("incomplete", url, "")} Got ${received} of ${total} bytes.`,
    );
  }

  return { received, total };
}

/**
 * Downloads a URL to a destination, retrying what is worth retrying and resuming where the server allows it.
 * The destination appears only once the whole body is there, so no reader can catch a half-written file and a
 * crash part way leaves a partial rather than something that passes for a finished download.
 */
export async function downloadFile(url: string, destination: string, options: DownloadDeps = {}): Promise<void> {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.zax-partial`;
  const identity = `${partial}.json`;
  await preparePartial(partial, identity, url);

  let last: unknown;
  for (let n = 1; n <= policy.attempts; n++) {
    const from = await partialSize(partial);
    const started = Date.now();
    try {
      const { received, total } = await attempt(url, partial, from, options, policy);
      options.note?.({ url, attempt: n, received, total, ms: Date.now() - started, outcome: "ok", resumedFrom: from });
      // Flushed before the rename, so the destination never names bytes that are still only in a cache.
      const handle = await open(partial, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(partial, destination);
      await rm(identity, { force: true });
      return;
    } catch (error) {
      last = error;
      const failure = error instanceof NetworkError ? error : null;
      const status = failure?.status;
      const stopped = error instanceof OperationCancelled;
      options.note?.({
        url,
        attempt: n,
        received: await partialSize(partial),
        total: null,
        ms: Date.now() - started,
        outcome: stopped ? "cancelled" : `${failure?.kind ?? "error"}${status === undefined ? "" : ` ${status}`}`,
        resumedFrom: from,
      });

      // Nothing failed, so there is nothing to retry and nothing to clear away: the bytes already fetched are
      // what makes resuming a cancelled download cheaper than starting it over. Thrown rather than broken out
      // of, since the exit below drops the partial.
      if (stopped) {
        if ((await partialSize(partial)) === 0) await discardPartial(partial, identity);
        throw error;
      }

      // A range the server would not satisfy means the partial is not a prefix of what is being fetched.
      // Dropping it costs one restart; keeping it corrupts every attempt after this one.
      if (status === 416 || status === 404) await discardPartial(partial, identity);

      const kind = failure?.kind;
      const retryable =
        kind === "timeout" ||
        kind === "incomplete" ||
        kind === "offline" ||
        (kind === "status" && status !== undefined && RETRYABLE_STATUS.has(status));
      if (!retryable || n === policy.attempts) break;
      await new Promise((resolve) => setTimeout(resolve, policy.backoffMs[n - 1] ?? 2_000));
    }
  }

  // Nothing usable is left: a stale partial would be resumed onto by a later call for a different file that
  // happens to want the same destination.
  await discardPartial(partial, identity);
  throw last;
}
