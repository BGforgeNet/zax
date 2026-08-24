import { describe, expect, test } from "vitest";
import { ACTIONS } from "./actions.js";
import { WANTED } from "./debug-package.js";
import { DEBUG_PACKAGE_CONTENTS } from "./trouble.js";

describe("troubleshooting", () => {
  test("the workflow's actions exist", () => {
    // The view asks for these by id; a rename would silently drop a step of the bug report.
    const known = new Set(ACTIONS.map((a) => a.id));
    for (const id of ["debug.enable", "debug.disable", "fix.not-responding"]) {
      expect(known, id).toContain(id);
    }
  });

  test("the archive's contents are listed once each", () => {
    expect(new Set(DEBUG_PACKAGE_CONTENTS).size).toBe(DEBUG_PACKAGE_CONTENTS.length);
  });

  test("names every file the collector goes looking for", () => {
    // The list is prose kept by hand beside the collector's own, and a file added to one is invisible to the
    // other: the panel then promises an archive that is missing something, or omits what it does carry.
    const prose = DEBUG_PACKAGE_CONTENTS.join(" ");
    for (const name of WANTED) expect(prose, `${name} is collected but not listed`).toContain(name);
  });
});
