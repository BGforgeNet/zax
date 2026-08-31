import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkError } from "@zax/platform";
import { nodePlatform } from "./index.js";

/**
 * The in-memory platform stands in for this one everywhere else, which makes any disagreement between the two
 * invisible until a real machine runs the code. These tests exercise the real implementation against a scratch
 * directory it creates itself, so nothing they delete belongs to anyone.
 */
const platform = nodePlatform();
const scratch = await mkdtemp(join(tmpdir(), "zax-platform-"));
afterAll(async () => rm(scratch, { recursive: true, force: true }));

const at = (...parts: string[]) => join(scratch, ...parts);
const utf8 = new TextDecoder();

describe("node filesystem", () => {
  it("creates parent directories on write, matching what the interface promises", async () => {
    await platform.fs.write(at("deep", "nested", "one.cfg"), new TextEncoder().encode("[sound]"));
    expect(utf8.decode(await platform.fs.read(at("deep", "nested", "one.cfg")))).toBe("[sound]");
  });

  it("returns null from stat for a path that is not there rather than rejecting", async () => {
    expect(await platform.fs.stat(at("absent"))).toBeNull();
  });

  it("classifies entries as files and directories", async () => {
    await platform.fs.write(at("game", "fallout2.exe"), new Uint8Array([0x4d, 0x5a]));
    await platform.fs.mkdir(at("game", "mods"));
    expect(await platform.fs.list(at("game"))).toEqual(
      expect.arrayContaining([
        { name: "fallout2.exe", kind: "file" },
        { name: "mods", kind: "dir" },
      ]),
    );
  });

  it("is silent about removing a path that is already gone", async () => {
    await expect(platform.fs.remove(at("never-existed"))).resolves.toBeUndefined();
  });

  it("copies a file, creating the destination's parent", async () => {
    await platform.fs.copy(at("game", "fallout2.exe"), at("backup", "2020", "fallout2.exe"));
    expect((await platform.fs.stat(at("backup", "2020", "fallout2.exe")))?.size).toBe(2);
  });

  it("preserves bytes above the ASCII range, which config files in legacy codepages carry", async () => {
    const high = new Uint8Array([0xff, 0x00, 0x80, 0xfe]);
    await platform.fs.write(at("high.cfg"), high);
    expect([...(await platform.fs.read(at("high.cfg")))]).toEqual([...high]);
  });
});

