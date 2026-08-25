/**
 * What the shell's file picker is opened with, and what the path it answers with means.
 *
 * Its own module for the reason `navigation.ts` is one: `main.ts` is wiring that no test reaches, and this is
 * a decision with cases. The Electron call itself stays there; the two ends of it are here.
 */

import { dirname } from "node:path";

/** The subset of Electron's open-dialog options these two cases need. Structurally what `dialog` expects. */
export interface PickerOptions {
  title: string;
  properties: ("openFile" | "openDirectory")[];
  filters?: { name: string; extensions: string[] }[];
}

/**
 * How to ask for a folder: directly, or - given `holding` - by asking for a file inside it.
 *
 * A folder picker shows no files, so a user asked for "the folder holding master.dat" has to recognise it by
 * name alone, and the one thing that would settle it is what the picker will not show them. An extension is
 * all a filter can express, so the file's own name goes in the title where it can be read.
 *
 * Both cases of the extension, and an all-files entry behind it. These games are DOS-era and ship their files
 * shouting - `MASTER.DAT`, `FALLOUT2.EXE` - while a GTK file chooser matches a filter case-sensitively, so a
 * single lowercase glob would hide the very file being asked for on Linux. The all-files entry is the escape
 * hatch for whatever spelling neither covers: a filter that hides the answer is worse than no filter.
 */
export function pickerOptions(holding?: string): PickerOptions {
  if (holding === undefined) return { title: "Select the game folder", properties: ["openDirectory"] };
  const suffix = holding.includes(".") ? (holding.split(".").pop() ?? "") : "";
  const cases = [...new Set([suffix.toLowerCase(), suffix.toUpperCase()])];
  return {
    title: `Select ${holding}`,
    properties: ["openFile"],
    filters:
      suffix === ""
        ? [{ name: "All files", extensions: ["*"] }]
        : [
            { name: holding, extensions: cases },
            { name: "All files", extensions: ["*"] },
          ],
  };
}

/**
 * The folder a pick means. Asking by way of a file answers with the file, and every caller wants the folder
 * around it - which is also why the answer cannot then fail the `holds` check that sent us here.
 */
export function folderPicked(picked: string, holding?: string): string {
  return holding === undefined ? picked : dirname(picked);
}
