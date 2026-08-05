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
