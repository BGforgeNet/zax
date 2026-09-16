/**
 * The boundary's two halves, held to each other.
 *
 * `COMMANDS` and the shell's `zax_commands!` list are the one fact written twice - once in Rust, where
 * the compiler checks each name resolves to a command, and once here, where it cannot. This reads the
 * Rust and compares, which is what `backend.test.ts` did for `BACKEND_METHODS` before the port.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COMMANDS, commands } from "./commands.js";

const SHELL = fileURLToPath(new URL("../../../../crates/shell/src/lib.rs", import.meta.url));

/** Every name inside the handler list, which is the shell's whole command surface. */
function registered(): string[] {
  const source = readFileSync(SHELL, "utf8");
  const list = /generate_handler!\[([^\]]*)\]/s.exec(source);
  if (!list) throw new Error("The shell's handler list could not be found - has it been renamed?");
  return [...list[1]!.matchAll(/commands::(\w+)/g)].map((found) => found[1]!);
}

describe("the command surface", () => {
  it("names exactly what the shell registers", () => {
    expect([...COMMANDS].toSorted()).toEqual(registered().toSorted());
  });

  it("has a wrapper for every name", () => {
    // The names are snake_case on the wire and camelCase here, so the wrappers are counted rather
    // than matched: a name with no wrapper is a command nothing can call.
    expect(Object.keys(commands)).toHaveLength(COMMANDS.length);
  });

  it("wraps each name once", () => {
    expect(new Set(COMMANDS).size).toBe(COMMANDS.length);
  });
});
