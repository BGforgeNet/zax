/**
 * The mod tools' WebAssembly, loaded. The judgement is the application's own Rust (`crates/mod-tools`), so the
 * action, `pnpm mod-ini` and `pnpm check-manifest` cannot come to an answer ZAX would not; everything that
 * touches a file stays on this side.
 */

import { readFileSync } from "node:fs";
import { checkModIni, describeManifest, generateModIni, initSync } from "./wasm/zax_mod_tools.js";

// Read from beside the glue rather than fetched: Node's fetch does not read file URLs.
initSync({ module: readFileSync(new URL("wasm/zax_mod_tools_bg.wasm", import.meta.url)) });

export { checkModIni, describeManifest, generateModIni };
