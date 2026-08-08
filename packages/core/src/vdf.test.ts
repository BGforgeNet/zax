import { describe, expect, it } from "vitest";
import { isVdfMap, parseVdf, vdfEntry } from "./vdf.js";

/** What Steam writes, escapes and all - the shape the scan actually has to read. */
const LIBRARY_FOLDERS = String.raw`"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"contentid"		"6089302862307036814"
		"apps"
		{
			"38410"		"1240122"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"label"		""
	}
}
`;

describe("reading Valve's key-values", () => {
  it("unescapes a Windows path, where every separator is doubled", () => {
    const folders = vdfEntry(parseVdf(LIBRARY_FOLDERS), "libraryfolders");
    expect(isVdfMap(folders)).toBe(true);
    const first = isVdfMap(folders) ? vdfEntry(folders, "0") : null;
    expect(isVdfMap(first) ? vdfEntry(first, "path") : null).toBe(String.raw`C:\Program Files (x86)\Steam`);
  });

  it("keeps nesting, so a library's own keys do not collide with another's", () => {
    const folders = vdfEntry(parseVdf(LIBRARY_FOLDERS), "libraryfolders");
    const second = isVdfMap(folders) ? vdfEntry(folders, "1") : null;
    expect(isVdfMap(second) ? vdfEntry(second, "path") : null).toBe(String.raw`D:\SteamLibrary`);
  });

  it("matches a key whatever its casing, which has changed between Steam versions", () => {
    expect(vdfEntry(parseVdf(`"LibraryFolders" { "0" { "path" "X:\\L" } }`), "libraryfolders")).toBeTruthy();
  });

  it("reads a game manifest, which is the same format under another extension", () => {
    const state = vdfEntry(parseVdf(`"AppState" { "appid" "38410" "installdir" "Fallout 2" }`), "AppState");
    expect(isVdfMap(state) ? vdfEntry(state, "installdir") : null).toBe("Fallout 2");
  });

  it("ignores line comments", () => {
    expect(vdfEntry(parseVdf(`// a note\n"k" "v"`), "k")).toBe("v");
  });

  it("returns what was readable before a truncated file ran out, rather than nothing", () => {
    const parsed = parseVdf(String.raw`"libraryfolders" { "0" { "path" "D:\\L" } "1" { "path" "E:\\`);
    const folders = vdfEntry(parsed, "libraryfolders");
    const first = isVdfMap(folders) ? vdfEntry(folders, "0") : null;
    expect(isVdfMap(first) ? vdfEntry(first, "path") : null).toBe(String.raw`D:\L`);
  });

  it("survives a stray closing brace instead of losing the file to it", () => {
    expect(vdfEntry(parseVdf(`} "k" "v"`), "k")).toBe("v");
  });

  it("has no entry for a key that is not there", () => {
    expect(vdfEntry(parseVdf(`"k" "v"`), "other")).toBeNull();
  });
});
