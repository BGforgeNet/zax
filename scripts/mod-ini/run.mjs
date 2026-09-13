/**
 * The file half of `pnpm mod-ini` and `actions/mod-ini`: reads the manifest and the ini files it names, and either
 * reports how they disagree or writes the files over. The judgement itself is `mod-ini.ts`'s, shared with nothing
 * else so that the command and the action cannot come to different answers.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseManifest } from "../../packages/games-fallout2/src/manifest.js";
import { checkModIni, generateModIni } from "../../packages/games-fallout2/src/mod-ini.js";

/** @param {string} path */
const readIfFile = (path) =>
  statSync(path, { throwIfNoEntry: false })?.isFile() ? new Uint8Array(readFileSync(path)) : undefined;

/**
 * @param {{ command: "check" | "generate", match: "soft" | "hard", manifest: string, directory?: string }} options
 *   `directory` is what the settings' `mods/...` paths are relative to, the manifest's own folder by default.
 * @param {(line: string) => void} say
 * @param {(line: string) => void} complain
 * @returns {{ ok: boolean, written: string[] }} `written` names each file generate wrote, as joined to `directory`.
 */
export function runModIni(options, say, complain) {
  const root = options.directory ?? dirname(options.manifest);
  const at = (/** @type {string} */ file) => join(root, file);
  try {
    // A committed manifest states no version, since its tag does - and nothing here depends on which.
    const manifest = parseManifest(new Uint8Array(readFileSync(options.manifest)), { version: "0" });

    if (options.command === "generate") {
      const written = [];
      for (const [file, bytes] of generateModIni(manifest, (name) => readIfFile(at(name)))) {
        mkdirSync(dirname(at(file)), { recursive: true });
        writeFileSync(at(file), bytes);
        written.push(at(file));
      }
      say(`Wrote ${written.join(", ")} from ${manifest.settings.length} setting(s).`);
      return { ok: true, written };
    }

    const report = checkModIni(manifest, (name) => readIfFile(at(name)), options.match);
    for (const mismatch of report.mismatches) complain(mismatch);
    if (report.mismatches.length > 0) {
      complain(`${report.mismatches.length} mismatch(es) between ${options.manifest} and its ini (${options.match}).`);
      return { ok: false, written: [] };
    }
    // Said on success too, because a soft pass over a file the schema barely covers looks the same as a full one.
    const left =
      options.match === "soft" && report.undescribed > 0 ? `; ${report.undescribed} entry(ies) not described` : "";
    say(`OK: ${manifest.settings.length} setting(s) match ${report.files.join(", ")} (${options.match}${left}).`);
    return { ok: true, written: [] };
  } catch (error) {
    // Every refusal above - the manifest's, the generator's, a file that cannot be read - is an Error whose
    // message already names its cause; anything else is a defect here, and its stack is the useful part.
    if (!(error instanceof Error)) throw error;
    complain(error.message);
    return { ok: false, written: [] };
  }
}
