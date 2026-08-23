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
export const DAT_TOOL_VERSION = "0.9.1";

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
    digest: "sha256:808527196fedd111fdc1f685ee80aa39419b2083b50a762c05efc547263ecec5",
  },
  "linux-arm64": {
    name: "dat3-arm64",
    url: `${RELEASE}/dat3-arm64`,
    digest: "sha256:7a65ee101f0c7906447c880e90c770d909475fd7371742e8c81b2bc66082610f",
  },
  "windows-x64": {
    name: "dat3.exe",
    url: `${RELEASE}/dat3.exe`,
    digest: "sha256:c9070e59a78cf2c0e32563b0ff9c0582bfa26062d4bf2cbe90d87875511e4ea9",
  },
  "windows-arm64": {
    name: "dat3.exe",
    url: `${RELEASE}/dat3.exe`,
    digest: "sha256:c9070e59a78cf2c0e32563b0ff9c0582bfa26062d4bf2cbe90d87875511e4ea9",
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
  digest: "sha256:acf013e39ea9efa4a72004ad9c214fe460c14aa10fb04c6476b1a8ed55af18f7",
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
 * That the archive holds every path the list names, which is what decides whether it is the archive the mod
 * asked for.
 *
 * Extraction answers the same question from v0.9.0 on, but it answers it too late: it runs after the payload
 * has been unpacked into the game folder and the record written, where this runs before either. A user who
 * pointed at the wrong `master.dat` is told so with nothing yet touched.
 */
export async function assertDatHolds(platform: Platform, tool: ReadyDatTool, dat: string, list: string): Promise<void> {
  const outcome = await runTool(platform, tool, ["l", dat, `@${list}`]);
  if (outcome.code !== 0)
    throw new Error(
      `${dat} is not the archive this mod needs - it does not hold everything the mod asked for. The tool said: ${said(outcome.output)}`,
    );
}

/** Extracts the listed paths, structure preserved, into a directory. */
export async function extractFromDat(
  platform: Platform,
  tool: ReadyDatTool,
  dat: string,
  list: string,
  into: string,
): Promise<void> {
  const outcome = await runTool(platform, tool, ["x", dat, "-o", into, `@${list}`]);
  if (outcome.code !== 0)
    throw new Error(`Unpacking ${dat} stopped with code ${outcome.code ?? "no exit code"}: ${said(outcome.output)}`);
}
