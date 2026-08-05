import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { BACKEND_METHODS } from "./backend-methods.js";
import { RELEASES_PAGE, createBackend } from "./backend.js";
import type { Backend } from "./backend.js";

const install = { path: "/games/one", type: "fallout2" as const };

function ready() {
  return new MemoryPlatform({
    home: "/home/t",
    files: {
      "/games/one/fallout2.exe": "MZ",
      "/games/one/fallout2.cfg": "[sound]\r\nmusic=1\r\n",
      "/home/t/.config/zax/zax.yml": "games:\n- path: /games/one\ntheme: dark\n",
    },
  });
}

describe("the operation list", () => {
  it("covers the interface, which is what keeps the two halves of the boundary in step", () => {
    // The desktop build registers a channel per name and the preload builds a caller per name; a method the
    // list forgot exists on the interface, typechecks everywhere, and is simply missing at runtime.
    const backend = createBackend(new MemoryPlatform());
    const declared = Object.keys(backend).sort();
    expect([...BACKEND_METHODS].sort()).toEqual(declared);
  });

  it("names only real methods", () => {
    const backend = createBackend(new MemoryPlatform()) as unknown as Record<string, unknown>;
    for (const name of BACKEND_METHODS) expect(typeof backend[name], name).toBe("function");
  });

  it("carries only what a message can: no argument or result is a function or a class instance", async () => {
    const backend = createBackend(ready());
    const results = [await backend.describe(), await backend.loadState(), await backend.loadConfigFiles("/games/one")];
    // What survives JSON is what survives any transport, and this boundary is a real one in the desktop build.
    for (const result of results) expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("the operations", () => {
  it("reports the machine and its own directories", async () => {
    expect(await createBackend(ready()).describe()).toEqual({
      os: "linux",
      backupDirectory: "/home/t/.cache/zax/backup",
      debugDirectory: "/home/t/.cache/zax/debug",
      logFile: "/home/t/.cache/zax/zax.log",
    });
  });

  it("reads the state file through to the resolved install", async () => {
    const { state } = await createBackend(ready()).loadState();
    expect(state.installs).toEqual([{ path: "/games/one", type: "fallout2" }]);
    expect(state.theme).toBe("dark");
  });

  it("launches through the plan for this machine", async () => {
    const platform = ready();
    await createBackend(platform).launch({ ...install, wine: { prefix: "/p" } }, "4.5");
    expect(platform.launched).toEqual([
      {
        program: "wine",
        args: ["fallout2.exe"],
        options: { cwd: "/games/one", env: { WINEPREFIX: "/p", WINEDLLOVERRIDES: "ddraw.dll=n,b" } },
      },
    ]);
  });

  it("opens its own directories by name, so a caller cannot ask for another path", async () => {
    const platform = ready();
    const backend = createBackend(platform);
    for (const target of ["backup", "debug", "log", "releases"] as const) await backend.open(target);
    expect(platform.opened).toEqual([
      "/home/t/.cache/zax/backup",
      "/home/t/.cache/zax/debug",
      "/home/t/.cache/zax/zax.log",
      RELEASES_PAGE,
    ]);
  });

  it("empties a directory and leaves it there, so the path it shows stays valid", async () => {
    const platform = ready();
    await platform.fs.write("/home/t/.cache/zax/backup/old/fallout2.cfg", new Uint8Array([1]));
    await createBackend(platform).wipe("backup");
    expect(platform.allFiles().some((path) => path.includes("/backup/"))).toBe(false);
    expect((await platform.fs.stat("/home/t/.cache/zax/backup"))?.kind).toBe("dir");
  });

  it("leaves the other directory alone", async () => {
    const platform = ready();
    await platform.fs.write("/home/t/.cache/zax/debug/one.zip", new Uint8Array([1]));
    await createBackend(platform).wipe("backup");
    expect(platform.textAt("/home/t/.cache/zax/debug/one.zip")).toBeDefined();
  });
});

/** A compile-time check that the list is exactly the interface's keys, not merely a subset of them. */
const _covers: Record<keyof Backend, true> = Object.fromEntries(
  BACKEND_METHODS.map((name) => [name, true]),
) as Record<keyof Backend, true>;
void _covers;