describe("node archives", () => {
  it("writes a zip that 7-Zip reads back, which is the pair the debug package and sfall update depend on", async () => {
    await platform.fs.write(at("src", "ddraw.ini"), new TextEncoder().encode("[Main]\r\nX=1\r\n"));
    await platform.fs.write(at("src", "debug.log"), new TextEncoder().encode("started"));

    await platform.archive.createZip(at("out.zip"), [
      { source: at("src", "ddraw.ini"), name: "ddraw.ini" },
      { source: at("src", "debug.log"), name: "logs/debug.log" },
    ]);
    await platform.archive.extract(at("out.zip"), at("unpacked"));

    expect(utf8.decode(await platform.fs.read(at("unpacked", "ddraw.ini")))).toBe("[Main]\r\nX=1\r\n");
    expect(utf8.decode(await platform.fs.read(at("unpacked", "logs", "debug.log")))).toBe("started");
  }, 30_000);

  it("reports a failed extraction rather than leaving an empty directory behind", async () => {
    await platform.fs.write(at("not-an-archive.7z"), new TextEncoder().encode("this is not an archive"));
    await expect(platform.archive.extract(at("not-an-archive.7z"), at("nope"))).rejects.toThrow(/Could not extract/);
  }, 30_000);

  // A game folder reached through a symbolic link is an ordinary thing for someone to have, and 7-Zip runs
  // against a filesystem that cannot follow one: it mounts a host directory by what `lstat` says the path is,
  // so a link is mounted as a link and the first lookup through it fails.
  it("extracts into a directory reached through a symbolic link", async () => {
    await platform.fs.write(at("linked", "src", "ddraw.ini"), new TextEncoder().encode("[Main]\r\n"));
    await platform.archive.createZip(at("linked", "one.zip"), [
      { source: at("linked", "src", "ddraw.ini"), name: "ddraw.ini" },
    ]);
    await platform.fs.mkdir(at("linked", "real-game"));
    await symlink(at("linked", "real-game"), at("linked", "game"));

    await platform.archive.extract(at("linked", "one.zip"), at("linked", "game"));
    expect(utf8.decode(await platform.fs.read(at("linked", "real-game", "ddraw.ini")))).toBe("[Main]\r\n");
  }, 30_000);

  it("reads an archive that sits behind a symbolic link", async () => {
    await platform.fs.write(at("held", "src", "ddraw.ini"), new TextEncoder().encode("[Main]\r\n"));
    await platform.archive.createZip(at("held", "real", "two.zip"), [
      { source: at("held", "src", "ddraw.ini"), name: "ddraw.ini" },
    ]);
    await symlink(at("held", "real"), at("held", "shelf"));

    expect((await platform.archive.list(at("held", "shelf", "two.zip"))).map((entry) => entry.name)).toEqual([
      "ddraw.ini",
    ]);
  }, 30_000);

  it("says what a failure inside the worker was, where 7-Zip never got to run", async () => {
    // The worker resolves the archive's own folder before it opens anything, so a folder that is not there
    // fails before 7-Zip runs at all - the path whose failures used to reach the caller as a placeholder.
    await expect(platform.archive.extract(at("absent-folder", "mod.zip"), at("into"))).rejects.toThrow(
      `lstat '${at("absent-folder")}'`,
    );
  }, 30_000);

  it("lists an archive's entries with sizes, and flags a symlink entry", async () => {
    // Built with fflate rather than shipped as a fixture: no ordinary tool writes a symlink into a zip, and
    // the attack this listing exists to refuse arrives exactly as these Unix-mode bits.
    const { zipSync } = await import("fflate");
    const encode = (s: string) => new TextEncoder().encode(s);
    const zipped = zipSync({
      "mods/fo2tweaks.dat": [encode("payload"), {}],
      "mods/escape": [encode("../../outside"), { os: 3, attrs: 0o120777 << 16 }],
    });
    await platform.fs.write(at("mod.zip"), zipped);

    const entries = await platform.archive.list(at("mod.zip"));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("mods/fo2tweaks.dat")).toEqual({ name: "mods/fo2tweaks.dat", kind: "file", size: 7 });
    expect(byName.get("mods/escape")?.kind).toBe("link");
  }, 30_000);

  it("reports an unreadable archive from list the way extraction does", async () => {
    await platform.fs.write(at("junk.zip"), new TextEncoder().encode("junk"));
    await expect(platform.archive.list(at("junk.zip"))).rejects.toThrow(/Could not read/);
  }, 30_000);
});

