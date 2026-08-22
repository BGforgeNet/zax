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

import type { OperatingSystem, Platform } from "@zax/platform";
import type { ReleaseAsset } from "./mod-feed.js";
import { fetchAsset, type ModProgress } from "./mod-asset.js";

/** The pinned release. Raising it is a ZAX change: new digests, and the invocation re-checked against them. */
export const DAT_TOOL_VERSION = "0.8.0";

const RELEASE = `https://github.com/BGforgeNet/dat3/releases/download/v${DAT_TOOL_VERSION}`;

/**
 * What upstream publishes, by system. Digests are the release's own, recorded here rather than read from it:
 * a digest fetched beside the file it describes attests nothing, and this one is reviewed with the ZAX commit
 * that raises the pin. There is no macOS build and no ARM build, which is why this answers per system.
 */
const BUILDS: Readonly<Partial<Record<OperatingSystem, ReleaseAsset>>> = {
  linux: {
    name: "dat3",
    url: `${RELEASE}/dat3`,
    digest: "sha256:74eb7443e87a0a73112a6a4d4ec4ddcb45f62785751a3fcaef7bd1dc4875cd84",
  },
  windows: {
    name: "dat3.exe",
    url: `${RELEASE}/dat3.exe`,
    digest: "sha256:04df97f6d1340846450ebcc3c70530ec619516988c040e173dcb9a888ced1ae7",
  },
};

/** The build for this system, or nothing where none is published. */
export const datToolFor = (os: OperatingSystem): ReleaseAsset | undefined => BUILDS[os];

/**
 * Said once, because eligibility and the install both reach it: the shape a base mod's missing installer
 * already takes, since it is the same situation - the mod is real and this machine cannot carry out a step.
 */
export const noDatTool = (mod: string): string =>
  `${mod} unpacks Fallout 1's own files, and the tool ZAX does that with has no build for this system.`;

/**
 * The tool in ZAX's cache, verified and runnable. Fetched exactly as a release asset is - one digest check,
 * one place - and a copy already there at the pinned digest is kept rather than downloaded again.
 */
export async function ensureDatTool(platform: Platform, build: ReleaseAsset, options?: ModProgress): Promise<string> {
  const at = platform.paths.join(platform.paths.cache, "tools", `dat3-${DAT_TOOL_VERSION}`);
  const tool = await fetchAsset(platform, at, build, { mod: "ZAX", label: `dat3 ${DAT_TOOL_VERSION}` }, options);
  // What arrives over the network arrives without a mode, and a tool that cannot be executed is an
  // extraction that cannot happen.
  await platform.fs.makeExecutable(tool);
  return tool;
}

/** The tail of what the tool wrote, which is where anything it failed over is. */
const said = (output: string): string => output.trim().split("\n").slice(-3).join(" ");

/**
 * Whether the tool can read the archive at all, or what it said when it could not. The check upstream's own
 * script makes before extracting, and the one that answers before a large download rather than after it.
 */
export async function datReadError(platform: Platform, tool: string, dat: string): Promise<string | null> {
  const outcome = await platform.process.run(tool, ["l", dat]);
  return outcome.code === 0 ? null : said(outcome.output);
}

/**
 * That the archive holds every path the list names, which is what decides whether it is the archive the mod
 * asked for.
 *
 * This exists because extraction does not answer it: asked for a path the archive does not carry, `dat3 x`
 * extracts what it found and exits 0, while `dat3 l` exits non-zero and names what was missing. Without this
 * gate a user who pointed at the wrong `master.dat` would get a successful install missing thousands of files.
 */
export async function assertDatHolds(platform: Platform, tool: string, dat: string, list: string): Promise<void> {
  const outcome = await platform.process.run(tool, ["l", dat, `@${list}`]);
  if (outcome.code !== 0)
    throw new Error(
      `${dat} is not the archive this mod needs - it does not hold everything the mod asked for. The tool said: ${said(outcome.output)}`,
    );
}

/** Extracts the listed paths, structure preserved, into a directory. */
export async function extractFromDat(
  platform: Platform,
  tool: string,
  dat: string,
  list: string,
  into: string,
): Promise<void> {
  const outcome = await platform.process.run(tool, ["x", dat, "-o", into, `@${list}`]);
  if (outcome.code !== 0)
    throw new Error(`Unpacking ${dat} stopped with code ${outcome.code ?? "no exit code"}: ${said(outcome.output)}`);
}
