// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  store.engines = [TAGGED] as never;
  store.engineLatest = {};
  store.busy = null;
});
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const view = () => render(EnginesView as never, {} as never);

describe("each engine's heading", () => {
  test("names the project and links to where it is published", () => {
    const v = view();
    expect(v.one("h2").textContent).toBe(TAGGED.name);
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
    store.engines = [{ ...TAGGED, build: null, why: "Fallout II CE publishes no build for this machine." }] as never;
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
    store.engineLatest = { "fallout2-ce": { release: "v1.4.0", published: "2026-05-01T00:00:00Z" } } as never;
    expect(view().text()).toContain("v1.4.0");
  });

  test("a rolling project shows the publication date rather than its unchanging tag", () => {
    store.engines = [ROLLING] as never;
    store.engineLatest = { fission: { release: "continuous", published: "2026-05-01T00:00:00Z" } } as never;
    const text = view().text();
    expect(text).not.toContain("continuous");
    expect(text).toContain(new Date("2026-05-01T00:00:00Z").toLocaleDateString());
  });

  /* Shortened the way git does: seven characters identify the commit and a full sha reads as noise. */
  test("shows the commit a build came from, shortened", () => {
    store.engineLatest = {
      "fallout2-ce": { release: "v1.4.0", published: "2026-05-01T00:00:00Z", commit: "0123456789abcdef" },
    } as never;
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
    store.engines = [{ ...TAGGED, versions: HELD }] as never;
    const rows = view().all(".held");
    expect(rows.map((row) => row.textContent?.trim().split(/\s+/)[0])).toEqual(["v1.4.0", "v1.3.0"]);
  });

  test("drops one build through the store, naming which", () => {
    const forget = vi.spyOn(store, "forgetEngine").mockResolvedValue(undefined);
    store.engines = [{ ...TAGGED, versions: HELD }] as never;
    view().all<HTMLButtonElement>(".drop")[0]!.click();
    expect(forget).toHaveBeenCalledExactlyOnceWith("fallout2-ce", "2026-05-01T00:00:00Z");
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
    expect(text).toContain("Quit the game before running a different build");
  });
});
