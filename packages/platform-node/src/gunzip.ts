/**
 * The gzip layer, taken off before 7-Zip is pointed at a file. 7-Zip reads a `.tar.gz` as one entry holding a
 * `.tar`, so every caller would have to know it had been handed a two-stage archive; the seam's contract says
 * the format is this layer's business, and Node decompresses gzip with no help.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const GZIP_MAGIC = [0x1f, 0x8b];
/** Room for an allowed 8 GiB payload, its tar headers, and padding, while still stopping an unbounded stream. */
const MAX_EXPANDED_BYTES = 9 * 1024 ** 3;

/** Read from the file rather than inferred from its name: `.dmg`, `.zip` and `.tar.gz` all arrive here. */
async function isGzip(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(GZIP_MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, GZIP_MAGIC.length, 0);
    return bytesRead === GZIP_MAGIC.length && GZIP_MAGIC.every((byte, at) => head[at] === byte);
  } finally {
    await handle.close();
  }
}

/**
 * Runs `work` against the decompressed copy of a gzipped file, and against the file itself otherwise. The copy
 * and the directory holding it are removed however `work` ends.
 */
export async function throughGzip<T>(
  archive: string,
  work: (path: string) => Promise<T>,
  byteLimit?: number,
): Promise<T> {
  if (!(await isGzip(archive))) return work(archive);
  const directory = await mkdtemp(join(tmpdir(), "zax-gz-"));
  try {
    // The name only has to carry the inner extension for 7-Zip; the directory is what makes it unique.
    const inner = join(directory, basename(archive).replace(/\.gz$/i, ""));
    const space = await statfs(directory);
    // Leave a tenth of the temporary filesystem free. The fixed cap applies where the host reports implausibly
    // large space, while the proportional one keeps inspection from consuming a smaller filesystem outright.
    const limit = byteLimit ?? Math.min(MAX_EXPANDED_BYTES, Math.floor(space.bavail * space.bsize * 0.9));
    let expanded = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        expanded += chunk.length;
        if (expanded > limit) callback(new Error(`Gzip archive expands past ${limit} bytes.`));
        else callback(null, chunk);
      },
    });
    await pipeline(createReadStream(archive), createGunzip(), bounded, createWriteStream(inner));
    return await work(inner);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
