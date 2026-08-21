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
    await appendLog(platform, "sfall 4.5: attempt 2 resumed from 400000", AT);
    expect(written(platform)).toBe("2026-08-05T18:30:00.000Z sfall 4.5: attempt 2 resumed from 400000\n");
  });

  it("adds to the file rather than replacing it", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await appendLog(platform, "first", AT);
    await appendLog(platform, "second", AT);
    expect(written(platform).split("\n").filter(Boolean)).toHaveLength(2);
  });

  /*
    The log is ZAX's own file, and what goes into it is game paths and whatever the operating system called a
    failure - neither of which is Latin-1 anywhere but in English. A byte-per-code-point encoding writes this
    line as mojibake in the one file a person opens to find out what happened.
  */
  it("keeps a path that is not Latin-1 readable, rather than folding it to single bytes", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await appendLog(platform, "scan: found D:\\Игры\\Fallout2 (Кириллица)", AT);
    expect(written(platform)).toContain("D:\\Игры\\Fallout2 (Кириллица)");
  });

  it("keeps text outside the basic plane, which an OS error message can carry", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await appendLog(platform, "opened 日本語のフォルダ", AT);
    expect(written(platform)).toContain("日本語のフォルダ");
  });

  it("never throws, because it is what would report the failure", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    // A file where the directory has to be, so creating the parent - and the append - cannot succeed.
    await platform.fs.write(logFile(platform).replace(/\/[^/]*$/, ""), new Uint8Array([1]));
    await expect(appendLog(platform, "nowhere to go", AT)).resolves.toBeUndefined();
  });
});
