// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InstalledEngine } from "./bindings/InstalledEngine";
import EnginesView from "./EnginesView.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The engines tab. Two projects publish differently - one tags its releases, the other republishes one rolling
  tag - so what names a build to the user differs per engine, and getting it wrong shows every build of a
  rolling project under one identical name.
*/

const TAGGED = {
  id: "fallout2-ce",
  name: "Fallout II Community Edition",
  short: "CE",
  page: "https://github.com/fallout2-ce/fallout2-ce",
  releases: "tagged",
  build: { asset: "fallout2-ce-linux-x64.tar.gz", program: "fallout2-ce" },
  versions: [],
} as const;

const ROLLING = {
  id: "fission",
  name: "Fallout Fission",
  short: "Fission",
  page: "https://github.com/cambragol/fission-ce",
  releases: "rolling",
  build: { asset: "fallout-fission-linux-x64.zip", program: "fallout-fission" },
  versions: [],
} as const;

beforeEach(async () => {
  await reseedPreview();
  vi.spyOn(store, "engines", "get").mockReturnValue([TAGGED] as never);
  vi.spyOn(store, "engineLatest", "get").mockReturnValue({});
});
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const view = () => render(EnginesView as never, {} as never);

describe("each engine's heading", () => {
  test("names the project and links to where it is published", () => {
    const v = view();
    expect(v.one(".engine h2").textContent).toBe(TAGGED.name);
    expect(v.one<HTMLAnchorElement>("a").getAttribute("href")).toBe(TAGGED.page);
  });

  /* An icon beside a name it repeats is noise to a screen reader, so it carries an empty alt deliberately. */
  test("leaves the icon out of the accessible name, since the heading beside it already says which project", () => {
    expect(view().one<HTMLImageElement>("img.engine-icon").getAttribute("alt")).toBe("");
  });

  test("names the build this machine would get", () => {
    expect(view().text()).toContain(TAGGED.build.asset);
  });

  test("says why there is nothing to install where the project publishes no build for this machine", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([
      { ...TAGGED, build: null, why: "Fallout II CE publishes no build for this machine." },
    ] as never);
    const v = view();
    expect(v.one(".problem").textContent).toContain("publishes no build for this machine");
    expect(v.control("Fetch latest").hasAttribute("disabled")).toBe(true);
  });
});

describe("how a build is named", () => {
  /*
    A tagged project versions its releases, so the tag is the name. A rolling one republishes one tag, so the
    tag says nothing and the publication date is what separates two builds.
  */
  test("a tagged project shows its release tag", () => {
    vi.spyOn(store, "engineLatest", "get").mockReturnValue({
      "fallout2-ce": { release: "v1.4.0", published: "2026-05-01T00:00:00Z" },
    } as never);
    expect(view().text()).toContain("v1.4.0");
  });

  test("a rolling project shows the publication date rather than its unchanging tag", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([ROLLING] as never);
    vi.spyOn(store, "engineLatest", "get").mockReturnValue({
      fission: { release: "continuous", published: "2026-05-01T00:00:00Z" },
    } as never);
    const text = view().text();
    expect(text).not.toContain("continuous");
    expect(text).toContain(new Date("2026-05-01T00:00:00Z").toLocaleDateString());
  });

  /* Shortened the way git does: seven characters identify the commit and a full sha reads as noise. */
  test("shows the commit a build came from, shortened", () => {
    vi.spyOn(store, "engineLatest", "get").mockReturnValue({
      "fallout2-ce": { release: "v1.4.0", published: "2026-05-01T00:00:00Z", commit: "0123456789abcdef" },
    } as never);
    const code = view().one("code.sha");
    expect(code.textContent).toBe("0123456");
  });

  test("says the latest is unchecked rather than implying it is up to date", () => {
    expect(view().text()).toContain("not checked");
  });
});

describe("the builds this machine holds", () => {
  const HELD = [
    { release: "v1.4.0", published: "2026-05-01T00:00:00Z", commit: null },
    { release: "v1.3.0", published: "2026-01-01T00:00:00Z", commit: null },
  ];

  test("says so plainly when the machine holds none", () => {
    expect(view().text()).toContain("On this machine no build yet");
  });

  test("lists a row per build, newest first as the cache returns them", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([{ ...TAGGED, versions: HELD }] as never);
    const rows = view().all(".held");
    expect(rows.map((row) => row.textContent?.trim().split(/\s+/)[0])).toEqual(["v1.4.0", "v1.3.0"]);
  });

  test("drops one build through the store, naming which", () => {
    const forget = vi.spyOn(store, "forgetEngine").mockResolvedValue(undefined);
    vi.spyOn(store, "engines", "get").mockReturnValue([{ ...TAGGED, versions: HELD }] as never);
    view().all<HTMLButtonElement>(".drop")[0]!.click();
    expect(forget).toHaveBeenCalledExactlyOnceWith("fallout2-ce", "2026-05-01T00:00:00Z");
  });
});

