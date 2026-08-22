/**
 * Validates a f2mod.yml the way ZAX will: the application's own parser, the same refusals, word for word.
 * For mod authors and their release CI - a manifest that passes here is one every ZAX reading spec 1 accepts.
 * Runs under jiti (`pnpm check-manifest <file>`) because the parser lives in TypeScript source.
 */

import { readFileSync } from "node:fs";
import { parseManifest } from "../packages/games-fallout2/src/manifest.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: pnpm check-manifest <path-to-f2mod.yml>");
  process.exit(2);
}

// A committed manifest states no version - its tag will - so it is read a second time as a release would
// read it, and the report says which fields came from the stand-in rather than from the file.
const SUPPLIED = { version: "0", archive: "payload.zip" };

try {
  const bytes = new Uint8Array(readFileSync(path));
  let manifest;
  let tagged = false;
  try {
    manifest = parseManifest(bytes);
  } catch (error) {
    if (!/states no "version"/.test(error instanceof Error ? error.message : "")) throw error;
    manifest = parseManifest(bytes, SUPPLIED);
    tagged = true;
  }
  const version = tagged ? "(version from the tag)" : manifest.version;
  const payload = manifest.installer
    ? Object.entries(manifest.installer)
        .map(([platform, route]) => `${platform}: ${route.asset}`)
        .join(", ")
    : manifest.parts
      ? `${manifest.parts.flatMap((group) => group.options).length} part(s), each naming its own asset`
      : tagged
        ? "(payload from the release)"
        : (manifest.archive ?? 'no "archive" named - valid, but a release without one cannot offer a download');
  console.log(
    `OK: ${manifest.id} ${version} (${manifest.type}); payload: ${payload}; ` +
      `${manifest.settings.length} setting(s), ${manifest.refuse.length} refusal rule(s)`,
  );
  // The components, spelled the way the installer's command line will carry them: an author checking a base
  // manifest is checking exactly this list, and a name that is wrong here installs the wrong thing silently.
  for (const group of manifest.installer?.windows?.components ?? [])
    console.log(
      `  ${group.label} (pick ${group.pick}): ` +
        group.options.map((one) => `${one.id}${one.required ? " [always]" : ""}`).join(", "),
    );
  // Spelled out because a part id is permanent and an author's first sight of one is here: what this prints
  // is what every future release has to keep naming, and what an install records.
  for (const group of manifest.parts ?? [])
    console.log(
      `  ${group.label} (pick ${group.pick}): ` +
        group.options.map((part) => `${part.id} -> ${part.archive}`).join(", "),
    );
  // What a creating mod makes and asks for, since neither is visible in the payload it names: the directory
  // is the bound every write passes, and each input is a question the user will be put in front of.
  if (manifest.creates) {
    console.log(`  creates ${manifest.creates.directory}/ beside the install, reporting as ${manifest.becomes}`);
    for (const input of manifest.inputs ?? []) console.log(`  asks for ${input.id}: ${input.label} (${input.holds})`);
    if (manifest.extractDat)
      console.log(
        `  unpacks ${manifest.extractDat.from}'s archive into ${manifest.creates.directory}/${manifest.extractDat.into}, ` +
          `as ${manifest.extractDat.list} names`,
      );
  }
  // Not a refusal: the mod installs and these controls do not appear. Reported because an author writing to a
  // later spec than the checkout has would otherwise see a clean OK and no sign the schema was trimmed.
  for (const entry of manifest.dropped) console.log(`  dropped "${entry.address}": ${entry.why}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
