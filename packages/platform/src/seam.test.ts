import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The inward-only rule, for every package that sits inside the seam.
 *
 * The root tsconfig makes every type visible everywhere, so a stray import of a Node built-in or of a package
 * further out compiles fine and the boundary is crossed silently. Only a scan like this fails. It lives with
 * the seam rather than with any one package because the rule is about all of them at once, and a second copy
 * would be a second thing to keep in step.
 *
 * `platform-node` implements the seam and is the one place Node's built-ins belong; `app` is the Electron
 * shell that hosts the whole thing. Both are outside by definition, so neither is scanned. Tests are exempt
 * too - they run on Node.
 */
const INSIDE_THE_SEAM: Readonly<Record<string, readonly string[]>> = {
  platform: ["spark-md5"],
  core: ["@zax/platform", "yaml"],
  "games-fallout2": ["@zax/core", "@zax/platform", "pe-library", "resedit", "yaml"],
  ui: ["@zax/core", "@zax/fallout2", "@zax/platform", "@zax/platform/memory", "svelte"],
};

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Asked of the runtime rather than written out, so the set cannot fall behind the Node the project runs on. */
const BUILTINS = new Set(builtinModules);
const isBuiltin = (spec: string) => spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]!);

/**
 * What a file imports, from the compiler's own pre-processor rather than a scan of the text: it catches every
 * form - bare `import "x"`, dynamic `import()`, `export ... from` - and ignores comments, where a rationale
 * ending in the phrase `from "pluggable"` otherwise reads as an import. Svelte files pass through as they are.
 */
const importsOf = (source: string): readonly string[] =>
  ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);

function* sourcesOf(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourcesOf(at);
    else if (/\.(ts|svelte)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) yield at;
  }
}

describe.each(Object.entries(INSIDE_THE_SEAM))("%s stays inside the platform seam", (pkg, allowed) => {
  const files = [...sourcesOf(join(PACKAGES, pkg, "src"))];

  it("has sources for the scan to read", () => {
    // Without this the scan below passes on an empty list, which is what a moved or renamed source tree
    // looks like from here.
    expect(files.length).toBeGreaterThan(0);
  });

  it(`imports nothing beyond its own files${allowed.length ? ` and ${allowed.join(", ")}` : ""}`, () => {
    for (const file of files) {
      const where = relative(PACKAGES, file);
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".") || allowed.includes(spec)) continue;
        const why = isBuiltin(spec) ? "reaches around the platform seam for" : "imports";
        expect.fail(`${where} ${why} ${spec}`);
      }
    }
  });

  it("reaches the network through the seam rather than through the global", () => {
    // The one route out that no import scan sees. Matched off a word boundary that excludes a leading dot, so
    // a method of the seam's own network object is not mistaken for the global.
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(/(?<![.\w])fetch\s*\(/.test(text), `${relative(PACKAGES, file)} calls fetch`).toBe(false);
    }
  });
});
