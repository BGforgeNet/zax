/**
 * Loads the preview's WebAssembly before any test imports the interface.
 *
 * The preview's own loader fetches the module from beside its script, which a browser can do and Node cannot
 * with a file address. Initialising it here from the bytes on disk is what the loader then finds already done.
 * Build it first with `scripts/build-preview.sh`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initSync } from "./src/lib/preview-wasm/zax_preview.js";

// By directory rather than by `import.meta.url`, which the test runner hands a setup file as something other
// than a file address.
initSync({ module: readFileSync(join(import.meta.dirname, "src/lib/preview-wasm/zax_preview_bg.wasm")) });
