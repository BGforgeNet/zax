// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import Dialog from "./Dialog.svelte";
import { render, unmountAll } from "./preview-fixture.js";

afterEach(unmountAll);

/** A snippet is what a caller passes as `children`; these stand in for one without needing a wrapper component. */
const snippet = (html: string) =>
  ((anchor: Node) => {
    const node = document.createElement("span");
    node.innerHTML = html;
    anchor.parentNode?.insertBefore(node, anchor);
  }) as never;

const open = (props: Record<string, unknown> = {}) =>
  render(
    Dialog as never,
    {
      open: true,
      title: "Pick a version",
      dismiss: () => {},
      children: snippet("<p>body text</p>"),
      ...props,
    } as never,
  );

describe("the one modal", () => {
  test("draws its title and its caller's content", () => {
    const view = open();
    expect(view.one("h2").textContent).toBe("Pick a version");
    expect(view.text()).toContain("body text");
  });

  test("renders no footer region when the caller passes no footer", () => {
    expect(open().all(".foot")).toHaveLength(0);
  });

  test("renders the footer region when the caller passes one", () => {
    const view = open({ footer: snippet("<button>Install</button>") });
    expect(view.all(".foot")).toHaveLength(1);
    expect(view.control("Install").tagName).toBe("BUTTON");
  });

  /*
    Every way out goes through the caller's `dismiss` rather than closing the element, because the caller's flag
    is the single source of truth for whether the dialog is open. A route that closed the element directly would
    leave that flag set, and the dialog would refuse to reopen.
  */
  test("the close button dismisses", () => {
    const dismiss = vi.fn();
    const view = open({ dismiss });
    view.control("Close").click();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test("a click on the backdrop dismisses, and one on the contents does not", () => {
    const dismiss = vi.fn();
    const view = open({ dismiss });

    view.one("p").click();
    expect(dismiss).not.toHaveBeenCalled();

    view.one("dialog").click();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  test("Escape dismisses rather than closing the element behind the caller's back", () => {
    const dismiss = vi.fn();
    const view = open({ dismiss });
    const element = view.one<HTMLDialogElement>("dialog");

    const cancel = new Event("cancel", { cancelable: true });
    element.dispatchEvent(cancel);

    expect(dismiss).toHaveBeenCalledOnce();
    expect(cancel.defaultPrevented).toBe(true);
  });
});
