import { describe, expect, it } from "vitest";
import { addInstall, detectGameType, removeInstall, withWine, type Install } from "./install.js";

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
