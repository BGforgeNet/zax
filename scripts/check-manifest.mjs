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
  const payload = tagged
    ? "(payload from the release)"
    : (manifest.archive ?? 'no "archive" named - valid, but a release without one cannot offer a download');
  console.log(
    `OK: ${manifest.id} ${version} (${manifest.type}); payload: ${payload}; ` +
      `${manifest.settings.length} setting(s), ${manifest.refuse.length} refusal rule(s)`,
  );
  // Not a refusal: the mod installs and these controls do not appear. Reported because an author writing to a
  // later spec than the checkout has would otherwise see a clean OK and no sign the schema was trimmed.
  for (const entry of manifest.dropped) console.log(`  dropped "${entry.address}": ${entry.why}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