describe("node hashing", () => {
  it("hashes a file to the published SHA-256 test vector", async () => {
    await platform.fs.write(at("digest.bin"), new TextEncoder().encode("abc"));
    // FIPS 180-2's own example for "abc", so a wrong algorithm or encoding cannot agree by accident.
    expect(await platform.hash.sha256(at("digest.bin"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects hashing a path that is not there", async () => {
    await expect(platform.hash.sha256(at("absent.bin"))).rejects.toThrow();
  });

  it("hashes a file to the published MD5 test vector", async () => {
    await platform.fs.write(at("digest.bin"), new TextEncoder().encode("abc"));
    // RFC 1321's own example for "abc", so a wrong algorithm or encoding cannot agree by accident.
    expect(await platform.hash.md5(at("digest.bin"))).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
});

describe("node processes", () => {
  it("launches a program with the environment it was given", async () => {
    const marker = at("launched.txt");
    await platform.process.launch("sh", ["-c", 'printf "%s" "$ZAX_TEST" > "$ZAX_OUT"'], {
      env: { ZAX_TEST: "wine-prefix", ZAX_OUT: marker },
    });
    // The launch is detached, so the file appears shortly after the call resolves rather than during it.
    for (let attempt = 0; attempt < 50 && !(await platform.fs.stat(marker)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(utf8.decode(await platform.fs.read(marker))).toBe("wine-prefix");
  });

  it("sends both streams to the log it was given, replacing what was there", async () => {
    const log = at("wine.log");
    await platform.fs.write(log, new TextEncoder().encode("from an older run"));
    await platform.process.launch("sh", ["-c", 'printf "out"; printf "err" >&2'], { log });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (utf8.decode(await platform.fs.read(log)) === "outerr") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(utf8.decode(await platform.fs.read(log))).toBe("outerr");
  });

  it("starts the program anyway when its log cannot be opened", async () => {
    // A game folder ZAX cannot write to is still a game the user asked to start.
    const marker = at("ran-without-a-log.txt");
    await platform.process.launch("sh", ["-c", 'printf "ran" > "$ZAX_OUT"'], {
      env: { ZAX_OUT: marker },
      log: at("no/such/directory/wine.log"),
    });
    for (let attempt = 0; attempt < 50 && !(await platform.fs.stat(marker)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(utf8.decode(await platform.fs.read(marker))).toBe("ran");
  });

  it("reports a program that could not be started", async () => {
    await expect(platform.process.launch("zax-no-such-program", [])).rejects.toThrow();
  });
});

describe("running a program to completion", () => {
  it("waits for the exit and answers with the code and what it wrote", async () => {
    // `launch` resolves at spawn, which is right for the game and useless for an installer: everything ZAX
    // does after an install - merging state files, re-identifying the directory - reads what it wrote.
    const done = await platform.process.run(process.execPath, ["-e", "console.log('installed'); process.exit(0)"]);
    expect(done.code).toBe(0);
    expect(done.output).toContain("installed");
  });

  it("reports a non-zero exit rather than rejecting - a failed installer is an answer, not an error", async () => {
    const failed = await platform.process.run(process.execPath, ["-e", "console.error('no room'); process.exit(4)"]);
    expect(failed.code).toBe(4);
    // Both streams, because an installer's complaint is as likely to be on one as the other.
    expect(failed.output).toContain("no room");
  });

  it("runs in the directory it is given, which is how an installer finds the game around it", async () => {
    await platform.fs.write(at("run-here", "marker.txt"), new TextEncoder().encode("x"));
    const done = await platform.process.run(process.execPath, ["-e", "console.log(process.cwd())"], {
      cwd: at("run-here"),
    });
    expect(done.output.trim()).toContain("run-here");
  });

  it("rejects when the program is not there at all, which is not an exit code", async () => {
    await expect(platform.process.run(at("no-such-program"), [])).rejects.toThrow();
  });
});

/**
 * The archive tool ships a WebAssembly build for the systems it has no native one for, and this is the route
 * that runs it. The module below is the smallest program that exercises the whole route: it writes a line and
 * exits with a code, which is exactly what the callers of this read.
 *
 * Hand-assembled rather than compiled, so the test carries no toolchain. In WebAssembly's text format:
 *
 *   (module
 *     (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
 *     (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
 *     (memory (export "memory") 1)
 *     (data (i32.const 100) "hello from wasi\n")
 *     (func (export "_start")
 *       (i32.store (i32.const 0) (i32.const 100))   ;; iovec: where the text is
 *       (i32.store (i32.const 4) (i32.const 16))    ;; iovec: how much of it
 *       (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
 *       (call $exit (i32.const 3))))
 */
const TINY_WASI =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3" +
  "RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKIgEgAEEAQeQANgIAQQRBEDYCAEEBQQBB" +
  "AUEIEAAaQQMQAQsLFwEAQeQACxBoZWxsbyBmcm9tIHdhc2kK";

describe("running a WebAssembly module", () => {
  it("hosts it, answers with its exit code, and keeps what it wrote", async () => {
    const module = at("tiny.wasm");
    await platform.fs.write(module, Uint8Array.from(Buffer.from(TINY_WASI, "base64")));
    const done = await platform.process.runWasm(module, []);
    // A module that exits non-zero is an answer, as a program that does is: the archive tool says a DAT is
    // the wrong one by exiting, and what it printed is the whole account of why.
    expect(done.code).toBe(3);
    expect(done.output).toContain("hello from wasi");
  });

  it("rejects when the module is not there, rather than answering as though it ran", async () => {
    await expect(platform.process.runWasm(at("no-such.wasm"), [])).rejects.toThrow(/no-such\.wasm/);
  });

  it("rejects what is not a module at all", async () => {
    const junk = at("junk.wasm");
    await platform.fs.write(junk, new TextEncoder().encode("this is not WebAssembly"));
    await expect(platform.process.runWasm(junk, [])).rejects.toThrow();
  });

  it("has already tidied up by the time it answers, either way out", async () => {
    // What the module wrote is captured through a file, and the caller stops the worker the moment it
    // answers - so the removal has to happen before the answer or it is a race the file loses. Counted the
    // instant each call resolves rather than at the end of the test, which is the difference between
    // asserting the order and hoping the loser's thread was slow.
    const strays = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("zax-wasi-")).length;
    const before = await strays();

    const module = at("tidy.wasm");
    await platform.fs.write(module, Uint8Array.from(Buffer.from(TINY_WASI, "base64")));
    for (let round = 0; round < 5; round++) {
      await platform.process.runWasm(module, []);
      expect(await strays()).toBe(before);
      await expect(platform.process.runWasm(at("no-such.wasm"), [])).rejects.toThrow();
      expect(await strays()).toBe(before);
    }
  });
});

describe("renaming and free space", () => {
  it("renames a file and a directory in place", async () => {
    await platform.fs.write(at("rename", "one.dat"), new TextEncoder().encode("DAT"));
    await platform.fs.rename(at("rename", "one.dat"), at("rename", "two.dat"));
    expect(await platform.fs.stat(at("rename", "one.dat"))).toBeNull();
    expect(utf8.decode(await platform.fs.read(at("rename", "two.dat")))).toBe("DAT");

    await platform.fs.mkdir(at("rename", "Folder"));
    await platform.fs.rename(at("rename", "Folder"), at("rename", "folder"));
    expect((await platform.fs.stat(at("rename", "folder")))?.kind).toBe("dir");
  });

  it("answers free space as a positive number, and null for a path that is not there", async () => {
    const free = await platform.fs.freeSpace(scratch);
    expect(free).not.toBeNull();
    expect(free ?? 0).toBeGreaterThan(0);
    // Null rather than a rejection: a check that cannot run is not a check that failed.
    expect(await platform.fs.freeSpace(at("no-such-directory"))).toBeNull();
  });
});

// Split by host rather than branched inside one test: the seam promises a runnable file where there is an
// execute bit and a no-op where there is none, and those are two different claims to check.
describe("making a file runnable", () => {
  const shellScript = async () => {
    const script = at("exec", "install.sh");
    await platform.fs.write(script, new TextEncoder().encode("#!/bin/sh\nexit 0\n"));
    return script;
  };

  it.runIf(process.platform !== "win32")(
    "adds the owner's execute bit, which a script out of an archive may arrive without",
    async () => {
      const script = await shellScript();
      await platform.fs.makeExecutable(script);
      // Run it, which is the only thing the bit is for - and the check that does not depend on a mode constant.
      const done = await platform.process.run(script, []);
      expect(done.code).toBe(0);
    },
  );

  it.runIf(process.platform === "win32")("does nothing on a host with no execute bit", async () => {
    // Windows cannot run a .sh at all, so there is no bit to observe; what the caller relies on is that an
    // installer that needs no marking still resolves rather than failing the install.
    await expect(platform.fs.makeExecutable(await shellScript())).resolves.toBeUndefined();
  });
});

/**
 * Against a real server on the loopback, because what is being checked is how a failure is classified and that
 * classification comes from `fetch` itself: a stub would be asserting the shape this file already assumed.
 */
describe("reading a feed", () => {
  const server = createServer((request, response) => {
    if (request.url === "/feed") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("sfall 4.5");
    } else {
      response.writeHead(404, "Not Found");
      response.end();
    }
  });

  let origin = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the test server did not take a port");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(
    async () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );

  it("returns the body a feed answers with", async () => {
    expect(await platform.net.fetchText(`${origin}/feed`)).toBe("sfall 4.5");
  });

  it("reports a refused answer as a status failure, naming the code the server gave", async () => {
    const failed = await platform.net.fetchText(`${origin}/absent`).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NetworkError);
    const error = failed as NetworkError;
    expect(error.kind).toBe("status");
    expect(error.status).toBe(404);
    // The message is what the interface shows, so the host and the code both have to be in it.
    expect(error.message).toBe(`127.0.0.1:${new URL(origin).port} answered with 404 Not Found.`);
  });

  it("reports a host that will not answer as offline rather than as a status", async () => {
    // A port nothing is listening on: the one refusal that needs no waiting.
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = address !== null && typeof address !== "string" ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
    const failed = await platform.net.fetchText(`http://127.0.0.1:${closed}/feed`).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NetworkError);
    expect((failed as NetworkError).kind).toBe("offline");
    expect((failed as NetworkError).status).toBeUndefined();
  });

  it("falls back to the whole string when what it was given is not a URL to take a host from", async () => {
    const failed = await platform.net.fetchText("not-a-url").catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NetworkError);
    expect((failed as NetworkError).message).toBe("not-a-url could not be reached - check the network connection.");
  });
});

describe("the Windows registry", () => {
  it("answers null off Windows, which is an answer rather than a failure to get one", async () => {
    // What the install discovery relies on: it asks unconditionally and treats null as "not registered here".
    expect(await platform.registry.read("HKLM\\Software\\Interplay\\Fallout2", "Path")).toBeNull();
  });
});
