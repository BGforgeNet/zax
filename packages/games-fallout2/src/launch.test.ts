import { describe, expect, it } from "vitest";
import { planLaunch } from "./launch.js";
import type { Install } from "@zax/core";

const INSTALL: Install = { path: "/games/one", type: "fallout2" };

describe("planning a launch", () => {
  it("runs the executable directly on Windows", () => {
    expect(planLaunch("windows", INSTALL, "4.5")).toEqual({
      program: "fallout2.exe",
      args: [],
      cwd: "/games/one",
      env: {},
    });
  });

  it("runs it through Wine everywhere else", () => {
    const plan = planLaunch("linux", INSTALL, "4.5");
    expect(plan.program).toBe("wine");
    expect(plan.args).toEqual(["fallout2.exe"]);
    expect(plan.cwd).toBe("/games/one");
  });

  it("passes the install's own prefix and debug setting", () => {
    const wine = { prefix: "/home/t/.wine-fallout", debug: "warn+all" };
    expect(planLaunch("linux", { ...INSTALL, wine }, "4.5").env).toMatchObject({
      WINEPREFIX: "/home/t/.wine-fallout",
      WINEDEBUG: "warn+all",
    });
  });

  it("silences Wine's own logging when the install names no channels", () => {
    expect(planLaunch("linux", INSTALL, "4.5").env["WINEDEBUG"]).toBe("-all");
    expect(planLaunch("linux", { ...INSTALL, wine: { prefix: "/p" } }, "4.5").env["WINEDEBUG"]).toBe("-all");
  });

  it("leaves out a prefix the install does not have, rather than setting it empty", () => {
    expect(planLaunch("linux", INSTALL, "4.5").env).not.toHaveProperty("WINEPREFIX");
  });

  it("asks Wine for the native DirectDraw only, on the sfall releases that require it", () => {
    expect(planLaunch("linux", INSTALL, "4.1.1").env["WINEDLLOVERRIDES"]).toBe("ddraw.dll=n");
    expect(planLaunch("linux", INSTALL, "4.1.2").env["WINEDLLOVERRIDES"]).toBe("ddraw.dll=n,b");
    expect(planLaunch("linux", INSTALL, "4.5").env["WINEDLLOVERRIDES"]).toBe("ddraw.dll=n,b");
  });

  it("sets no override at all when the install has no sfall to load", () => {
    expect(planLaunch("linux", INSTALL, null).env).not.toHaveProperty("WINEDLLOVERRIDES");
  });
});

describe("planning a launch through an engine", () => {
  it("runs the engine's own executable on Windows", () => {
    expect(planLaunch("windows", INSTALL, "4.5", "fallout2-ce.exe")).toEqual({
      program: "fallout2-ce.exe",
      args: [],
      cwd: "/games/one",
      env: {},
    });
  });

  it("runs it from the install directory elsewhere, with no Wine at all", () => {
    const plan = planLaunch("linux", { ...INSTALL, wine: { prefix: "/home/t/.wine" } }, "4.5", "fallout2-ce");
    expect(plan.program).toBe("./fallout2-ce");
    expect(plan.args).toEqual([]);
    expect(plan.cwd).toBe("/games/one");
    // A native build loads no DirectDraw wrapper and needs no prefix; passing either would be a claim about
    // an engine that is not running under Wine at all.
    expect(plan.env).toEqual({});
  });

  it("runs the binary inside a macOS bundle, so the working directory is the install", () => {
    const plan = planLaunch("macos", INSTALL, null, "Fallout II Community Edition.app/Contents/MacOS/fallout2-ce");
    expect(plan.program).toBe("./Fallout II Community Edition.app/Contents/MacOS/fallout2-ce");
    expect(plan.cwd).toBe("/games/one");
  });

  it("still plans the original executable when no engine is named", () => {
    expect(planLaunch("windows", INSTALL, "4.5", null)).toEqual(planLaunch("windows", INSTALL, "4.5"));
  });
});
