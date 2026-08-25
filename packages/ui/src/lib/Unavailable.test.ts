// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Unavailable from "./Unavailable.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  A tab whose settings cannot be edited keeps them on screen and says why - the previous interface disabled the
  whole tab, which said it was unavailable but not the reason. So the thing to pin is that each file gets its
  own explanation rather than a shared one, and that only the file with something to install offers a button.
*/

beforeEach(reseedPreview);
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const draw = (props: { file?: string; reason?: string }) => render(Unavailable as never, props as never);

describe("what it says is missing", () => {
  test("names sfall for its own file", () => {
    expect(draw({ file: "ddraw.ini" }).text()).toContain("sfall is not installed");
  });

  test("explains that the game writes its own config on first run", () => {
    expect(draw({ file: "fallout2.cfg" }).text()).toContain("first time it runs");
  });

  test("falls back to a general reason for a file it has no wording for", () => {
    expect(draw({ file: "fission.cfg" }).text()).toContain("not in the game folder");
  });

  test("prefers a reason the caller supplies, which knows more than the filename does", () => {
    const view = draw({ file: "ddraw.ini", reason: "Fallout Fission has not written its settings yet." });
    expect(view.text()).toContain("Fallout Fission has not written its settings yet.");
    expect(view.text()).not.toContain("sfall is not installed");
  });

  /*
    The patch's own library is what says whether it is there, so a missing f2_res.ini beside an installed patch
    is a different situation from one missing because nothing installed it - and the two need different wording,
    since only one of them is fixed by installing anything.
  */
  test("distinguishes an installed hi-res patch missing its config from one that was never installed", () => {
    store.hiresInstalled = null;
    expect(draw({ file: "f2_res.ini" }).text()).toContain("is not installed");
    unmountAll();

    store.hiresInstalled = "4.1.8";
    const view = draw({ file: "f2_res.ini" });
    expect(view.text()).toContain("4.1.8 is installed");
    expect(view.text()).toContain("not in the game folder");
  });
});

describe("the install affordance", () => {
  /*
    Only sfall is offered for installation. The hi-res patch is distributed from a forum thread rather than a
    release feed, so there is nothing to install it from - and a button that could not work is worse than none.
  */
  test("is offered for sfall and for nothing else", () => {
    expect(draw({ file: "ddraw.ini" }).all("button")).toHaveLength(1);
    unmountAll();
    expect(draw({ file: "f2_res.ini" }).all("button")).toHaveLength(0);
    unmountAll();
    expect(draw({ file: "fallout2.cfg" }).all("button")).toHaveLength(0);
  });

  test("is refused in a host with no machine to reach, and the title says so", () => {
    const button = draw({ file: "ddraw.ini" }).one("button");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toMatch(/desktop build/i);
  });

  test("reports the install while it runs", () => {
    store.busy = "Installing sfall";
    expect(draw({ file: "ddraw.ini" }).text()).toContain("Installing...");
    store.busy = null;
  });

  test("carries the status role, so the explanation is announced rather than only drawn", () => {
    expect(draw({ file: "ddraw.ini" }).one("[role=status]")).toBeTruthy();
  });
});
