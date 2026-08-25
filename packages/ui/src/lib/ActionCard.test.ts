// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ACTIONS } from "@zax/fallout2";
import ActionCard from "./ActionCard.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  A one-click fix, drawn as a card. It writes several keys at once, which is the whole reason it exists as one
  button rather than as the settings it happens to touch - so what has to hold is that the click writes all of
  them, and that the card then reports itself applied instead of offering the same click again.
*/

/*
  One that writes config keys and nothing else. The two logging actions also set the install's WINEDEBUG, which
  is written to the record rather than left pending - a different path, and not the one this card is about.
*/
const action = ACTIONS.find((one) => one.wine === undefined);
if (!action) throw new Error("every action now carries a Wine side; this file needs one that does not");

beforeEach(reseedPreview);
afterEach(unmountAll);

const card = () => render(ActionCard as never, { action } as never);

describe("an action that has not been applied", () => {
  test("names itself and says what it does", () => {
    const view = card();
    expect(view.one(".name").textContent).toBe(action.label);
    expect(view.one(".desc").textContent).toBe(action.description);
  });

  test("offers the click, and counts the keys still to write", () => {
    const view = card();
    expect(view.all("button")).toHaveLength(1);
    expect(Number(view.one(".count").textContent)).toBeGreaterThan(0);
  });

  /*
    Every key at once. An action that wrote some of them would leave the install in a state the user never asked
    for and the card would go on reading as unapplied, which is the shape of a fix that silently does nothing.
  */
  test("writes every one of its keys on a single click", () => {
    const view = card();
    view.control("Apply").click();
    view.settle();

    for (const [id, value] of Object.entries(action.targets)) expect(store.valueOf(id), id).toBe(value);
  });
});

describe("an action already applied", () => {
  test("says so instead of offering the click again", () => {
    const view = card();
    view.control("Apply").click();
    view.settle();

    expect(view.all("button")).toHaveLength(0);
    expect(view.one(".done").textContent).toBe(action.appliedLabel);
    expect(view.one("article").classList.contains("applied")).toBe(true);
  });
});
