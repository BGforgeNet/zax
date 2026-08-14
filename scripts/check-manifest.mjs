/**
 * Validates a zax-mod.yml the way ZAX will: the application's own parser, the same refusals, word for word.
 * For mod authors and their release CI - a manifest that passes here is one every ZAX reading spec 1 accepts.
 * Runs under jiti (`pnpm check-manifest <file>`) because the parser lives in TypeScript source.
 */

import { readFileSync } from "node:fs";
import { parseManifest } from "../packages/games-fallout2/src/manifest.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: pnpm check-manifest <path-to-zax-mod.yml>");
  process.exit(2);
}

try {
  const manifest = parseManifest(new Uint8Array(readFileSync(path)));
  const payload = manifest.archive
    ? `payload: ${manifest.archive}`
    : 'no "archive" named - valid, but a release without one cannot offer a download';
  console.log(
    `OK: ${manifest.id} ${manifest.version} (${manifest.type}); ${payload}; ` +
      `${manifest.settings.length} setting(s), ${manifest.refuse.length} refusal rule(s)`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
