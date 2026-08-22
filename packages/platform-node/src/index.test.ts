import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodePlatform } from "./index.js";

/**
 * The in-memory platform stands in for this one everywhere else, which makes any disagreement between the two
 * invisible until a real machine runs the code. These tests exercise the real implementation against a scratch
 * directory it creates itself, so nothing they delete belongs to anyone.
 */
const platform = nodePlatform();
const scratch = await mkdtemp(join(tmpdir(), "zax-platform-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

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

describe("making a file runnable", () => {
  it("adds the owner's execute bit, which a script out of an archive may arrive without", async () => {
    const script = at("exec", "install.sh");
    await platform.fs.write(script, new TextEncoder().encode("#!/bin/sh\nexit 0\n"));
    await platform.fs.makeExecutable(script);
    // Run it, which is the only thing the bit is for - and the check that does not depend on a mode constant.
    const done = await platform.process.run(script, []);
    expect(done.code).toBe(0);
  });
});
