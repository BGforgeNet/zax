import { describe, expect, it } from "vitest";
import { ENGINES, buildFor, engineById } from "./engines.js";

const CE = engineById("fallout2-ce");

describe("the engine catalog", () => {
  it("names one build per machine, with no machine claimed twice", () => {
    for (const engine of ENGINES) {
      const seen = engine.builds.map((build) => `${build.os}/${build.arch ?? "any"}`);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it("runs something every one of its builds actually deploys", () => {
    for (const engine of ENGINES) {
      for (const build of engine.builds) {
        // The program is either deployed whole, or sits inside a directory that is.
        const covered = build.members.some(
          (member) => member.to === build.program || build.program.startsWith(`${member.to}/`),
        );
        expect(covered, `${engine.id} ${build.asset} runs ${build.program}`).toBe(true);
      }
    }
  });

  it("never deploys a member outside the install", () => {
    for (const engine of ENGINES) {
      for (const build of engine.builds) {
        for (const member of build.members) {
          expect(member.to.startsWith("/")).toBe(false);
          expect(member.to.split("/")).not.toContain("..");
        }
      }
    }
  });
});

describe("choosing a build", () => {
  it("picks the build for this operating system and processor", () => {
    expect(buildFor(CE, "windows", "x64")?.asset).toBe("fallout2-ce-windows-x64.zip");
    expect(buildFor(CE, "linux", "x64")?.asset).toBe("fallout2-ce-linux-x64.tar.gz");
    expect(buildFor(CE, "linux", "arm64")?.asset).toBe("fallout2-ce-linux-arm64.tar.gz");
  });

  it("takes the one build a project publishes for every processor", () => {
    expect(buildFor(CE, "macos", "x64")?.asset).toBe("Fallout.II.Community.Edition.dmg");
    expect(buildFor(CE, "macos", "arm64")?.asset).toBe("Fallout.II.Community.Edition.dmg");
    expect(buildFor(CE, "macos", "other")?.asset).toBe("Fallout.II.Community.Edition.dmg");
  });

  it("answers null where there is no build this machine can run", () => {
    expect(buildFor(CE, "windows", "arm64")).toBeNull();
    expect(buildFor(CE, "linux", "other")).toBeNull();
  });

  it("refuses an id it does not carry", () => {
    expect(() => engineById("fallout3-ce")).toThrow(/fallout3-ce/);
  });
});
