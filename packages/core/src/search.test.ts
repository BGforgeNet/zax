import { describe, expect, it } from "vitest";
import { matchesQuery, type SettingDef } from "./catalog.js";

const def = (over: Partial<SettingDef>): SettingDef => ({
  id: "x",
  file: "f2_res.ini",
  section: "MAIN",
  key: "SCR_WIDTH",
  kind: { type: "int" },
  label: "Resolution X",
  ...over,
});

describe("matchesQuery", () => {
  it("matches on label, key, section, file and help", () => {
    expect(matchesQuery(def({}), "resolution x")).toBe(true);
    expect(matchesQuery(def({}), "scr_width")).toBe(true);
    expect(matchesQuery(def({}), "main")).toBe(true);
    expect(matchesQuery(def({}), "f2_res")).toBe(true);
    expect(matchesQuery(def({ help: "Sets the horizontal size" }), "horizontal")).toBe(true);
  });

  it("matches choice option labels", () => {
    const d = def({
      label: "Window mode",
      kind: {
        type: "choice",
        options: [
          { value: "0", label: "Fullscreen" },
          { value: "1", label: "Windowed" },
        ],
      },
    });
    expect(matchesQuery(d, "fullscreen")).toBe(true);
  });

  it("does not match on the source component label", () => {
    // "High resolution" as a group would otherwise make every setting in that file match "resolution",
    // burying the few settings the search is actually for.
    const unrelated = def({ label: "Grayscale", key: "IS_GRAY_SCALE", section: "EFFECTS" });
    expect(matchesQuery(unrelated, "resolution")).toBe(false);
  });

  it("treats an empty query as matching everything", () => {
    expect(matchesQuery(def({}), "   ")).toBe(true);
  });
});
