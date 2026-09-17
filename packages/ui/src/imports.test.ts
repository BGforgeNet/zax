import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The interface reaches the machine through the shell's commands and nothing else.
 *
 * The root tsconfig makes every type visible everywhere, so a stray import of a Node built-in compiles fine and
 * the boundary is crossed silently; only a scan like this fails. What the interface may import is its own files,
 * Svelte, and the two parts of Tauri's API that carry a command and its progress. Tests are exempt - they run on
 * Node - and so is what a build writes into the tree, the preview's WebAssembly loader and the generated types.
 */
const ALLOWED = ["svelte", "@tauri-apps/api/core", "@tauri-apps/api/event"];

const SOURCES = dirname(fileURLToPath(import.meta.url));
const GENERATED = [join(SOURCES, "lib", "bindings"), join(SOURCES, "lib", "preview-wasm")];

/** Asked of the runtime rather than written out, so the set cannot fall behind the Node the project runs on. */
const BUILTINS = new Set(builtinModules);
const isBuiltin = (spec: string) => spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]!);

/**
 * What a file imports, from the compiler's own pre-processor rather than a scan of the text: it catches every
 * form - bare `import "x"`, dynamic `import()`, `export ... from` - and ignores comments.
 */
const importsOf = (source: string): readonly string[] =>
  ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);

function* sourcesOf(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!GENERATED.includes(at)) yield* sourcesOf(at);
    } else if (/\.(ts|svelte)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) yield at;
  }
}

describe("the interface stays behind the command boundary", () => {
  const files = [...sourcesOf(SOURCES)];

  it("has sources for the scan to read", () => {
    // Without this the scan below passes on an empty list, which is what a moved source tree looks like.
    expect(files.length).toBeGreaterThan(0);
  });

  it(`imports nothing beyond its own files and ${ALLOWED.join(", ")}`, () => {
    for (const file of files) {
      const where = relative(SOURCES, file);
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".") || ALLOWED.includes(spec)) continue;
        const why = isBuiltin(spec) ? "reaches around the command boundary for" : "imports";
        expect.fail(`${where} ${why} ${spec}`);
      }
    }
  });

  it("reaches the network through a command rather than through the global", () => {
    // The one route out that no import scan sees. Matched off a word boundary that excludes a leading dot, so a
    // method named `fetch` on some object is not mistaken for the global.
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(/(?<![.\w])fetch\s*\(/.test(text), `${relative(SOURCES, file)} calls fetch`).toBe(false);
    }
  });
});
