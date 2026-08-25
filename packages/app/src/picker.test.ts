import { describe, expect, it } from "vitest";
import { folderPicked, pickerOptions } from "./picker.js";

describe("pickerOptions", () => {
  it("asks for a directory when nothing names a file to find", () => {
    expect(pickerOptions()).toEqual({ title: "Select the game folder", properties: ["openDirectory"] });
  });

  it("asks for the file itself when one is named, filtered by its extension", () => {
    // Fallout et tu wants the folder holding Fallout 1's master.dat. A directory picker shows no files, so
    // the file that settles which folder is the right one is the one thing the user cannot see.
    expect(pickerOptions("master.dat")).toEqual({
      title: "Select master.dat",
      properties: ["openFile"],
      filters: [
        { name: "master.dat", extensions: ["dat", "DAT"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
  });

  it("matches the shouting spelling these games actually ship", () => {
    // MASTER.DAT and FALLOUT2.EXE are how the files are really named, and a GTK filter is case-sensitive - a
    // lowercase-only glob would hide the answer on Linux. Both cases are offered in the same order however
    // the manifest spelled it, so the filter does not vary with the spelling of the question.
    expect(pickerOptions("MASTER.DAT").filters?.[0]?.extensions).toEqual(["dat", "DAT"]);
    expect(pickerOptions("fallout2.exe").filters?.[0]?.extensions).toEqual(["exe", "EXE"]);
  });

  it("still offers everything behind the filter, so no spelling is unreachable", () => {
    expect(pickerOptions("master.dat").filters?.at(-1)).toEqual({ name: "All files", extensions: ["*"] });
    expect(pickerOptions("CONFIG")).toEqual({
      title: "Select CONFIG",
      properties: ["openFile"],
      filters: [{ name: "All files", extensions: ["*"] }],
    });
  });
});

describe("folderPicked", () => {
  it("takes the folder around the file where one was asked for", () => {
    expect(folderPicked("/games/fallout/master.dat", "master.dat")).toBe("/games/fallout");
  });

  it("takes the pick as it stands where a folder was asked for", () => {
    expect(folderPicked("/games/fallout")).toBe("/games/fallout");
  });
});
