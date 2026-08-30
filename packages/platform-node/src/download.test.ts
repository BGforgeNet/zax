/**
 * The download, against a real server told to misbehave in each of the ways a mirror does.
 *
 * A local HTTP server rather than a mocked `fetch`: what is under test is how the transport behaves - ranges,
 * chunked bodies that stop early, connections that go quiet - and a stub for `fetch` would be a stub for
 * exactly the thing that decides the answer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkError, OperationCancelled } from "@zax/platform";
import { downloadFile } from "./download.js";

/** The payload every case serves, when it serves a whole one. */
const BODY = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

/** Impatient on purpose: these paths are about what happens when time runs out, not about how long it takes. */
const QUICK = { idleTimeoutMs: 150, responseTimeoutMs: 150, attempts: 3, backoffMs: [1, 1] };

let server: Server;
let base: string;
let directory: string;
let handler: (response: ServerResponse, range: string | undefined) => void;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zax-download-"));
  server = createServer((request, response) => handler(response, request.headers.range));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => void server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

const destination = () => join(directory, "payload.bin");
const partial = () => `${destination()}.zax-partial`;
const partialIdentity = () => `${partial()}.json`;

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe("a server that answers properly", () => {
  it("writes the whole body and reports it arriving", async () => {
    handler = (response) => {
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.end(BODY);
    };
    const seen: Array<{ received: number; total: number | null }> = [];
    await downloadFile(`${base}/f`, destination(), { onProgress: (p) => seen.push({ ...p }), policy: QUICK });

    expect(await readFile(destination())).toEqual(BODY);
    expect(seen.at(-1)).toEqual({ received: BODY.length, total: BODY.length });
    expect(await exists(partial()), "the partial is gone once the real name exists").toBe(false);
  });

  it("keeps a slow but advancing transfer, which a deadline on the whole download would have killed", async () => {
    // Six pieces, each landing well inside the idle window but taking far longer in total than one.
    handler = (response) => {
      response.writeHead(200, { "content-length": String(BODY.length) });
      let sent = 0;
      const step = () => {
        if (sent >= BODY.length) return response.end();
        response.write(BODY.subarray(sent, sent + 700));
        sent += 700;
        setTimeout(step, 60);
      };
      step();
    };
    await downloadFile(`${base}/f`, destination(), { policy: QUICK });
    expect(await readFile(destination())).toEqual(BODY);
  });
});

