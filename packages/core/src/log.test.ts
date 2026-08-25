import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { appendLog } from "./log.js";
import { logFile } from "./directories.js";

const AT = new Date(Date.UTC(2026, 7, 5, 18, 30, 0));

const written = (platform: MemoryPlatform) =>
  new TextDecoder().decode(platform.fileAt(logFile(platform)) ?? new Uint8Array());

describe("appending a line", () => {
  it("stamps the line with the time it was given", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await appendLog(platform, "info", "sfall 4.5: attempt 2 resumed from 400000", AT);
    expect(written(platform)).toBe("2026-08-05T18:30:00.000Z INFO sfall 4.5: attempt 2 resumed from 400000\n");
  });

  it("adds to the file rather than replacing it", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await appendLog(platform, "info", "first", AT);
    await appendLog(platform, "info", "second", AT);
    expect(written(platform).split("\n").filter(Boolean)).toHaveLength(2);
  });

  /*
    The log is ZAX's own file, and what goes into it is game paths and whatever the operating system called a
    failure - neither of which is Latin-1 anywhere but in English. A byte-per-code-point encoding writes this
    line as mojibake in the one file a person opens to find out what happened.
  */
  it("keeps a path that is not Latin-1 readable, rather than folding it to single bytes", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await appendLog(platform, "info", "scan: found D:\\Игры\\Fallout2 (Кириллица)", AT);
    expect(written(platform)).toContain("D:\\Игры\\Fallout2 (Кириллица)");
  });

  it("keeps text outside the basic plane, which an OS error message can carry", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await appendLog(platform, "info", "opened 日本語のフォルダ", AT);
    expect(written(platform)).toContain("日本語のフォルダ");
  });

  it("never throws, because it is what would report the failure", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    // A file where the directory has to be, so creating the parent - and the append - cannot succeed.
    await platform.fs.write(logFile(platform).replace(/\/[^/]*$/, ""), new Uint8Array([1]));
    await expect(appendLog(platform, "info", "nowhere to go", AT)).resolves.toBeUndefined();
  });

  it.each([
    ["info", "INFO"],
    ["warn", "WARN"],
    ["error", "ERROR"],
  ] as const)("writes %s as %s, between the time and the line", async (level, written_) => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await appendLog(platform, level, "something happened", AT);
    expect(written(platform)).toBe(`2026-08-05T18:30:00.000Z ${written_} something happened\n`);
  });
});

/*
  Nothing else prunes this file. The path that writes most of it is a download retrying on a connection that
  keeps dropping - the run whose log is worth having, and the one that would otherwise grow without limit.
*/
describe("the ceiling", () => {
  const MAX = 1024 * 1024;

  /** A file of `bytes` bytes made of whole lines, so a trim has boundaries to cut at. */
  const filled = async (platform: MemoryPlatform, bytes: number) => {
    const line = `${"x".repeat(99)}\n`;
    await platform.fs.write(logFile(platform), new TextEncoder().encode(line.repeat(Math.ceil(bytes / 100))));
  };

  it("leaves a file under the ceiling alone", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await filled(platform, MAX - 1000);
    await appendLog(platform, "info", "another", AT);
    expect(written(platform)).not.toContain("trimmed");
    expect(written(platform).length).toBeGreaterThan(MAX - 1000);
  });

  it("drops the oldest lines once the file is past it, and keeps writing", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await filled(platform, MAX + 5000);
    await appendLog(platform, "info", "the newest line", AT);
    const after = written(platform);
    expect(after.length).toBeLessThan(MAX);
    expect(after).toContain("the newest line");
  });

  it("says in the file that lines were dropped, rather than losing them silently", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await filled(platform, MAX + 5000);
    await appendLog(platform, "info", "after", AT);
    // First line, so a reader following a failure backwards meets it rather than reading the oldest
    // surviving line as the beginning of what happened.
    expect(written(platform).split("\n")[0]).toMatch(/^2026-08-05T18:30:00.000Z INFO log: trimmed, \d+ bytes/);
  });

  it("cuts at a line boundary, so nothing starts mid-line", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await filled(platform, MAX + 5000);
    await appendLog(platform, "info", "after", AT);
    const lines = written(platform).split("\n").filter(Boolean);
    // Every surviving filler line is whole; a byte cut would leave the first one short.
    expect(lines.slice(1, -1).every((one) => one.length === 99)).toBe(true);
  });

  it("drops a tail holding no newline whole, rather than leaving the file over the ceiling", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    // One line longer than the ceiling: there is no boundary to cut at inside what would be kept.
    await platform.fs.write(logFile(platform), new TextEncoder().encode("~".repeat(MAX + 5000)));
    await appendLog(platform, "info", "after", AT);
    const after = written(platform);
    expect(after).not.toContain("~");
    expect(after).toContain("after");
  });

  it("keeps text outside Latin-1 readable across a trim", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    // The cut is made in bytes; 0x0a cannot occur inside a UTF-8 sequence, so a boundary is always safe.
    const line = `${"日本語のフォルダ".repeat(11)}\n`;
    await platform.fs.write(logFile(platform), new TextEncoder().encode(line.repeat(40_000)));
    await appendLog(platform, "info", "after", AT);
    expect(written(platform)).toContain("日本語のフォルダ");
    expect(written(platform)).not.toContain("\ufffd");
  });
});
