// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { COMMON_RESOLUTIONS } from "@zax/fallout2";
import ResolutionPresets from "./ResolutionPresets.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  One control that writes two keys. The pair is the point: a preset that set the width and left the height alone
  would leave the game at a resolution nobody chose, and neither key on its own is a resolution.
*/

const WIDTH = "hires.MAIN.SCR_WIDTH";
const HEIGHT = "hires.MAIN.SCR_HEIGHT";
const SCALE = "hires.MAIN.SCALE_2X";

beforeEach(reseedPreview);
afterEach(unmountAll);

const draw = () => render(ResolutionPresets as never, {} as never);

const pick = (view: ReturnType<typeof draw>, value: string) => {
  const select = view.one<HTMLSelectElement>("select");
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("choosing a preset", () => {
  test("writes both keys together", () => {
    const view = draw();
    pick(view, "1920x1080");
    expect([store.valueOf(WIDTH), store.valueOf(HEIGHT)]).toEqual(["1920", "1080"]);
  });

  test("the placeholder option writes nothing", () => {
    const before = [store.valueOf(WIDTH), store.valueOf(HEIGHT)];
    const view = draw();
    pick(view, "");
    expect([store.valueOf(WIDTH), store.valueOf(HEIGHT)]).toEqual(before);
  });
});

describe("the list offered", () => {
  test("carries every common resolution, plus the placeholder", () => {
    expect(draw().all("option")).toHaveLength(COMMON_RESOLUTIONS.length + 1);
  });

  /*
    Scaling doubles the rendered size, so the smaller modes no longer fit - the previous interface shortened the
    list for exactly this reason, and offering a mode that cannot work is worse than not offering it.
  */
  test("drops the modes that cannot work once 2x scaling is on, and says why", () => {
    store.set(SCALE, "1");
    const view = draw();
    const offered = view.all("option").map((option) => option.textContent?.trim());

    expect(offered).not.toContain("800 x 600");
    expect(offered).toContain("1920 x 1080");
    expect(view.text()).toContain("Smaller modes are omitted");
  });

  test("offers the whole list again once scaling is off", () => {
    store.set(SCALE, "0");
    const view = draw();
    expect(view.all("option").map((option) => option.textContent?.trim())).toContain("800 x 600");
    expect(view.text()).not.toContain("Smaller modes are omitted");
  });
});

describe("an install without the hi-res patch's config", () => {
  test("refuses the control, following the same rule the rows do", () => {
    store.contents = { ...store.contents, "f2_res.ini": undefined };
    expect(draw().one<HTMLSelectElement>("select").disabled).toBe(true);
  });
});
