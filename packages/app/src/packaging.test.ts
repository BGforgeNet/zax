import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");

function list(name: string): string[] {
  const lines = config.split("\n");
  const start = lines.indexOf(`${name}:`);
  if (start < 0) return [];

  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("  #")) continue;
    if (!line.startsWith("  - ")) break;
    entries.push(line.slice(4).replace(/^"(.*)"$/, "$1"));
  }
  return entries;
}

describe("the packaged application", () => {
  it("keeps only the locales the English interface uses", () => {
    expect(list("electronLanguages")).toEqual(["en"]);
  });

  it("does not ship build-only source maps", () => {
    expect(list("files")).toContain("!dist/**/*.map");
  });
});
