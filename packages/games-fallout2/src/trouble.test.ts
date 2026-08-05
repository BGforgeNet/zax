import { describe, expect, test } from "vitest";
import { ACTIONS } from "./actions.js";
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
});
