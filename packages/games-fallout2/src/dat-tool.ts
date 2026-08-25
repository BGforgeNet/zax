/**
 * Unpacking a Fallout archive the user owns, which is the one step of a created install that ZAX cannot do
 * with what it already has: Fallout 1's `master.dat` is a DAT1 archive, and nothing in the payload reads one
 * without Wine - upstream's own script runs `dat2.exe` under it.
 *
 * The tool is `dat3`, pinned here by version and digest. It is ZAX's rather than the mod's on purpose: a
 * manifest that named the program to run would be a manifest handing ZAX an executable, which is not a grant
 * this format gives. The pin is data in a ZAX release for the same reason the feed list is - reviewable, and
 * changed only by a release.
 */

import type { Architecture, OperatingSystem, Platform, RunOutcome } from "@zax/platform";
import type { ReleaseAsset } from "./mod-feed.js";
import { fetchAsset, type ModProgress } from "./mod-asset.js";

/** The pinned release. Raising it is a ZAX change: new digests, and the invocation re-checked against them. */
export const DAT_TOOL_VERSION = "0.10.1";

const RELEASE = `https://github.com/BGforgeNet/dat3/releases/download/v${DAT_TOOL_VERSION}`;

/**
 * The tool as this machine will run it: a native build where upstream publishes one for this exact pair, and
 * the WebAssembly module everywhere else.
 */
export interface DatTool {
  asset: ReleaseAsset;
  kind: "native" | "wasm";
}

/**
 * What upstream publishes, keyed by system and processor. Digests are the release's own, recorded here rather
 * than read from it: a digest fetched beside the file it describes attests nothing, and this one is reviewed
 * with the ZAX commit that raises the pin.
 *
 * macOS has no build of any kind upstream, so it takes the module below - which is also why every pair that
 * reaches the module is a POSIX one, WASI resolving the absolute paths ZAX passes against a `/` preopen.
 *
 * Windows on ARM takes the x64 build, through the emulation Windows itself provides: upstream publishes no
 * ARM build for Windows, and this is what that host already ran before there was a module to fall back to.
 *
 * `dat3-win32.exe`, upstream's 32-bit Windows build, is deliberately not pinned: ZAX itself ships no 32-bit
 * Windows copy, so no host that could ask for it can be running this code.
 */
const BUILDS: Readonly<Partial<Record<`${OperatingSystem}-${Architecture}`, ReleaseAsset>>> = {
  "linux-x64": {
    name: "dat3",
    url: `${RELEASE}/dat3`,
    digest: "sha256:1d4654d8f4ebf4dd2baa14a1d17a13c055ba7c2999395209f62ad6d507ac890f",
  },
  "linux-arm64": {
    name: "dat3-arm64",
    url: `${RELEASE}/dat3-arm64`,
    digest: "sha256:51df57b672e58393908a22020f3fb25e042178359eedfd31d6ef1f2e51e40fba",
  },
  "windows-x64": {
    name: "dat3.exe",
    url: `${RELEASE}/dat3.exe`,
    digest: "sha256:0bbcfbb5e2b99ff24822b138e71e6af683bb4d11862a2e2feed0b084c3d1444c",
  },
  "windows-arm64": {
    name: "dat3.exe",
    url: `${RELEASE}/dat3.exe`,
    digest: "sha256:0bbcfbb5e2b99ff24822b138e71e6af683bb4d11862a2e2feed0b084c3d1444c",
  },
};

/**
 * The same tool built for WASI, which runs wherever ZAX does. Slower than a native build - `wasm32-wasip1` has
 * no threads, so upstream's parallel extraction walks the archive serially - so it is the fallback rather than
 * the rule, and it is what makes every host able to install a mod that unpacks a DAT.
 */
const PORTABLE_BUILD: ReleaseAsset = {
  name: "dat3.wasm",
  url: `${RELEASE}/dat3.wasm`,
  digest: "sha256:9d618a402c5150ff31644c9cd608fc4f2bdcd6d552d3bcbb54eda3a143aedd0e",
};

/** How this machine runs the tool. Always an answer: the module covers every pair with no native build. */
export function datToolFor(os: OperatingSystem, arch: Architecture): DatTool {
  const native = BUILDS[`${os}-${arch}`];
  return native ? { asset: native, kind: "native" } : { asset: PORTABLE_BUILD, kind: "wasm" };
}

/** Where the tool sits and how to run it, once it is in the cache. */
export interface ReadyDatTool {
  path: string;
  kind: DatTool["kind"];
}

