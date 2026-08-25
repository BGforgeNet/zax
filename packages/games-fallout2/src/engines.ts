/**
 * The alternative engines ZAX can install, as data. Hardcoded rather than fetched: a new engine is a code
 * change and a review, which is the point - this deploys a third-party binary into a user's game folder.
 *
 * Beside `sfall.ts` for the same reason it is: acquiring a third-party payload for this one game is this
 * package's business, not `core`'s.
 */

import type { Architecture, OperatingSystem } from "@zax/platform";

/**
 * How a project publishes. `rolling` republishes one release in place and carries no version number, so its
 * publication time is its version; `tagged` names versions that can be compared.
 */
export type ReleaseModel = "rolling" | "tagged";

/** One thing taken out of a release archive: where it lives inside, and what it becomes in the install. */
export interface EngineMember {
  /** Path inside the archive, `/`-separated, wrapper directory included. */
  from: string;
  /** Path relative to the install directory. */
  to: string;
}

export interface EngineBuild {
  os: OperatingSystem;
  /** Null where the project publishes one build for every processor - the macOS disk image is universal. */
  arch: Architecture | null;
  /** The release asset's name, exactly as published. */
  asset: string;
  members: readonly EngineMember[];
  /** What is run, relative to the install. */
  program: string;
}

export interface EngineDefinition {
  id: string;
  name: string;
  /** What the second Run button says after "Run in". */
  short: string;
  repo: string;
  page: string;
  releases: ReleaseModel;
  builds: readonly EngineBuild[];
  /**
   * What proves this engine has written its own settings, which it does the first time it runs. An engine
   * with a config file of its own is answered by the file; fallout2-ce writes into the game's own config
   * file, which every install already has, so its mark is a section vanilla does not carry.
   */
  settingsMark: { file: string; section?: string };
}

export const ENGINES: readonly EngineDefinition[] = [
  {
    // `EXAMPLE_fallout2.cfg` ships in this project's archives and appears in no member list: deploying it
    // would replace the user's settings with an example, which an engine install must not produce.
    id: "fallout2-ce",
    name: "Fallout II Community Edition",
    short: "CE",
    repo: "fallout2-ce/fallout2-ce",
    page: "https://github.com/fallout2-ce/fallout2-ce",
    releases: "rolling",
    // It writes all of [ui], [qol], [gameplay] and [screen] on its first run, where vanilla carries only
    // [debug], [preferences], [sound] and [system]; any one of them answers, and [ui] is the largest.
    settingsMark: { file: "fallout2.cfg", section: "ui" },
    builds: [
      {
        os: "windows",
        arch: "x64",
        asset: "fallout2-ce-windows-x64.zip",
        members: [
          { from: "fallout2-ce-windows-x64/fallout2-ce.exe", to: "fallout2-ce.exe" },
          { from: "fallout2-ce-windows-x64/ce.dat", to: "ce.dat" },
        ],
        program: "fallout2-ce.exe",
      },
      {
        os: "linux",
        arch: "x64",
        asset: "fallout2-ce-linux-x64.tar.gz",
        members: [
          { from: "fallout2-ce-linux-x64/fallout2-ce", to: "fallout2-ce" },
          { from: "fallout2-ce-linux-x64/ce.dat", to: "ce.dat" },
        ],
        program: "fallout2-ce",
      },
      {
        os: "linux",
        arch: "arm64",
        asset: "fallout2-ce-linux-arm64.tar.gz",
        members: [
          { from: "fallout2-ce-linux-arm64/fallout2-ce", to: "fallout2-ce" },
          { from: "fallout2-ce-linux-arm64/ce.dat", to: "ce.dat" },
        ],
        program: "fallout2-ce",
      },
      {
        // The disk image carries an application bundle, which goes into the game folder whole - the project's
        // own macOS instructions put it there, beside the data it reads.
        os: "macos",
        arch: null,
        asset: "Fallout.II.Community.Edition.dmg",
        members: [
          {
            from: "Fallout II Community Edition/Fallout II Community Edition.app",
            to: "Fallout II Community Edition.app",
          },
        ],
        program: "Fallout II Community Edition.app/Contents/MacOS/fallout2-ce",
      },
    ],
  },
  {
    /*
      No macOS build, though the project publishes one: its disk image carries the `/Applications` alias every
      drag-to-install image has, and `preflightArchive` refuses an archive holding a symbolic link before it is
      opened. Widening that guard for one engine changes what every downloaded archive is allowed to do.
    */
    id: "fission",
    name: "Fallout Fission",
    short: "Fission",
    repo: "cambragol/fission-ce",
    page: "https://github.com/cambragol/fission-ce",
    // Named versions, unlike CE's one republished tag, so what is installed is compared by tag rather than date.
    releases: "tagged",
    // Its own file, which nothing else in an install creates.
    settingsMark: { file: "fission.cfg" },
    // The 32-bit and armhf builds this project also publishes have no `Architecture` to match, and the shell
    // ZAX itself ships in has no build for such a host either. Every archive here is flat, with no wrapper
    // directory to name in a member.
    builds: [
      {
        os: "windows",
        arch: "x64",
        asset: "fallout-fission-windows-x64.zip",
        members: [
          { from: "fallout-fission-x64.exe", to: "fallout-fission-x64.exe" },
          { from: "fission.dat", to: "fission.dat" },
        ],
        program: "fallout-fission-x64.exe",
      },
      {
        os: "linux",
        arch: "x64",
        asset: "fallout-fission-linux-x64.zip",
        members: [
          { from: "fallout-fission-linux-x64", to: "fallout-fission-linux-x64" },
          { from: "fission.dat", to: "fission.dat" },
        ],
        program: "fallout-fission-linux-x64",
      },
      {
        os: "linux",
        arch: "arm64",
        asset: "fallout-fission-linux-arm64.zip",
        members: [
          { from: "fallout-fission-linux-arm64", to: "fallout-fission-linux-arm64" },
          { from: "fission.dat", to: "fission.dat" },
        ],
        program: "fallout-fission-linux-arm64",
      },
    ],
  },
];

export function engineById(id: string): EngineDefinition {
  const found = ENGINES.find((engine) => engine.id === id);
  if (!found) throw new Error(`No engine called "${id}".`);
  return found;
}

/**
 * The build for a machine, or null when the project publishes none it can run. A null `arch` matches every
 * processor; anything else must match exactly, because handing a host a binary it cannot execute is worse
 * than telling it there is nothing to install.
 */
export function buildFor(engine: EngineDefinition, os: OperatingSystem, arch: Architecture): EngineBuild | null {
  return engine.builds.find((build) => build.os === os && (build.arch === null || build.arch === arch)) ?? null;
}
