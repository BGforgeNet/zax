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
});
