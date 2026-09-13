/**
 * `pnpm mod-ini`: checks a mod's ini files against the settings its f2mod.yml describes, or writes them from it.
 * For mod authors before a release; `actions/mod-ini` runs the same thing in their CI. Under jiti because the
 * parser lives in TypeScript source.
 */

import { parseArgs } from "node:util";
import { runModIni } from "./run.mjs";

const USAGE = `usage: pnpm mod-ini check [--match soft|hard] [--directory <dir>] [<f2mod.yml>]
       pnpm mod-ini generate [--directory <dir>] [<f2mod.yml>]

  soft    the ini may carry entries the manifest does not describe (the default)
  hard    the ini carries exactly what the manifest describes
  <dir>   what the settings' mods/ paths are relative to; the manifest's folder by default`;

/** @returns {number} the exit code: 0 on a match or a write, 1 on a mismatch or refusal, 2 on a bad invocation. */
function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { match: { type: "string", default: "soft" }, directory: { type: "string" } },
    });
  } catch (error) {
    // Node's argument errors are Errors carrying a sentence; anything else is not an invocation problem.
    if (!(error instanceof Error)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  const [command, manifest = "f2mod.yml", ...rest] = parsed.positionals;
  const { match, directory } = parsed.values;
  if ((command !== "check" && command !== "generate") || rest.length > 0 || (match !== "soft" && match !== "hard")) {
    console.error(USAGE);
    return 2;
  }

  // Passed inline: bound to a variable first, the narrowed `command` and `match` widen back to string.
  return runModIni(
    { command, match, manifest, ...(directory === undefined ? {} : { directory }) },
    console.log,
    console.error,
  ).ok
    ? 0
    : 1;
}

// Set rather than exited with, so what was written to stderr is flushed before Node stops.
process.exitCode = main();