/**
 * The tool in ZAX's cache, verified and runnable. Fetched exactly as a release asset is - one digest check,
 * one place - and a copy already there at the pinned digest is kept rather than downloaded again.
 */
export async function ensureDatTool(platform: Platform, build: DatTool, options?: ModProgress): Promise<ReadyDatTool> {
  const at = platform.paths.join(platform.paths.cache, "tools", `dat3-${DAT_TOOL_VERSION}`);
  const path = await fetchAsset(platform, at, build.asset, { mod: "ZAX", label: `dat3 ${DAT_TOOL_VERSION}` }, options);
  // What arrives over the network arrives without a mode, and a tool that cannot be executed is an extraction
  // that cannot happen. A module is not executed by the operating system, so the bit would mean nothing on it.
  if (build.kind === "native") await platform.fs.makeExecutable(path);
  return { path, kind: build.kind };
}

/** One invocation, by whichever route this copy of the tool takes. */
const runTool = async (platform: Platform, tool: ReadyDatTool, args: readonly string[]): Promise<RunOutcome> =>
  tool.kind === "wasm" ? platform.process.runWasm(tool.path, args) : platform.process.run(tool.path, args);

/** The tail of what the tool wrote, which is where anything it failed over is. */
const said = (output: string): string => output.trim().split("\n").slice(-3).join(" ");

/**
 * Whether the tool can read the archive at all, or what it said when it could not. The check upstream's own
 * script makes before extracting, and the one that answers before a large download rather than after it.
 */
export async function datReadError(platform: Platform, tool: ReadyDatTool, dat: string): Promise<string | null> {
  const outcome = await runTool(platform, tool, ["l", dat]);
  return outcome.code === 0 ? null : said(outcome.output);
}

/**
 * How many of the list's paths an archive may be missing and still be the archive the mod asked for. The two
 * cases are orders of magnitude apart, so the line between them is wide rather than tuned: Fallout et tu
 * v1.16.3771 names two files whose 8.3 collision suffix differs between Fallout 1 editions - upstream deleted
 * both a fortnight later - while a user who points at Fallout 2's `master.dat` misses nearly all 8,602.
 */
const EDITION_DRIFT = 100;

/** The paths the list named that the archive does not hold. Extraction skips these. */
const notFound = (output: string): readonly string[] => {
  const lines = output.split("\n");
  const head = lines.findIndex((line) => line.trim() === "Files not found:");
  if (head === -1) return [];
  const missing: string[] = [];
  for (const line of lines.slice(head + 1)) {
    // The tool indents each name and closes the block with an unindented `Error:` line.
    if (!/^\s+\S/.test(line)) break;
    missing.push(line.trim());
  }
  return missing;
};

/**
 * The paths the list names that this archive does not hold, refusing the archive that holds hardly any of them.
 *
 * Runs before the payload is downloaded, which is the whole point: extraction answers the same question, but
 * only once an 800 MB unpack has landed in the game folder. Nothing is written when this refuses.
 *
 * A few missing paths are not a wrong archive - upstream's own extractor skips a name it cannot find and
 * reports success - so they are returned for the caller to report rather than thrown over. An output with no
 * block to read is treated as everything missing: the tool is pinned, so a shape this cannot parse is a tool
 * ZAX no longer understands, and passing an unread archive is the failure worth avoiding.
 */
export async function missingFromDat(
  platform: Platform,
  tool: ReadyDatTool,
  dat: string,
  list: string,
): Promise<readonly string[]> {
  const outcome = await runTool(platform, tool, ["l", dat, `@${list}`]);
  if (outcome.code === 0) return [];
  const missing = notFound(outcome.output);
  if (missing.length === 0 || missing.length > EDITION_DRIFT)
    throw new Error(
      `${dat} is not the archive this mod needs - it holds hardly any of what the mod asked for. The tool said: ${said(outcome.output)}`,
    );
  return missing;
}

/**
 * Extracts the listed paths, structure preserved, into a directory.
 *
 * `--ignore-missing` because a list is written against one edition of the archive and run against another:
 * without it a name the user's copy spells differently fails the whole extraction, and nothing lands at all.
 * `missingFromDat` is what decides whether the misses amount to the wrong archive, before this runs.
 */
export async function extractFromDat(
  platform: Platform,
  tool: ReadyDatTool,
  dat: string,
  list: string,
  into: string,
): Promise<void> {
  const outcome = await runTool(platform, tool, ["x", dat, "--ignore-missing", "-o", into, `@${list}`]);
  if (outcome.code !== 0)
    throw new Error(`Unpacking ${dat} stopped with code ${outcome.code ?? "no exit code"}: ${said(outcome.output)}`);
}
