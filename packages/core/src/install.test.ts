import { describe, expect, it } from "vitest";
import {
  addInstall,
  detectGameType,
  displayName,
  removeInstall,
  setAlias,
  withWine,
  type Install,
} from "./install.js";

const at = (path: string): Install => ({ path, type: "fallout2" });

describe("detecting an install", () => {
  it("is not an install without the executable, whatever else is there", () => {
    expect(detectGameType(["readme.txt", "master.dat"], ["rpu.dat"])).toBeNull();
    expect(detectGameType([], [])).toBeNull();
  });

  it("names the mod from what sits in mods/", () => {
    expect(detectGameType(["fallout2.exe"], [])).toBe("fallout2");
    expect(detectGameType(["fallout2.exe"], ["upu.dat"])).toBe("fallout2upu");
    expect(detectGameType(["fallout2.exe"], ["rpu.dat"])).toBe("fallout2rpu");
  });

  it("prefers the restoration project when both mods are present", () => {
    // Installing RPU over UPU leaves both .dat files behind, and RPU is the one actually loaded.
    expect(detectGameType(["fallout2.exe"], ["upu.dat", "rpu.dat"])).toBe("fallout2rpu");
  });

  it("matches case-insensitively, because Wine and Windows disagree about it", () => {
    expect(detectGameType(["FALLOUT2.EXE"], ["RPU.DAT"])).toBe("fallout2rpu");
  });

  it("names killap's unofficial patch from its root marker, since it adds no mods/ entry", () => {
    // Taken from a real killap-patched install: the patch writes into data/ and leaves these in the root.
    const root = ["fallout2.exe", "up-changelog.txt", "up-readme.txt", "master.dat"];
    expect(detectGameType(root, [])).toBe("fallout2up");
  });

  it("prefers the updated fork over the killap marker it descends from", () => {
    // A UPU folder can hold both; reporting the ancestor there would name a mod that is not the one loaded.
    expect(detectGameType(["fallout2.exe", "up-changelog.txt"], ["upu.dat"])).toBe("fallout2upu");
    expect(detectGameType(["fallout2.exe", "up-changelog.txt"], ["rpu.dat"])).toBe("fallout2rpu");
  });

  it("names killap's restoration project, which carries the unofficial patch and both markers", () => {
    // The restoration project's own installer makes this exact test: an install is the unofficial patch only
    // when up-changelog.txt is there and rp-changelog.txt is not.
    const root = ["fallout2.exe", "up-changelog.txt", "rp-changelog.txt"];
    expect(detectGameType(root, [])).toBe("fallout2rp");
    expect(detectGameType(["fallout2.exe", "rp-changelog.txt"], [])).toBe("fallout2rp");
  });

  it("is still vanilla when nothing marks a patch", () => {
    expect(detectGameType(["fallout2.exe", "master.dat", "readme.rtf"], [])).toBe("fallout2");
  });
});

describe("an install's alias", () => {
  it("falls back to the name the type carries", () => {
    expect(displayName({ path: "/games/a", type: "fallout2" })).toBe("Fallout 2");
    expect(displayName({ path: "/games/a", type: "fallout2up" })).toBe("Unofficial Patch");
    expect(displayName({ path: "/games/a", type: "fallout2upu" })).toBe("Unofficial Patch Updated");
  });

  it("uses the alias once there is one", () => {
    const named = setAlias([at("/games/a")], "/games/a", "My playthrough");
    expect(displayName(named[0]!)).toBe("My playthrough");
  });

  it("sets the alias on only the named install", () => {
    const list = setAlias([at("/games/a"), at("/games/b")], "/games/a", "Mine");
    expect(list[0]?.alias).toBe("Mine");
    expect(list[1]?.alias).toBeUndefined();
  });

  it("clears back to the type's name rather than storing a blank alias", () => {
    const named = setAlias([at("/games/a")], "/games/a", "  Mine  ");
    expect(named[0]?.alias, "surrounding space is not part of the alias").toBe("Mine");

    const cleared = setAlias(named, "/games/a", "   ");
    expect(cleared[0]?.alias).toBeUndefined();
    expect(displayName(cleared[0]!)).toBe("Fallout 2");
  });

  it("keeps the alias when wine settings change, and the wine settings when the alias does", () => {
    const named = setAlias([at("/games/a")], "/games/a", "Mine");
    const wined = withWine(named, "/games/a", { prefix: "/p" });
    expect(wined[0]?.alias).toBe("Mine");

    const renamed = setAlias(wined, "/games/a", "Yours");
    expect(renamed[0]?.wine).toEqual({ prefix: "/p" });
  });
});

describe("the install list", () => {
  it("stays sorted as installs arrive out of order", () => {
    let list: readonly Install[] = [];
    for (const p of ["/games/zzz", "/games/aaa", "/games/mmm"]) {
      const r = addInstall(list, at(p));
      if (r.ok) list = r.installs;
    }
    expect(list.map((g) => g.path)).toEqual(["/games/aaa", "/games/mmm", "/games/zzz"]);
  });

  it("refuses a duplicate path rather than listing it twice", () => {
    const first = addInstall([], at("/games/f2"));
    expect(first.ok).toBe(true);
    const again = addInstall(first.ok ? first.installs : [], at("/games/f2"));
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toContain("already");
  });

  it("removes only the named install", () => {
    const list = [at("/games/a"), at("/games/b")];
    expect(removeInstall(list, "/games/a").map((g) => g.path)).toEqual(["/games/b"]);
    expect(removeInstall(list, "/games/nowhere")).toHaveLength(2);
  });
});

describe("wine settings", () => {
  it("attaches to one install and leaves its siblings alone", () => {
    const list = [at("/games/a"), at("/games/b")];
    const next = withWine(list, "/games/a", { prefix: "/home/u/.wine" });
    expect(next[0]?.wine).toEqual({ prefix: "/home/u/.wine" });
    expect(next[1]?.wine).toBeUndefined();
  });

  it("drops a field cleared back to empty instead of storing a blank", () => {
    const set = withWine([at("/games/a")], "/games/a", { prefix: "/p", debug: "-all" });
    expect(set[0]?.wine).toEqual({ prefix: "/p", debug: "-all" });

    const cleared = withWine(set, "/games/a", { prefix: "/p", debug: "   " });
    expect(cleared[0]?.wine).toEqual({ prefix: "/p" });

    const empty = withWine(cleared, "/games/a", { prefix: "", debug: "" });
    expect(empty[0]?.wine, "an install nobody configured carries no wine key at all").toBeUndefined();
  });
});
