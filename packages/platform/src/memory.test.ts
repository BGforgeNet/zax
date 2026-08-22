import { describe, expect, it } from "vitest";
import { MemoryPlatform, bytes, text } from "./memory.js";

/**
 * The in-memory platform is a test double, and a double with a bug produces green tests that prove nothing. It
 * carries real logic - path normalization, directory listing, recursive removal - so it gets its own tests.
 */
describe("memory platform", () => {
  it("reads back what it was seeded with", async () => {
    const platform = new MemoryPlatform({ files: { "/game/fallout2.cfg": "[sound]\nmusic=1\n" } });
    expect(text(await platform.fs.read("/game/fallout2.cfg"))).toBe("[sound]\nmusic=1\n");
  });

  it("rejects reading a path that does not exist, and reports absence from stat", async () => {
    const platform = new MemoryPlatform();
    await expect(platform.fs.read("/nowhere")).rejects.toThrow(/No such file/);
    expect(await platform.fs.stat("/nowhere")).toBeNull();
  });

  it("creates parent directories on write, so a caller never orders the two calls", async () => {
    const platform = new MemoryPlatform();
    await platform.fs.write("/a/b/c.txt", bytes("hi"));
    expect((await platform.fs.stat("/a/b"))?.kind).toBe("dir");
  });

  it("lists a directory's own children once, whether they are files or directories", async () => {
    const platform = new MemoryPlatform({
      files: { "/game/fallout2.exe": "", "/game/mods/rpu.dat": "", "/game/mods/upu.dat": "" },
    });
    expect(await platform.fs.list("/game")).toEqual([
      { name: "fallout2.exe", kind: "file" },
      { name: "mods", kind: "dir" },
    ]);
  });

  it("lists a directory that holds no files, which is how an empty mods folder reads", async () => {
    const platform = new MemoryPlatform({ dirs: ["/game/mods"], files: { "/game/fallout2.exe": "" } });
    expect(await platform.fs.list("/game/mods")).toEqual([]);
    expect(await platform.fs.list("/game")).toContainEqual({ name: "mods", kind: "dir" });
  });

  it("rejects listing something that is not a directory", async () => {
    const platform = new MemoryPlatform({ files: { "/game/fallout2.cfg": "" } });
    await expect(platform.fs.list("/game/fallout2.cfg")).rejects.toThrow(/Not a directory/);
  });

  it("removes a whole tree and is silent about one already gone", async () => {
    const platform = new MemoryPlatform({ files: { "/cache/backup/a/one.cfg": "", "/cache/keep.txt": "" } });
    await platform.fs.remove("/cache/backup");
    await platform.fs.remove("/cache/backup");
    expect(platform.allFiles()).toEqual(["/cache/keep.txt"]);
    expect(await platform.fs.stat("/cache/backup")).toBeNull();
  });

  it("treats two spellings of one path as one file", async () => {
    const platform = new MemoryPlatform({ files: { "/game//sub/../fallout2.cfg": "one" } });
    expect(platform.textAt("/game/fallout2.cfg")).toBe("one");
  });

  it("dates a rewritten file after the one it replaced, so a change is detectable without a clock", async () => {
    const platform = new MemoryPlatform({ files: { "/a.txt": "one" } });
    const before = await platform.fs.stat("/a.txt");
    await platform.fs.write("/a.txt", bytes("two"));
    const after = await platform.fs.stat("/a.txt");
    expect(after!.modified).toBeGreaterThan(before!.modified);
  });

  it("records what the outside world was asked to do", async () => {
    const platform = new MemoryPlatform({ responses: { "https://example/v": "4.5" } });
    await platform.process.launch("wine", ["fallout2.exe"], { cwd: "/game" });
    await platform.process.open("/cache/debug");
    expect(await platform.net.fetchText("https://example/v")).toBe("4.5");

    expect(platform.launched).toEqual([{ program: "wine", args: ["fallout2.exe"], options: { cwd: "/game" } }]);
    expect(platform.opened).toEqual(["/cache/debug"]);
    expect(platform.fetched).toEqual(["https://example/v"]);
  });

  it("rejects a URL it has no canned response for, the way an unreachable host would", async () => {
    await expect(new MemoryPlatform().net.fetchText("https://example/v")).rejects.toThrow(/No canned response/);
  });

  it("extracts an archive into real files", async () => {
    const platform = new MemoryPlatform({
      archives: { "/tmp/sfall.7z": { "ddraw.dll": "MZ", "ddraw.ini": "[Main]" } },
    });
    await platform.archive.extract("/tmp/sfall.7z", "/tmp/out");
    expect(platform.textAt("/tmp/out/ddraw.dll")).toBe("MZ");
    expect(platform.textAt("/tmp/out/ddraw.ini")).toBe("[Main]");
  });

  it("refuses to zip a file that is not there, which is the mistake worth catching", async () => {
    const platform = new MemoryPlatform({ files: { "/game/ddraw.ini": "" } });
    const entries = [
      { source: "/game/ddraw.ini", name: "ddraw.ini" },
      { source: "/game/debug.log", name: "debug.log" },
    ];
    await expect(platform.archive.createZip("/out.zip", entries)).rejects.toThrow(/No such file/);
  });

  it("joins and splits paths", () => {
    const { paths } = new MemoryPlatform({ home: "/home/tester" });
    expect(paths.join("/game", "mods", "rpu.dat")).toBe("/game/mods/rpu.dat");
    expect(paths.dirname("/game/mods/rpu.dat")).toBe("/game/mods");
    expect(paths.basename("/game/mods/rpu.dat")).toBe("rpu.dat");
    expect(paths.config).toBe("/home/tester/.config/zax");
  });

  it("lists a canned archive from its contents, every entry a file with its size", async () => {
    const platform = new MemoryPlatform({
      archives: { "/downloads/mod.zip": { "mods/fo2tweaks.dat": "payload", "mods/fo2tweaks.ini": "[main]" } },
    });
    expect(await platform.archive.list("/downloads/mod.zip")).toEqual([
      { name: "mods/fo2tweaks.dat", kind: "file", size: 7 },
      { name: "mods/fo2tweaks.ini", kind: "file", size: 6 },
    ]);
    expect(platform.listed).toEqual(["/downloads/mod.zip"]);
  });

  it("prefers a canned listing, which is how a hostile declaration differs from the contents", async () => {
    const platform = new MemoryPlatform({
      archives: { "/downloads/mod.zip": { "mods/a.dat": "x" } },
      listings: { "/downloads/mod.zip": [{ name: "mods/a.dat", kind: "link", size: 10_000_000_000 }] },
    });
    expect(await platform.archive.list("/downloads/mod.zip")).toEqual([
      { name: "mods/a.dat", kind: "link", size: 10_000_000_000 },
    ]);
  });

  it("rejects listing an archive nothing canned, as the real one rejects an unreadable file", async () => {
    const platform = new MemoryPlatform();
    await expect(platform.archive.list("/downloads/absent.zip")).rejects.toThrow(/No canned contents/);
  });

  it("hashes a file to the published SHA-256 test vector, agreeing with the Node platform", async () => {
    const platform = new MemoryPlatform({ files: { "/downloads/digest.bin": "abc" } });
    expect(await platform.hash.sha256("/downloads/digest.bin")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(platform.hash.sha256("/downloads/absent.bin")).rejects.toThrow(/No such file/);
  });
});

describe("the memory platform's new seam members", () => {
  it("renames a file, and a directory with everything under it", async () => {
    const platform = new MemoryPlatform({
      files: { "/game/Mods/RPU.dat": "DAT", "/game/Mods/deep/Inner.ini": "[main]" },
    });
    await platform.fs.rename("/game/Mods/RPU.dat", "/game/Mods/rpu.dat");
    expect(await platform.fs.stat("/game/Mods/RPU.dat")).toBeNull();
    expect(platform.textAt("/game/Mods/rpu.dat")).toBe("DAT");

    await platform.fs.rename("/game/Mods", "/game/mods");
    expect(await platform.fs.stat("/game/Mods")).toBeNull();
    expect(platform.textAt("/game/mods/rpu.dat")).toBe("DAT");
    // Everything below it moves with it, which is what makes this a rename rather than a copy of one entry.
    expect(platform.textAt("/game/mods/deep/Inner.ini")).toBe("[main]");
  });

  it("rejects renaming what is not there", async () => {
    const platform = new MemoryPlatform();
    await expect(platform.fs.rename("/game/absent.dat", "/game/other.dat")).rejects.toThrow(/No such/);
  });

  it("answers free space only where a test said what it should be", async () => {
    // Null is the honest default: this platform has no disk. A test that means to exercise the preflight's
    // refusal says so, and one that does not gets the arm where the check cannot run.
    expect(await new MemoryPlatform().fs.freeSpace("/game")).toBeNull();
    expect(await new MemoryPlatform({ freeSpace: 5_000 }).fs.freeSpace("/game")).toBe(5_000);
  });

  it("runs a program by recording it, and answers with whatever the test canned", async () => {
    const platform = new MemoryPlatform({ runs: { "/game/rpu-install.sh": { code: 0, output: "RPU installed." } } });
    const done = await platform.process.run("/game/rpu-install.sh", ["--quiet"], { cwd: "/game" });
    expect(done).toEqual({ code: 0, output: "RPU installed." });
    expect(platform.ran).toEqual([{ program: "/game/rpu-install.sh", args: ["--quiet"], options: { cwd: "/game" } }]);
  });

  it("answers a program nothing canned the way a host answers one that is not installed", async () => {
    const platform = new MemoryPlatform();
    await expect(platform.process.run("/game/absent.exe", [])).rejects.toThrow(/absent\.exe/);
  });
});
