/**
 * The entry point `actions/mod-ini` runs, bundled into `actions/mod-ini/dist/action.mjs` by `build.mjs` - the
 * action's caller has no ZAX checkout and no install, so it gets the parser and its dependencies in one file.
 * Inputs arrive as `INPUT_*` variables, the runner's own convention, which `pack-mod` reuses to run a check.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { runModIni } from "./run.mjs";

/** A refusal whose message is the whole report. Thrown rather than exiting, so stderr is flushed before Node stops. */
class Refusal extends Error {}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Refusal(message);
}

/** @param {string} name @param {string} fallback */
const input = (name, fallback) => process.env[`INPUT_${name.toUpperCase()}`]?.trim() || fallback;

/** @param {string[]} args @returns {number} */
function git(...args) {
  const run = spawnSync("git", args, { stdio: "inherit" });
  if (run.error) fail(`git could not be run: ${run.error.message}`);
  return run.status ?? 1;
}

/** @returns {boolean} whether the run succeeded; every failure has been reported by the time it returns false. */
function main() {
  const mode = input("mode", "check");
  const match = input("match", "soft");
  const directory = input("directory", ".");
  if (mode !== "check" && mode !== "generate") fail(`"mode" is "${mode}"; it takes check or generate.`);
  if (match !== "soft" && match !== "hard") fail(`"match" is "${match}"; it takes soft or hard.`);

  if (mode === "generate") {
    // Pushing needs a branch to push to. A pull request's checkout is a merge commit nobody's branch holds, and a
    // tag's is detached - either would commit somewhere the push cannot land, after the files were already written.
    const event = process.env["GITHUB_EVENT_NAME"] || "unknown";
    const ref = process.env["GITHUB_REF_TYPE"] || "unknown";
    if (ref !== "branch" || event.startsWith("pull_request"))
      fail(
        `generate commits and pushes, so it needs a push to a branch; this run's event is ${event} and its ref a ${ref}.`,
      );
  }

  const { ok, written } = runModIni(
    { command: mode, match, manifest: "f2mod.yml", directory },
    console.log,
    console.error,
  );
  if (!ok) return false;

  let changed = false;
  if (mode === "generate") {
    if (git("add", "--", ...written) !== 0) fail("git add refused the generated files.");
    // Exit 1 is the answer "there are differences"; anything past that is git failing to say.
    const diff = git("diff", "--cached", "--quiet", "--", ...written);
    if (diff > 1) fail("git diff could not compare the generated files.");
    changed = diff === 1;
    if (changed) {
      const identity = [
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      ];
      const message = `Regenerate ${written.join(", ")} from f2mod.yml`;
      // `--` limits the commit to these paths, so anything else the caller's job staged stays out of it.
      if (git(...identity, "commit", "--quiet", "-m", message, "--", ...written) !== 0) fail("git commit failed.");
      if (git("push", "origin", `HEAD:refs/heads/${process.env["GITHUB_REF_NAME"] ?? ""}`) !== 0)
        fail("git push failed - the job needs `contents: write`, and a checkout that kept its credentials.");
    } else console.log("The generated files match what is committed; nothing to push.");
  }

  if (process.env["GITHUB_OUTPUT"]) appendFileSync(process.env["GITHUB_OUTPUT"], `changed=${changed}\n`);
  return true;
}

try {
  if (!main()) process.exitCode = 1;
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
