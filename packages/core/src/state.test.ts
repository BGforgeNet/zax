import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { loadState, saveState } from "./state.js";

const CONFIG = "/home/t/.config/zax";

function withState(text: string, files: Record<string, string> = {}) {
  return new MemoryPlatform({ home: "/home/t", files: { [`${CONFIG}/zax.yml`]: text, ...files } });
}

const present = (root: string) => ({ [`${root}/fallout2.exe`]: "MZ" });

describe("loading application state", () => {
  it("starts empty on a machine that has never run it", async () => {
    const { state, problem } = await loadState(new MemoryPlatform({ home: "/home/t" }));
    expect(problem).toBeUndefined();
    expect(state).toEqual({ installs: [], unavailable: [], theme: "system" });
  });

  it("reads the type from the directory rather than from the file", async () => {
    const platform = withState("games:\n- path: /games/one\ntheme: dark\n", {
      ...present("/games/one"),
      "/games/one/mods/rpu.dat": "",
    });
    const { state } = await loadState(platform);
    expect(state.installs).toEqual([{ path: "/games/one", type: "fallout2rpu" }]);
    expect(state.theme).toBe("dark");
  });

  it("carries Wine settings through", async () => {
    const platform = withState("games:\n- path: /games/one\n  wine_prefix: /p\n", present("/games/one"));
    expect((await loadState(platform)).state.installs[0]?.wine).toEqual({ prefix: "/p" });
  });

  it("carries a chosen alias through, alongside the type it still reads from the directory", async () => {
    const platform = withState("games:\n- path: /games/one\n  alias: My playthrough\n", present("/games/one"));
    const install = (await loadState(platform)).state.installs[0];
    expect(install?.alias).toBe("My playthrough");
    expect(install?.type, "the alias is the user's; the type is still the directory's").toBe("fallout2");
  });

  it("sets aside an install it cannot read instead of listing it", async () => {
    const platform = withState("games:\n- path: /games/one\n- path: /mnt/usb/two\n", present("/games/one"));
    const { state } = await loadState(platform);
    expect(state.installs.map((one) => one.path)).toEqual(["/games/one"]);
    expect(state.unavailable).toEqual([{ path: "/mnt/usb/two" }]);
  });

  it("reports an unreadable file rather than presenting it as a first run", async () => {
    const { state, problem } = await loadState(withState("games:\n- path: [unclosed\n"));
    expect(problem).toMatch(/zax\.yml could not be read/);
    expect(state.installs).toEqual([]);
  });
});

describe("saving application state", () => {
  it("writes the file where the previous implementation kept it", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await saveState(platform, {
      installs: [{ path: "/games/one", type: "fallout2", wine: { prefix: "/p" } }],
      unavailable: [],
      theme: "light",
    });
    expect(platform.textAt(`${CONFIG}/zax.yml`)).toContain("path: /games/one");
    expect(platform.textAt(`${CONFIG}/zax.yml`)).toContain("wine_prefix: /p");
  });

  it("writes a chosen alias so it is there on the next run", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await saveState(platform, {
      installs: [{ path: "/games/one", type: "fallout2up", alias: "My playthrough" }],
      unavailable: [],
      theme: "system",
    });
    expect(platform.textAt(`${CONFIG}/zax.yml`)).toContain("alias: My playthrough");
  });

  it("does not write the detected type, which is read from the directory each time", async () => {
    const platform = new MemoryPlatform({ home: "/home/t" });
    await saveState(platform, { installs: [{ path: "/games/one", type: "fallout2rpu" }], unavailable: [], theme: "system" });
    expect(platform.textAt(`${CONFIG}/zax.yml`)).not.toContain("fallout2rpu");
  });

  it("keeps an install that was unreadable this session, so an offline drive is not forgotten", async () => {
    const platform = withState("games:\n- path: /games/one\n- path: /mnt/usb/two\n", present("/games/one"));
    const { state } = await loadState(platform);
    await saveState(platform, state);
    expect(platform.textAt(`${CONFIG}/zax.yml`)).toContain("/mnt/usb/two");
  });

  it("survives a full round trip", async () => {
    const platform = withState("games:\n- path: /games/one\n  wine_debug: -all\ntheme: dark\n", present("/games/one"));
    const first = (await loadState(platform)).state;
    await saveState(platform, first);
    expect((await loadState(platform)).state).toEqual(first);
  });
});