/*
  The one part of each card about the selected game. The rest of the card is the machine's and must read the same
  whichever game is selected; this line is what changes.
*/
describe("the selected game's build", () => {
  const HELD = [
    { release: "v1.4.0", published: "2026-05-01T00:00:00Z", commit: null },
    { release: "v1.3.0", published: "2026-01-01T00:00:00Z", commit: null },
  ];
  const deployed = (published: string, pinned: boolean): Record<string, InstalledEngine> => ({
    "fallout2-ce": {
      id: "fallout2-ce",
      release: published === HELD[0]!.published ? "v1.4.0" : "v1.3.0",
      published,
      complete: true,
      files: ["fallout2-ce"],
      backup: null,
      commit: null,
      pinned,
    },
  });
  const rowOf = (v: ReturnType<typeof view>, release: string) =>
    v.all(".held").find((row) => row.textContent?.trim().startsWith(release))!;
  const buttonsIn = (element: Element) => [...element.querySelectorAll("button")].map((b) => b.textContent?.trim());

  beforeEach(() => {
    vi.spyOn(store, "engines", "get").mockReturnValue([{ ...TAGGED, versions: HELD }] as never);
  });

  test("says the game has none yet, and offers every build the machine holds", () => {
    vi.spyOn(store, "engineDeployed", "get").mockReturnValue({});
    const v = view();
    expect(v.one(".this-game").textContent?.replace(/\s+/g, " ").trim()).toBe("This game none yet Follow latest");
    expect(buttonsIn(rowOf(v, "v1.4.0"))).toEqual(["Remove", "Use here"]);
    expect(buttonsIn(rowOf(v, "v1.3.0"))).toEqual(["Remove", "Use here"]);
  });

  test("names a pinned build, marks its row, and offers nothing on that row that would change nothing", () => {
    vi.spyOn(store, "engineDeployed", "get").mockReturnValue(deployed(HELD[1]!.published, true));
    const v = view();
    expect(v.one(".this-game").textContent?.replace(/\s+/g, " ").trim()).toBe("This game v1.3.0 pinned Follow latest");
    expect(rowOf(v, "v1.3.0").querySelector(".tag")?.textContent).toBe("used here");
    expect(buttonsIn(rowOf(v, "v1.3.0"))).toEqual(["Remove"]);
    expect(rowOf(v, "v1.4.0").querySelector(".tag")).toBeNull();
    expect(buttonsIn(rowOf(v, "v1.4.0"))).toEqual(["Remove", "Use here"]);
  });

  test("offers no Follow latest where the game already follows the newest build and holds it", () => {
    vi.spyOn(store, "engineDeployed", "get").mockReturnValue(deployed(HELD[0]!.published, false));
    const v = view();
    expect(v.one(".this-game").textContent?.replace(/\s+/g, " ").trim()).toBe(
      "This game v1.4.0 follows the newest build",
    );
    // The build it runs can still be pinned, and says so rather than offering to use what is already in use.
    expect(buttonsIn(rowOf(v, "v1.4.0"))).toEqual(["Remove", "Pin here"]);
  });

  // Unpinned but behind: the next run would move it, and the button does it now instead.
  test("offers Follow latest to an unpinned game behind the newest build the machine holds", () => {
    vi.spyOn(store, "engineDeployed", "get").mockReturnValue(deployed(HELD[1]!.published, false));
    expect(buttonsIn(view().one(".this-game"))).toEqual(["Follow latest"]);
  });

  test("picks a build for the game through the store, naming which", () => {
    const use = vi.spyOn(store, "useEngineBuild").mockResolvedValue(undefined);
    vi.spyOn(store, "engineDeployed", "get").mockReturnValue({});
    const v = view();
    rowOf(v, "v1.3.0").querySelector<HTMLButtonElement>(".use")!.click();
    expect(use).toHaveBeenCalledExactlyOnceWith("fallout2-ce", {
      pick: "published",
      published: "2026-01-01T00:00:00Z",
    });
  });

  test("asks for latest rather than a named build from Follow latest", () => {
    const use = vi.spyOn(store, "useEngineBuild").mockResolvedValue(undefined);
    vi.spyOn(store, "engineDeployed", "get").mockReturnValue(deployed(HELD[1]!.published, true));
    view().control("Follow latest").click();
    expect(use).toHaveBeenCalledExactlyOnceWith("fallout2-ce", { pick: "latest" });
  });

  test("says the game's build is behind what was published, as the game's and not the machine's", () => {
    vi.spyOn(store, "engineDeployed", "get").mockReturnValue(deployed(HELD[1]!.published, true));
    vi.spyOn(store, "engineLatest", "get").mockReturnValue({
      "fallout2-ce": { release: "v1.4.0", published: "2026-05-01T00:00:00Z" },
    } as never);
    // The comparison is the held state's, made against what a check found.
    vi.spyOn(store, "engineOutdated").mockReturnValue(true);
    expect(view().text()).toContain("This game runs an older build than the latest published.");
  });
});

describe("the network-bound buttons", () => {
  test("are refused in a host with no machine to reach, and say which host has one", () => {
    const v = view();
    for (const name of ["Check", "Fetch latest"]) {
      expect(v.control(name).hasAttribute("disabled"), name).toBe(true);
      expect(v.control(name).getAttribute("title"), name).toMatch(/desktop build/i);
    }
  });
});

describe("the warnings", () => {
  /* Said where it is relevant rather than done silently: it is the widest rename in the application. */
  test("warn about the lowercase rename and about installing into a running game", () => {
    const text = view().text();
    expect(text).toContain("lowercased game folder");
    expect(text).toContain("Quit the game before running or picking a different build");
  });
});
