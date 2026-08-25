// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SETTINGS } from "@zax/fallout2";
import LinkedChoices from "./LinkedChoices.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  A setting several components share whose value moved in more than one of them since ZAX last wrote. A link
  cannot be broken, so one of those values is about to be lost, and which one is not something ZAX can decide.
  What has to hold here: both values are offered, each named by the file it came from, and nothing is written
  until one is picked.
*/

/** A catalog row with two addresses, which is what a divergence is about. */
const linked = SETTINGS.find((setting) => setting.targets.length > 1);
if (!linked) throw new Error("the catalog no longer carries a setting with more than one address");

const [first, second] = [linked.targets[0]!, linked.targets[1]!];

beforeEach(async () => {
  await reseedPreview();
  store.settingsChoices = [];
});
afterEach(unmountAll);

const pose = (values: [string, string]) => {
  // Both addresses took part and both moved, which is exactly the shape reconciliation hands over here.
  const moved = [
    { target: first, value: values[0] },
    { target: second, value: values[1] },
  ];
  store.settingsChoices = [{ id: linked.id, at: moved, choose: moved }];
  return render(LinkedChoices as never, {} as never);
};

describe("nothing to decide", () => {
  test("draws nothing at all rather than an empty banner", () => {
    const view = render(LinkedChoices as never, {} as never);
    expect(view.text()).toBe("");
  });
});

describe("two values that both moved", () => {
  test("names the setting and asks which is right", () => {
    const view = pose(["0", "1"]);
    expect(view.text()).toContain(linked.label);
    expect(view.text()).toContain("was changed in more than one place");
  });

  test("raises it as an alert rather than as ordinary text", () => {
    expect(pose(["0", "1"]).all("[role=alert]")).toHaveLength(1);
  });

  /*
    Named by the file each came from, because that is the only thing distinguishing them - two buttons reading
    "On" and "Off" with no source would be a coin toss.
  */
  test("offers one button per value, each naming the file it came from", () => {
    const view = pose(["0", "1"]);
    const buttons = view.all("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toContain(first.file);
    expect(buttons[1]!.textContent).toContain(second.file);
  });

  test("writes nothing until one is picked", () => {
    const before = store.valueOf(linked.id);
    pose(["0", "1"]);
    expect(store.valueOf(linked.id)).toBe(before);
  });

  /*
    Answering leaves an ordinary pending edit rather than writing the file, so the choice can still be reverted
    before the save - and the banner goes, since the question has been answered.
  */
  test("picking one leaves it as a pending edit and takes the question away", () => {
    const view = pose(["0", "1"]);
    view.all("button")[1]!.click();
    view.settle();

    expect(store.valueOf(linked.id)).toBe("1");
    expect(store.isModified(linked.id)).toBe(true);
    expect(view.all("button")).toHaveLength(0);
  });
});
