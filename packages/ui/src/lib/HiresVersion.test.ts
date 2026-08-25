// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import HiresVersion from "./HiresVersion.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  Read-only, unlike the sfall block it mirrors: the patch is distributed from a forum thread rather than a
  release feed, so there is nothing to check a version against or to install from. The two states it has to
  tell apart are the patch being there and its config file being there without it - the ini survives an
  uninstall, so the file alone says nothing about whether anything reads it.
*/

beforeEach(reseedPreview);
afterEach(unmountAll);

const block = () => render(HiresVersion as never, {} as never);

describe("with the patch installed", () => {
  test("shows the version and says where it was read from", () => {
    store.hiresInstalled = "4.1.8";
    const view = block();
    expect(view.one("strong").textContent).toBe("4.1.8");
    expect(view.text()).toContain("From f2_res.dll");
  });

  test("says ZAX does not manage the patch, so nobody waits for an update button", () => {
    store.hiresInstalled = "4.1.8";
    expect(block().text()).toContain("does not install or update the patch");
  });
});

describe("with only the config file present", () => {
  test("says nothing reads these settings, rather than showing a blank version", () => {
    store.hiresInstalled = null;
    const view = block();
    expect(view.text()).toContain("not installed");
    expect(view.text()).toContain("nothing reads them without f2_res.dll");
  });
});

describe("either way", () => {
  test("offers no control at all, since there is nothing here to change", () => {
    store.hiresInstalled = "4.1.8";
    const view = block();
    expect(view.all("button")).toHaveLength(0);
    expect(view.all("input")).toHaveLength(0);
  });
});
