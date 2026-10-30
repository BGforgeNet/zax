// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import FixesPanel from "./FixesPanel.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  Actions that repair a symptom, as opposed to a setting you choose. Taken from the catalog by group rather than
  listed here, so an action added there appears without a second edit - which is the property worth pinning,
  since a hand-kept list drifts silently.
*/

beforeEach(reseedPreview);
afterEach(unmountAll);

const panel = () => render(FixesPanel as never, {} as never);

describe("the list", () => {
  test("draws one card per fix the catalog defines, and no more", () => {
    const view = panel();
    expect(view.all("article")).toHaveLength(store.actionsIn("fix").length);
  });

  test("draws only fixes, never the report actions that share the catalog", () => {
    const view = panel();
    const drawn = view.all(".name").map((name) => name.textContent);
    for (const report of store.actionsIn("report")) expect(drawn).not.toContain(report.label);
  });

  test("says each is one click, so the cards are not read as settings", () => {
    expect(panel().text()).toContain("One click each");
  });

  test("says none apply rather than drawing an empty list", () => {
    const actionsIn = store.actionsIn.bind(store);
    store.actionsIn = ((group: "report" | "fix") => (group === "fix" ? [] : actionsIn(group))) as never;
    try {
      const view = panel();
      expect(view.one("p.empty").textContent).toBe("No fixes apply to this install.");
    } finally {
      store.actionsIn = actionsIn as never;
    }
  });
});
