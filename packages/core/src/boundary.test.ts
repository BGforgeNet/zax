import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The inward-only rule: core runs against the platform interface alone. A stray import of a Node built-in or an
 * outer package would compile fine - the root tsconfig makes their types visible everywhere - so only a scan
 * like this fails when the boundary is crossed. Tests are exempt; they run on Node by definition.
 */
describe("core stays inside the platform seam", () => {
  it("imports nothing beyond its own files, @zax/platform and yaml", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(join(here, file), "utf8");
      for (const match of text.matchAll(/from "([^"]+)"/g)) {
        const spec = match[1]!;
        const allowed = spec.startsWith("./") || spec === "@zax/platform" || spec === "yaml";
        expect(allowed, `${file} imports ${spec}`).toBe(true);
      }
    }
  });
});
