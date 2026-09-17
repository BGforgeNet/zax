/**
 * Validates a f2mod.yml the way ZAX will: the application's own parser, the same refusals, word for word.
 * For mod authors and their release CI - a manifest that passes here is one every ZAX reading spec 1 accepts.
 */

import { readFileSync } from "node:fs";
import { describeManifest } from "../actions/mod-ini/tools.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: pnpm check-manifest <path-to-f2mod.yml>");
  process.exit(2);
}

try {
  for (const line of describeManifest(new Uint8Array(readFileSync(path)))) console.log(line);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