describe("a body that does not arrive whole", () => {
  it("cannot tell a short chunked body from a whole one, which is why the caller checks what it got", async () => {
    // A chunked response that ends early is byte-for-byte what a complete short response looks like: no
    // length was declared, so there is nothing here to compare against. The transport genuinely cannot catch
    // this one, and that is the reason `sfallPackage` checks the archive's own magic afterwards rather than
    // trusting a download that resolved.
    handler = (response) => {
      response.writeHead(200, {});
      response.write(BODY.subarray(0, 1000));
      response.end();
    };
    await downloadFile(`${base}/f`, destination(), { policy: QUICK });
    expect((await readFile(destination())).length).toBe(1000);
  });

  it("refuses a body shorter than the length the server declared", async () => {
    handler = (response) => {
      response.writeHead(200, { "content-length": String(BODY.length) });
      // Destroyed only once the bytes are on the wire; destroying straight after `write` discards them, and
      // the test would then be about an empty body rather than a short one.
      response.write(BODY.subarray(0, 1000), () => response.destroy());
    };
    const failure = await downloadFile(`${base}/f`, destination(), { policy: QUICK }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(NetworkError);
    expect((failure as NetworkError).kind).toBe("incomplete");
    expect(await exists(destination()), "nothing is left under the real name").toBe(false);
    expect(await exists(partial()), "and no partial survives to be resumed onto later").toBe(false);
  });

  it("gives up on a connection that goes quiet, and says so", async () => {
    handler = (response) => {
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.write(BODY.subarray(0, 100));
      // Never writes again and never closes: the case a total timeout and an idle timeout both catch, but
      // only one of them catches without also failing the slow transfer above.
    };
    const failure = await downloadFile(`${base}/f`, destination(), { policy: QUICK }).catch((e: unknown) => e);

    expect((failure as NetworkError).kind).toBe("timeout");
    expect((failure as NetworkError).message).toContain("stopped responding");
  });
});

describe("retrying", () => {
  it("resumes from what it already has when the server honours a range", async () => {
    let call = 0;
    const ranges: Array<string | undefined> = [];
    handler = (response, range) => {
      call += 1;
      ranges.push(range);
      if (call === 1) {
        response.writeHead(200, { "content-length": String(BODY.length) });
        response.write(BODY.subarray(0, 1500), () => response.destroy());
        return;
      }
      const from = Number(/bytes=(\d+)-/.exec(range ?? "")?.[1] ?? 0);
      response.writeHead(206, {
        "content-length": String(BODY.length - from),
        "content-range": `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
      });
      response.end(BODY.subarray(from));
    };

    await downloadFile(`${base}/f`, destination(), { policy: QUICK });

    expect(await readFile(destination()), "the two halves join into the original").toEqual(BODY);
    expect(ranges[0], "the first attempt asks for the whole thing").toBeUndefined();
    expect(ranges[1], "the second asks only for the rest").toBe("bytes=1500-");
  });

  it("starts over when the server ignores the range and sends the whole file again", async () => {
    let call = 0;
    handler = (response) => {
      call += 1;
      if (call === 1) {
        response.writeHead(200, { "content-length": String(BODY.length) });
        response.write(BODY.subarray(0, 1500), () => response.destroy());
        return;
      }
      // 200 rather than 206: appending here would splice 1500 bytes onto a complete copy.
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.end(BODY);
    };

    await downloadFile(`${base}/f`, destination(), { policy: QUICK });
    expect(await readFile(destination())).toEqual(BODY);
  });

  it("tries again on a status that means the server is merely busy", async () => {
    let call = 0;
    handler = (response) => {
      call += 1;
      if (call < 3) {
        response.writeHead(503);
        response.end("busy");
        return;
      }
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.end(BODY);
    };

    await downloadFile(`${base}/f`, destination(), { policy: QUICK });
    expect(call).toBe(3);
    expect(await readFile(destination())).toEqual(BODY);
  });

  it("does not try again on a status that will not change", async () => {
    let call = 0;
    handler = (response) => {
      call += 1;
      response.writeHead(404);
      response.end("gone");
    };
    const failure = await downloadFile(`${base}/f`, destination(), { policy: QUICK }).catch((e: unknown) => e);

    expect(call, "asking four more times would not make it appear").toBe(1);
    expect((failure as NetworkError).kind).toBe("status");
    expect((failure as NetworkError).status).toBe(404);
    expect((failure as NetworkError).message).toContain("404");
  });

  it("names an unreachable host rather than passing on the runtime's word for it", async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => void server.close(() => resolve()));
    const failure = await downloadFile(`${base}/f`, destination(), { policy: QUICK }).catch((e: unknown) => e);

    expect((failure as NetworkError).kind).toBe("offline");
    expect((failure as NetworkError).message).toContain("check the network connection");
  });
});

describe("what is left on disk", () => {
  it("never leaves a stale partial for an unrelated later download to resume onto", async () => {
    await writeFile(partial(), Buffer.from("left by something else"));
    handler = (response) => {
      response.writeHead(404);
      response.end();
    };
    await downloadFile(`${base}/f`, destination(), { policy: QUICK }).catch(() => undefined);
    expect(await exists(partial())).toBe(false);
  });

  it("logs each attempt with how far it got, which is what a report from a poor connection needs", async () => {
    let call = 0;
    handler = (response) => {
      call += 1;
      if (call === 1) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.end(BODY);
    };
    const notes: string[] = [];
    await downloadFile(`${base}/f`, destination(), {
      policy: QUICK,
      note: (n) => notes.push(`${n.attempt} ${n.outcome} ${n.received}`),
    });

    expect(notes[0]).toBe("1 status 503 0");
    expect(notes[1]).toBe(`2 ok ${BODY.length}`);
  });
});

describe("cancelling", () => {
  /**
   * A server that hands over a first piece and then holds the connection open, so a cancel lands part way
   * through a body rather than between whole ones - which is where a real one lands.
   */
  const stalling = (first: number) => {
    handler = (response) => {
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.write(BODY.subarray(0, first));
    };
  };

  it("stops the transfer and says so, rather than reporting a network failure", async () => {
    stalling(700);
    const controller = new AbortController();
    const failure = await downloadFile(`${base}/f`, destination(), {
      policy: QUICK,
      signal: controller.signal,
      // After bytes have actually landed: the first report fires at zero, before the body is read at all.
      onProgress: ({ received }) => void (received > 0 && controller.abort()),
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(OperationCancelled);
    expect(failure, "a cancel is not one of the network's failures").not.toBeInstanceOf(NetworkError);
  });

  /*
    The point of cancelling rather than failing: the bytes already paid for on a poor connection are what a
    later attempt resumes from. The failure path deliberately clears the partial, so this asserts the two do
    not share it.
  */
  it("keeps what it already fetched, which is what makes starting again a resume", async () => {
    stalling(700);
    const controller = new AbortController();
    await downloadFile(`${base}/f`, destination(), {
      policy: QUICK,
      signal: controller.signal,
      // After bytes have actually landed: the first report fires at zero, before the body is read at all.
      onProgress: ({ received }) => void (received > 0 && controller.abort()),
    }).catch(() => undefined);

    expect(await exists(partial()), "the partial survives a cancel").toBe(true);
    expect(await exists(partialIdentity()), "its source identity survives with it").toBe(true);
    expect((await stat(partial())).size).toBeGreaterThan(0);
    expect(await exists(destination()), "and nothing is passed off as a finished download").toBe(false);
  });

  it("resumes those bytes when a later invocation asks for the same URL", async () => {
    let first = true;
    let resumedRange: string | undefined;
    handler = (response, range) => {
      if (first) {
        response.writeHead(200, { "content-length": String(BODY.length) });
        response.write(BODY.subarray(0, 700));
        return;
      }
      resumedRange = range;
      const from = Number(/bytes=(\d+)-/.exec(range ?? "")?.[1] ?? 0);
      response.writeHead(206, {
        "content-length": String(BODY.length - from),
        "content-range": `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
      });
      response.end(BODY.subarray(from));
    };
    const controller = new AbortController();
    await downloadFile(`${base}/f`, destination(), {
      policy: QUICK,
      signal: controller.signal,
      onProgress: ({ received }) => void (received > 0 && controller.abort()),
    }).catch(() => undefined);

    first = false;
    await downloadFile(`${base}/f`, destination(), { policy: QUICK });

    expect(resumedRange).toBe("bytes=700-");
    expect(await readFile(destination())).toEqual(BODY);
    expect(await exists(partialIdentity()), "the identity is gone once the download is complete").toBe(false);
  });

  it("does not append a partial fetched from a different URL", async () => {
    let first = true;
    let laterRange: string | undefined;
    const replacement = Buffer.from(BODY).reverse();
    handler = (response, range) => {
      if (first) {
        response.writeHead(200, { "content-length": String(BODY.length) });
        response.write(BODY.subarray(0, 700));
        return;
      }
      laterRange = range;
      response.writeHead(200, { "content-length": String(replacement.length) });
      response.end(replacement);
    };
    const controller = new AbortController();
    await downloadFile(`${base}/old`, destination(), {
      policy: QUICK,
      signal: controller.signal,
      onProgress: ({ received }) => void (received > 0 && controller.abort()),
    }).catch(() => undefined);

    first = false;
    await downloadFile(`${base}/new`, destination(), { policy: QUICK });

    expect(laterRange).toBeUndefined();
    expect(await readFile(destination())).toEqual(replacement);
  });

  it("does not retry, where every network failure would", async () => {
    let calls = 0;
    handler = (response) => {
      calls += 1;
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.write(BODY.subarray(0, 700));
    };
    const controller = new AbortController();
    await downloadFile(`${base}/f`, destination(), {
      policy: QUICK,
      signal: controller.signal,
      // After bytes have actually landed: the first report fires at zero, before the body is read at all.
      onProgress: ({ received }) => void (received > 0 && controller.abort()),
    }).catch(() => undefined);

    expect(calls, "one request, where a dropped connection would have made three").toBe(1);
  });

  it("logs the attempt as cancelled rather than as an error of unknown kind", async () => {
    stalling(700);
    const controller = new AbortController();
    const notes: string[] = [];
    await downloadFile(`${base}/f`, destination(), {
      policy: QUICK,
      signal: controller.signal,
      note: (n) => notes.push(n.outcome),
      // After bytes have actually landed: the first report fires at zero, before the body is read at all.
      onProgress: ({ received }) => void (received > 0 && controller.abort()),
    }).catch(() => undefined);

    expect(notes).toEqual(["cancelled"]);
  });

  it("refuses before it asks for anything when the signal is already spent", async () => {
    let calls = 0;
    handler = (response) => {
      calls += 1;
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.end(BODY);
    };
    const failure = await downloadFile(`${base}/f`, destination(), {
      policy: QUICK,
      signal: AbortSignal.abort(),
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(OperationCancelled);
    expect(calls, "nothing was fetched").toBe(0);
  });
});
