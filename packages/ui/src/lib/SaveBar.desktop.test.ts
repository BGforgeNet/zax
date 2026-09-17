// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import SaveBar from "./SaveBar.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The run buttons as the desktop draws them, live: what is under test is which engine and which build each one
  asks the store to start, since the preview refuses to start anything at all.
*/
vi.mock("./invoke.js", async (importOriginal) => ({ ...(await importOriginal<object>()), isPreview: false }));

beforeEach(reseedPreview);
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const CE = {
  id: "fallout2-ce",
  name: "Fallout II Community Edition",
  short: "CE",
  releases: "rolling",
  versions: [
    { release: "continious", published: "2026-08-23T09:37:22Z", commit: null },
    { release: "continious", published: "2026-07-01T00:00:00Z", commit: null },
  ],
};

describe("on the desktop", () => {
  test("Run starts the game's own executable", () => {
    const play = vi.spyOn(store, "play").mockResolvedValue(undefined);
    render(SaveBar as never, {} as never)
      .control("Run")
      .click();
    expect(play).toHaveBeenCalledExactlyOnceWith();
  });

  test("an engine's Run starts whatever build that folder is set to", () => {
    const play = vi.spyOn(store, "play").mockResolvedValue(undefined);
    vi.spyOn(store, "engines", "get").mockReturnValue([CE] as never);
    render(SaveBar as never, {} as never)
      .control("Run in CE")
      .click();
    expect(play).toHaveBeenCalledExactlyOnceWith("fallout2-ce", null);
  });

  test("the chooser starts the latest, or the one build picked, and closes behind it", () => {
    const play = vi.spyOn(store, "play").mockResolvedValue(undefined);
    vi.spyOn(store, "engines", "get").mockReturnValue([CE] as never);
    const view = render(SaveBar as never, {} as never);

    view.control("Choose a CE build").click();
    view.settle();
    view.control("Latest").click();
    view.settle();
    expect(play).toHaveBeenLastCalledWith("fallout2-ce", { pick: "latest" });
    expect(view.all('[role="menu"]')).toHaveLength(0);

    view.control("Choose a CE build").click();
    view.settle();
    view.control(new Date("2026-07-01T00:00:00Z").toLocaleDateString()).click();
    expect(play).toHaveBeenLastCalledWith("fallout2-ce", { pick: "published", published: "2026-07-01T00:00:00Z" });
  });

  test("a build whose date cannot be read is shown as it was published rather than as an invalid date", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([
      { ...CE, versions: [...CE.versions, { release: "continious", published: "unknown", commit: null }] },
    ] as never);
    const view = render(SaveBar as never, {} as never);
    view.control("Choose a CE build").click();
    view.settle();
    expect(view.control("unknown").getAttribute("role")).toBe("menuitem");
  });
});
