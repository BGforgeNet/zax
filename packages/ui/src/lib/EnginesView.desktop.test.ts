// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import EnginesView from "./EnginesView.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The two network-bound buttons as the desktop draws them: live where the project publishes a build for this
  machine, and each asking the store about its own engine.
*/
vi.mock("./invoke.js", async (importOriginal) => ({ ...(await importOriginal<object>()), isPreview: false }));

const ENGINE = {
  id: "fallout2-ce",
  name: "Fallout II Community Edition",
  short: "CE",
  page: "https://github.com/fallout2-ce/fallout2-ce",
  releases: "tagged",
  build: { asset: "fallout2-ce-linux-x64.tar.gz", program: "fallout2-ce" },
  why: null,
  caution: null,
  versions: [],
};

beforeEach(async () => {
  await reseedPreview();
  vi.spyOn(store, "engineLatest", "get").mockReturnValue({});
});
afterEach(() => {
  unmountAll();
  store.busy = null;
  vi.restoreAllMocks();
});

describe("on the desktop", () => {
  test("Check and Fetch latest ask the store about the engine their card names", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([ENGINE] as never);
    const check = vi.spyOn(store, "checkEngine").mockResolvedValue(undefined);
    const fetch = vi.spyOn(store, "fetchEngine").mockResolvedValue(undefined);
    const view = render(EnginesView as never, {} as never);
    view.control("Check").click();
    view.control("Fetch latest").click();
    expect(check).toHaveBeenCalledExactlyOnceWith("fallout2-ce");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("fallout2-ce");
  });

  test("both are refused where the project publishes nothing this machine can run", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([
      { ...ENGINE, build: null, why: "No build for this machine." },
    ] as never);
    const view = render(EnginesView as never, {} as never);
    expect(view.control("Check").hasAttribute("disabled")).toBe(true);
    expect(view.control("Fetch latest").hasAttribute("disabled")).toBe(true);
  });

  test("while an operation runs, both are refused and say what is running", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([ENGINE] as never);
    store.busy = "Updating sfall";
    const view = render(EnginesView as never, {} as never);
    expect(view.control("Fetch latest").hasAttribute("disabled")).toBe(true);
    expect(view.control("Fetch latest").getAttribute("title")).toBe("Updating sfall is running.");
  });
});
