/**
 * The file half of `pnpm mod-ini` and the action: reads the manifest and the ini files it names, and either
 * reports how they disagree or writes the files over. The judgement and its wording are `tools.mjs`'s.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkModIni, generateModIni } from "./tools.mjs";

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
    const manifest = new Uint8Array(readFileSync(options.manifest));

    if (options.command === "generate") {
      const { files, settings } = generateModIni(manifest, (/** @type {string} */ name) => readIfFile(at(name)));
      const written = [];
      for (const [file, bytes] of files) {
        mkdirSync(dirname(at(file)), { recursive: true });
        writeFileSync(at(file), bytes);
        written.push(at(file));
      }
      say(`Wrote ${written.join(", ")} from ${settings} setting(s).`);
      return { ok: true, written };
    }

    const checked = checkModIni(manifest, options.manifest, options.match, (/** @type {string} */ name) =>
      readIfFile(at(name)),
    );
    for (const line of checked.said) say(line);
    for (const line of checked.complaints) complain(line);
    return { ok: checked.ok, written: [] };
  } catch (error) {
    // Every refusal - the manifest's, the generator's, a file that cannot be read - is an Error whose message
    // already names its cause; anything else is a defect here, and its stack is the useful part.
    if (!(error instanceof Error)) throw error;
    complain(error.message);
    return { ok: false, written: [] };
  }
}
