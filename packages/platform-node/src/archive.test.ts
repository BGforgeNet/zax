import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { throughGzip } from "./gunzip.js";
import { nodePlatform } from "./index.js";

const scratch = await mkdtemp(join(tmpdir(), "zax-archive-"));
const platform = nodePlatform();

afterAll(async () => rm(scratch, { recursive: true, force: true }));

/**
 * One ustar header block. Written by hand because nothing in the toolchain writes tar, and the alternative -
 * a committed binary fixture - would put a made-up file among the real ones.
 */
function header(name: string, size: number, type: "0" | "5" | "2" | "1", target = ""): Uint8Array {
  const block = new Uint8Array(512);
  const ascii = (text: string, at: number, width: number) => {
    for (let i = 0; i < Math.min(text.length, width); i += 1) block[at + i] = text.charCodeAt(i);
  };
  ascii(name, 0, 100);
  ascii("0000755", 100, 8);
  ascii("0001750", 108, 8);
  ascii("0001750", 116, 8);
  ascii(size.toString(8).padStart(11, "0"), 124, 12);
  ascii("00000000000", 136, 12);
  ascii(type, 156, 1);
  ascii(target, 157, 100);
  ascii("ustar", 257, 6);
  ascii("00", 263, 2);
  // The checksum is computed with its own field read as spaces, then written as octal, NUL, space.
  for (let i = 148; i < 156; i += 1) block[i] = 0x20;
  let sum = 0;
  for (const byte of block) sum += byte;
  ascii(sum.toString(8).padStart(6, "0"), 148, 6);
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

const BODY = "hello world";

/** A directory, a regular file, and a genuine symbolic link - one of each kind the listing tells apart. */
function tarball(): Uint8Array {
  const payload = new TextEncoder().encode(BODY);
  const padded = new Uint8Array(512);
  padded.set(payload);
  const blocks = [
    header("payload/", 0, "5"),
    header("payload/engine", payload.length, "0"),
    padded,
    header("payload/shortcut", 0, "2", "engine"),
    new Uint8Array(1024),
  ];
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

function hardlinkTarball(): Uint8Array {
  const payload = new TextEncoder().encode(BODY);
  const padded = new Uint8Array(512);
  padded.set(payload);
  const blocks = [
    header("payload/engine", payload.length, "0"),
    padded,
    header("payload/alias", 0, "1", "payload/engine"),
    new Uint8Array(1024),
  ];
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

async function gzippedTarball(name: string, contents = tarball()): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, gzipSync(contents));
  return path;
}

describe("reading a gzipped tarball", () => {
  it("lists what is inside it rather than the tar it wraps", async () => {
    const entries = await platform.archive.list(await gzippedTarball("one.tar.gz"));
    expect(entries.map((entry) => entry.name)).toEqual(["payload", "payload/engine", "payload/shortcut"]);
  });

  it("tells a directory, a file and a symbolic link apart", async () => {
    const entries = await platform.archive.list(await gzippedTarball("two.tar.gz"));
    expect(entries.map((entry) => entry.kind)).toEqual(["dir", "file", "link"]);
  });

  it("flags a hard link rather than presenting it as a file", async () => {
    const entries = await platform.archive.list(await gzippedTarball("hardlink.tar.gz", hardlinkTarball()));
    expect(entries.find((entry) => entry.name === "payload/alias")?.kind).toBe("link");
  });

  it("extracts the files themselves", async () => {
    const into = join(scratch, "unpacked");
    await platform.archive.extract(await gzippedTarball("three.tar.gz"), into);
    expect(await readFile(join(into, "payload", "engine"), "utf8")).toBe(BODY);
  });

  it("leaves no scratch directory of its own behind", async () => {
    await platform.archive.list(await gzippedTarball("four.tar.gz"));
    const strays = (await readdir(tmpdir())).filter((name) => name.startsWith("zax-gz-"));
    expect(strays).toEqual([]);
  });

  it("stops expanding when the gzip output passes its byte limit", async () => {
    const archive = join(scratch, "bomb.gz");
    await writeFile(archive, gzipSync(new Uint8Array(4096)));
    await expect(throughGzip(archive, async () => undefined, 1024)).rejects.toThrow(/expands past 1024 bytes/);
    const strays = (await readdir(tmpdir())).filter((name) => name.startsWith("zax-gz-"));
    expect(strays).toEqual([]);
  });
});
