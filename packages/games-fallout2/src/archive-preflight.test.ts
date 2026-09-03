import { MemoryPlatform } from "@zax/platform/memory";
import type { ArchiveEntryInfo } from "@zax/platform";
import { describe, expect, it } from "vitest";
import { isArchivingClutter, preflightArchive } from "./archive-preflight.js";

const listing = (entries: readonly ArchiveEntryInfo[]) =>
  new MemoryPlatform({ os: "linux", arch: "x64", config: "cfg", cache: "cache", listings: { payload: entries } });

const file = (name: string, size = 1): ArchiveEntryInfo => ({ name, size, kind: "file" });

/** Takes the list rather than spreading it: the ceiling cases run to tens of thousands, past the call stack. */
const judgeAll = async (entries: readonly ArchiveEntryInfo[]) =>
  preflightArchive(listing(entries), "payload", "a mod release");

const judge = async (...entries: readonly ArchiveEntryInfo[]) => judgeAll(entries);

describe("preflightArchive", () => {
  it("returns the directory it read, so the caller plans from the same listing", async () => {
    const entries = [file("mods/one.dat", 40), file("readme.txt", 3)];
    await expect(judge(...entries)).resolves.toEqual(entries);
  });

  it("refuses an entry that climbs out of the folder it unpacks into", async () => {
    await expect(judge(file("../fallout2.cfg"))).rejects.toThrow(
      "a mod release names a path outside the folder it unpacks into (../fallout2.cfg) - refused.",
    );
  });

  it("refuses a climb that starts partway along the path", async () => {
    await expect(judge(file("mods/../../fallout2.cfg"))).rejects.toThrow("names a path outside");
  });

  it("refuses a climb written with the separator a Windows archive uses", async () => {
    await expect(judge(file("mods\\..\\..\\fallout2.cfg"))).rejects.toThrow("names a path outside");
  });

  it("refuses an absolute path, on either separator", async () => {
    await expect(judge(file("/etc/passwd"))).rejects.toThrow("names a path outside");
    await expect(judge(file("\\Windows\\System32\\drivers\\etc\\hosts"))).rejects.toThrow("names a path outside");
  });

  it("refuses a path rooted at a drive", async () => {
    await expect(judge(file("C:\\Windows\\System32\\kernel32.dll"))).rejects.toThrow("names a path outside");
  });

  it("allows a name that merely contains two dots", async () => {
    // ".." is refused as a whole segment, not as a substring: "..sfall" and "one..two.dat" are ordinary names,
    // and a mod that ships one would otherwise be unusable.
    const entries = [file("..sfall/one.dat"), file("mods/one..two.dat")];
    await expect(judge(...entries)).resolves.toEqual(entries);
  });

  it("refuses a link, naming which entry it was", async () => {
    await expect(judge({ name: "mods/link", size: 0, kind: "link" })).rejects.toThrow(
      "a mod release contains a symbolic link or hard link (mods/link) - refused, nothing was extracted.",
    );
  });

  it("refuses a path nested deeper than any release goes, on either separator", async () => {
    const deep = Array.from({ length: 17 }, (_, i) => `d${i}`);
    await expect(judge(file(deep.join("/")))).rejects.toThrow("nests paths deeper");
    await expect(judge(file(deep.join("\\")))).rejects.toThrow("nests paths deeper");
  });

  it("allows a path at the depth ceiling", async () => {
    const entry = file(Array.from({ length: 16 }, (_, i) => `d${i}`).join("/"));
    await expect(judge(entry)).resolves.toEqual([entry]);
  });

  it("allows an archive the size of the largest release published", async () => {
    // Fallout et tu ships Fallout 1's asset tree unpacked: 10,985 entries at v1.16.3771, and it was refused
    // outright while the ceiling sat at 10,000 - which its v1.10 release had already passed.
    const entries = Array.from({ length: 10_985 }, (_, i) => file(`Fallout1in2/data/${i}.frm`));
    await expect(judgeAll(entries)).resolves.toHaveLength(10_985);
  });

  it("refuses more entries than any release declares", async () => {
    const entries = Array.from({ length: 65_537 }, (_, i) => file(`mods/${i}.dat`));
    await expect(judgeAll(entries)).rejects.toThrow("a mod release declares 65537 entries - refused.");
  });

  it("refuses a declaration that would fill the disk", async () => {
    await expect(judge(file("mods/bomb.dat", 8 * 1024 ** 3 + 1))).rejects.toThrow(
      `a mod release declares ${8 * 1024 ** 3 + 1} bytes unpacked, past what any release needs - refused.`,
    );
  });

  it("refuses a character Windows cannot put in a name, naming the segment", async () => {
    await expect(judge(file("mods/read:me.dat"))).rejects.toThrow(
      'a mod release names "read:me.dat" (in mods/read:me.dat), which Windows cannot create',
    );
    await expect(judge(file("mods/what?.dat"))).rejects.toThrow("which Windows cannot create");
  });

  it("refuses a control character in a name", async () => {
    // Written as a code unit: a literal one in the source would be invisible to whoever reads this next.
    await expect(judge(file(`mods/one${String.fromCharCode(1)}.dat`))).rejects.toThrow("which Windows cannot create");
  });

  it("refuses a device name Windows reserves, at any level and with any extension", async () => {
    await expect(judge(file("mods/aux.dat"))).rejects.toThrow("which Windows cannot create");
    await expect(judge(file("mods/nul/one.dat"))).rejects.toThrow("which Windows cannot create");
    await expect(judge(file("mods/com1"))).rejects.toThrow("which Windows cannot create");
  });

  it("refuses a segment ending in a dot or a space, which Windows silently drops", async () => {
    await expect(judge(file("mods/one.dat "))).rejects.toThrow("which Windows cannot create");
    await expect(judge(file("mods/patches./one.dat"))).rejects.toThrow("which Windows cannot create");
  });

  it("allows the names those rules are shaped to let through", async () => {
    // The false positives that would matter: a space inside a name is ordinary in this corpus, and a device
    // name is reserved as a whole segment rather than as a prefix.
    const entries = [file("mods/party orders.dat"), file("mods/console.dat"), file("mods/auxiliary/one.dat")];
    await expect(judge(...entries)).resolves.toEqual(entries);
  });
});

describe("isArchivingClutter", () => {
  it("names what the archiving machine wrote", () => {
    expect(isArchivingClutter("__MACOSX/mods/._one.dat")).toBe(true);
    expect(isArchivingClutter("mods/.DS_Store")).toBe(true);
    expect(isArchivingClutter("mods/patches/Thumbs.db")).toBe(true);
  });

  it("leaves everything an author could have written", () => {
    expect(isArchivingClutter("mods/one.dat")).toBe(false);
    expect(isArchivingClutter("mods/.keep")).toBe(false);
    expect(isArchivingClutter("mods/macosx.dat")).toBe(false);
  });
});
