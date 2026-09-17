// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import LinkedChoices from "./LinkedChoices.svelte";
import { bytes, disk, PREVIEW_INSTALL, read, render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  A setting several components share whose value moved in more than one of them since ZAX last wrote. A link
  cannot be broken, so one of those values is about to be lost, and which one is not something ZAX can decide.
  What has to hold here: both values are offered, each named by the file it came from, and nothing is written
  until one is picked.
*/

/** Carried by the game's own sfall file and by Fission, which the seeded install has deployed. */
const BARTER = "sfall.Interface.ExpandBarter";

beforeEach(reseedPreview);
afterEach(unmountAll);

/**
 * Both engines moved off what ZAX wrote: ZAX writes 0 to both, then Fission's own screen writes 1 and sfall's
 * file is edited to 2. Reached through the files, as a user's own engines would reach it.
 */
const pose = async () => {
  disk().writeFile(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
  await store.start();
  store.set(BARTER, "0");
  await store.idle();
  await store.save();
  const ddraw = read(`${PREVIEW_INSTALL}/ddraw.ini`);
  disk().writeFile(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
  disk().writeFile(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(ddraw.replace(/ExpandBarter=0/, "ExpandBarter=2")));
  await store.start();
  return render(LinkedChoices as never, {} as never);
};

describe("nothing to decide", () => {
  test("draws nothing at all rather than an empty banner", () => {
    const view = render(LinkedChoices as never, {} as never);
    expect(view.text()).toBe("");
  });
});

describe("two values that both moved", () => {
  test("names the setting and asks which is right", async () => {
    const view = await pose();
    expect(view.text()).toContain(store.defOf(BARTER)?.label ?? BARTER);
    expect(view.text()).toContain("was changed in more than one place");
  });

  test("raises it as an alert rather than as ordinary text", async () => {
    expect((await pose()).all("[role=alert]")).toHaveLength(1);
  });

  /*
    Named by the file each came from, because that is the only thing distinguishing them - two buttons reading
    "On" and "Off" with no source would be a coin toss.
  */
  test("offers one button per value, each naming the file it came from", async () => {
    const view = await pose();
    const buttons = view.all("button").map((button) => button.textContent ?? "");
    expect(buttons).toHaveLength(2);
    expect(buttons.some((text) => text.includes("ddraw.ini"))).toBe(true);
    expect(buttons.some((text) => text.includes("fission.cfg"))).toBe(true);
  });

  test("writes nothing until one is picked", async () => {
    await pose();
    expect(read(`${PREVIEW_INSTALL}/fission.cfg`)).toContain("EnhancedBarter=1");
    expect(read(`${PREVIEW_INSTALL}/ddraw.ini`)).toContain("ExpandBarter=2");
    expect(store.isModified(BARTER)).toBe(false);
  });

  /*
    Answering leaves an ordinary pending edit rather than writing the file, so the choice can still be reverted
    before the save - and the banner goes, since the question has been answered.
  */
  test("picking one leaves it as a pending edit and takes the question away", async () => {
    const view = await pose();
    const fission = view.all("button").find((button) => button.textContent?.includes("fission.cfg"));
    fission?.click();
    await store.idle();
    view.settle();

    expect(store.valueOf(BARTER)).toBe("1");
    expect(store.isModified(BARTER)).toBe(true);
    expect(view.all("button")).toHaveLength(0);
  });
});
