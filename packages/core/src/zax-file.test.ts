import { describe, expect, it } from "vitest";
import { EMPTY_ZAX_FILE, formatZaxFile, parseZaxFile } from "./zax-file.js";

/** What the previous implementation wrote, so the compatibility claim is tested rather than asserted. */
const PREVIOUS = `games:
- path: /home/t/Games/Fallout 2
  wine_prefix: /home/t/.wine-fallout
  wine_debug: -all
- path: /home/t/Games/Fallout 2 RPU
theme: dark
`;

describe("reading zax.yml", () => {
  it("reads a file the previous implementation wrote", () => {
    expect(parseZaxFile(PREVIOUS)).toEqual({
      installs: [
        { path: "/home/t/Games/Fallout 2", wine: { prefix: "/home/t/.wine-fallout", debug: "-all" } },
        { path: "/home/t/Games/Fallout 2 RPU" },
      ],
      theme: "dark",
      autosave: true,
      acceptedCautions: [],
    });
  });

  it("treats an empty or absent games list as no installs rather than failing", () => {
    expect(parseZaxFile("theme: light")).toEqual({
      installs: [],
      theme: "light",
      autosave: true,
      acceptedCautions: [],
    });
    expect(parseZaxFile("")).toEqual({ installs: [], theme: "system", autosave: true, acceptedCautions: [] });
  });

  /*
    A file written before autosave existed has no such key, and one a user hand-edited may have anything in it.
    Both read as the default: only the false this application writes when the box is cleared turns it off, so
    the setting is a choice the user made rather than a key their old file happened not to carry.
  */
  it("reads autosave as on unless the file says false", () => {
    expect(parseZaxFile("autosave: false").autosave).toBe(false);
    expect(parseZaxFile("autosave: true").autosave).toBe(true);
    expect(parseZaxFile("games: []").autosave).toBe(true);
    expect(parseZaxFile("autosave: no-thanks").autosave).toBe(true);
    expect(parseZaxFile('autosave: "false"').autosave).toBe(true);
  });

  it("round-trips autosave through a write and a read", () => {
    const written = formatZaxFile({
      installs: [{ path: "/a" }],
      theme: "system",
      autosave: true,
      acceptedCautions: [],
    });
    expect(parseZaxFile(written).autosave).toBe(true);
  });

  /*
    Ids rather than one flag, so dismissing one engine's warning does not silence the next engine's. Entries are
    checked one at a time the way the installs are: a hand-edited line costs that id, not the list.
  */
  it("reads the dismissed cautions, dropping entries that are not names", () => {
    expect(parseZaxFile("accepted_cautions:\n- fission\n- '  '\n- 7\n").acceptedCautions).toEqual(["fission"]);
    expect(parseZaxFile("accepted_cautions: not-a-list").acceptedCautions).toEqual([]);
    expect(parseZaxFile("games: []").acceptedCautions).toEqual([]);
  });

  it("round-trips a dismissal, and writes no key while there is none", () => {
    const written = formatZaxFile({ ...EMPTY_ZAX_FILE, acceptedCautions: ["fission"] });
    expect(written).toContain("accepted_cautions:");
    expect(parseZaxFile(written).acceptedCautions).toEqual(["fission"]);
    // A file from before the key existed stays as it was until something is actually dismissed.
    expect(formatZaxFile(EMPTY_ZAX_FILE)).not.toContain("accepted_cautions");
  });

  it("falls back to the system theme when the file names one that no longer exists", () => {
    expect(parseZaxFile("theme: Dark Brown\n").theme).toBe("system");
  });

  it("skips a malformed entry and keeps the rest, so one bad line costs one install", () => {
    const text = "games:\n- path: /a\n- wine_prefix: /p\n- path: '   '\n- path: /b\n";
    expect(parseZaxFile(text).installs).toEqual([{ path: "/a" }, { path: "/b" }]);
  });

  it("drops Wine fields that are present but empty", () => {
    expect(parseZaxFile("games:\n- path: /a\n  wine_prefix: ''\n  wine_debug: ''\n").installs).toEqual([
      { path: "/a" },
    ]);
  });

  it("throws when the YAML itself will not parse, rather than reporting an empty list", () => {
    expect(() => parseZaxFile("games:\n- path: [unclosed\n")).toThrow();
  });
});

describe("writing zax.yml", () => {
  it("round-trips through the format the previous implementation reads", () => {
    expect(parseZaxFile(formatZaxFile(parseZaxFile(PREVIOUS)))).toEqual(parseZaxFile(PREVIOUS));
  });

  it("writes the keys under the names the previous implementation used", () => {
    const text = formatZaxFile({
      installs: [{ path: "/a", wine: { prefix: "/p", debug: "-all" } }],
      theme: "light",
      autosave: false,
      acceptedCautions: [],
    });
    expect(text).toContain("wine_prefix: /p");
    expect(text).toContain("wine_debug: -all");
    expect(text).toContain("theme: light");
  });

  it("omits Wine keys an install does not have, rather than writing them blank", () => {
    expect(
      formatZaxFile({ installs: [{ path: "/a" }], theme: "system", autosave: false, acceptedCautions: [] }),
    ).not.toContain("wine_");
  });

  it("keeps an alias the user chose across a round trip", () => {
    const text = formatZaxFile({
      installs: [{ path: "/a", alias: "My playthrough" }],
      theme: "system",
      autosave: false,
      acceptedCautions: [],
    });
    expect(text).toContain("alias: My playthrough");
    expect(parseZaxFile(text).installs).toEqual([{ path: "/a", alias: "My playthrough" }]);
  });

  it("writes no alias for an install left at its type's name, so it follows the type", () => {
    expect(
      formatZaxFile({ installs: [{ path: "/a" }], theme: "system", autosave: false, acceptedCautions: [] }),
    ).not.toContain("alias:");
    expect(parseZaxFile("games:\n- path: /a\n  alias: '   '\n").installs).toEqual([{ path: "/a" }]);
  });

  it("sorts by path, so the file does not reorder itself between saves", () => {
    const text = formatZaxFile({
      installs: [{ path: "/b" }, { path: "/a" }],
      theme: "system",
      autosave: false,
      acceptedCautions: [],
    });
    expect(text.indexOf("/a")).toBeLessThan(text.indexOf("/b"));
  });
});

describe("long paths", () => {
  const long = "/home/tester/some/deeply/nested/place/for/games/GOG Games/Fallout 2 with the restoration project";

  it("keeps an install path on one line, since people hand-edit this file", () => {
    const text = formatZaxFile({ installs: [{ path: long }], theme: "system", autosave: false, acceptedCautions: [] });
    expect(text).toContain(`- path: ${long}\n`);
  });

  it("reads back what it wrote", () => {
    expect(
      parseZaxFile(
        formatZaxFile({ installs: [{ path: long }], theme: "system", autosave: false, acceptedCautions: [] }),
      ).installs,
    ).toEqual([{ path: long }]);
  });
});
