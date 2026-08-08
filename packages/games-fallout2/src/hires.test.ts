import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { installedHiresVersion } from "./hires.js";
import { library } from "./pe-fixture.js";
import type { Install } from "@zax/core";

const INSTALL: Install = { path: "/games/one", type: "fallout2" };

describe("the installed hi-res patch", () => {
  it("reads its version from the library the game loads", async () => {
    // The string a real f2_res.dll carries; 4.1.8 is what the patch is published as.
    const platform = new MemoryPlatform({
      files: { "/games/one/f2_res.dll": library({ FileVersion: "4, 1, 8, 0" }) },
    });
    expect(await installedHiresVersion(platform, INSTALL)).toBe("4.1.8");
  });

  it("reports nothing for an install without the patch", async () => {
    const platform = new MemoryPlatform({ files: { "/games/one/fallout2.exe": "MZ" } });
    expect(await installedHiresVersion(platform, INSTALL)).toBeNull();
  });

  // The patch's config file survives an uninstall, so its presence is not what says the patch is there.
  it("reports nothing when only the config file is left behind", async () => {
    const platform = new MemoryPlatform({ files: { "/games/one/f2_res.ini": "[MAIN]\r\nSCR_WIDTH=1024\r\n" } });
    expect(await installedHiresVersion(platform, INSTALL)).toBeNull();
  });
});
