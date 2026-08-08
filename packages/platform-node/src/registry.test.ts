import { describe, expect, it } from "vitest";
import { registryValue } from "./registry.js";

/** What `reg query HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\1440166436 /v path` prints, blank lines and all. */
const GOG_OUTPUT = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1440166436",
  "    path    REG_SZ    C:\\GOG Games\\Fallout 2",
  "",
].join("\r\n");

describe("reading a value out of reg query's output", () => {
  it("takes the data after the type, spaces in the path included", () => {
    expect(registryValue(GOG_OUTPUT, "path")).toBe("C:\\GOG Games\\Fallout 2");
  });

  it("matches the name whatever its casing, since the registry does not distinguish it", () => {
    expect(registryValue(GOG_OUTPUT, "PATH")).toBe("C:\\GOG Games\\Fallout 2");
  });

  it("takes the value asked for rather than the first one printed", () => {
    const output = ["    exe    REG_SZ    C:\\Games\\fallout2.exe", "    path    REG_SZ    C:\\Games"].join("\r\n");
    expect(registryValue(output, "path")).toBe("C:\\Games");
  });

  it("reads a type other than REG_SZ, which is what an expandable path is stored as", () => {
    expect(registryValue("    AppDataPath    REG_EXPAND_SZ    C:\\ProgramData\\Epic", "AppDataPath")).toBe(
      "C:\\ProgramData\\Epic",
    );
  });

  it("has nothing for a value that is not in the output", () => {
    expect(registryValue(GOG_OUTPUT, "exe")).toBeNull();
  });

  it("has nothing for a value that is present but empty, which names no directory", () => {
    expect(registryValue("    path    REG_SZ    ", "path")).toBeNull();
  });

  it("has nothing for the error text reg prints when the key is absent", () => {
    expect(
      registryValue("ERROR: The system was unable to find the specified registry key or value.", "path"),
    ).toBeNull();
  });
});
