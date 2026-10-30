/**
 * The shared setup every test that drives the interface needs: a freshly seeded preview machine, and - for the
 * component tests - a component mounted against it.
 *
 * Extracted rather than repeated because the store is a singleton, so a test that saves leaves the next one
 * reading its output unless the machine under it is replaced. One reseed, written once, is what keeps a suite
 * of component files from each carrying its own half-correct copy of it.
 */

import { flushSync, mount, unmount, type Component } from "svelte";
import type { SettingDef } from "./bindings/SettingDef";
import { resetPreview, type PreviewMachine } from "./invoke.js";
import { ZaxPreview } from "./preview-wasm/zax_preview.js";
import { store } from "./store.svelte.js";

/** The install the preview opens on: the one with a mods folder, a record and an engine deployed. */
export const PREVIEW_INSTALL = "fixtures/f2up";

/** latin1, as every config file this application reads and writes is. */
export const bytes = (text: string) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

let machine: PreviewMachine | null = null;

/** The preview's disk, for a test that changes a file underneath the interface. */
export function disk(): PreviewMachine {
  if (machine === null) throw new Error("reseedPreview has not run, so there is no machine to reach");
  return machine;
}

/**
 * Puts a library recording this version at a path in the install, which is what ZAX reads an installed sfall or
 * hi-res patch version from. `null` takes it away.
 */
export async function plantLibrary(name: "ddraw.dll" | "f2_res.dll", version: string | null): Promise<void> {
  const at = `${PREVIEW_INSTALL}/${name}`;
  if (version === null) disk().removeFile(at);
  else disk().writeFile(at, ZaxPreview.versionedLibrary(version));
  await store.start();
}

/** A file on that disk, as latin1 text. */
export const read = (path: string): string => new TextDecoder("latin1").decode(disk().readFile(path));

/**
 * Replaces the preview machine with a freshly seeded one and starts the store over it.
 *
 * One install listed, deliberately narrower than the six a fresh preview lists: these cases are about adding,
 * refusing and relabelling, and each of them asserts against the whole list. The other directories stay on
 * the disk - the state file is what decides which are listed.
 */
export async function reseedPreview(): Promise<void> {
  machine = await resetPreview();
  machine.writeFile(
    "preview/config/zax.yml",
    bytes(`games:\n- path: ${PREVIEW_INSTALL}\ntheme: system\nautosave: false\n`),
  );
  store.view = "settings";
  store.notice = null;
  store.busy = null;
  store.modPlan = null;
  store.modParts = null;
  store.modInputs = null;
  store.modVersionPick = null;
  store.pendingLaunch = null;
  store.pendingFetch = null;
  store.sfallVersions = [];
  store.sfallVersionsRead = false;
  await store.setQuery("");
  await store.start();
}

/** A catalog setting by id, or a failure naming the id a test was written against. */
export function catalogDef(id: string): SettingDef {
  const found = store.defOf(id);
  if (!found) throw new Error(`no setting "${id}" - the id it was written against was renamed`);
  return found;
}

/** What a mounted component's test holds: where it was drawn, and the queries worth having on hand. */
export interface Mounted {
  /** The element the component was mounted into - the scope every query below is rooted at. */
  target: HTMLElement;
  /** Re-render pending reactive updates, so an assertion after an event reads the settled DOM. */
  settle(): void;
  /** The single element matching a selector, or a failure naming what was looked for. */
  one<E extends Element = HTMLElement>(selector: string): E;
  all<E extends Element = HTMLElement>(selector: string): E[];
  /** The control whose accessible name is exactly `name` - identity, not a substring match. */
  control(name: string): HTMLElement;
  /** Visible text of the whole mount, whitespace collapsed, for assertions about what a user reads. */
  text(): string;
}

const mounted: Array<() => void> = [];

/**
 * Mounts a component into its own element and answers the queries a test needs.
 *
 * Its own element rather than `document.body`, so two mounts in one file cannot see each other's DOM and a
 * selector that matches too much fails here rather than silently picking the wrong instance.
 */
export function render<P extends Record<string, unknown>>(component: Component<P>, props: P): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  // Effects do not run during `mount`; without this a component whose first paint depends on one is asserted
  // against the frame before it.
  flushSync();
  mounted.push(() => {
    // Not awaited: without `outro` the teardown is synchronous and the promise is already settled, and an
    // `afterEach` that had to await it would make every test file's cleanup asynchronous for nothing.
    void unmount(instance);
    target.remove();
  });

  const one = <E extends Element = HTMLElement>(selector: string): E => {
    const found = target.querySelectorAll<E>(selector);
    const only = found[0];
    if (found.length !== 1 || only === undefined)
      throw new Error(`${found.length} elements match "${selector}", expected exactly one`);
    return only;
  };

  return {
    target,
    settle: flushSync,
    one,
    all: <E extends Element = HTMLElement>(selector: string) => [...target.querySelectorAll<E>(selector)],
    control: (name: string) => {
      // Exact accessible name rather than a text search: "Install" as a substring matches "Install the latest
      // sfall" as readily as the button meant here. Controls inside a closed dialog are skipped: the interface
      // keeps its dialogs in the DOM at once, and the browser makes only the open one reachable.
      const candidates = [...target.querySelectorAll<HTMLElement>("button, a, input, select, [role=tab]")].filter(
        (element) =>
          element.closest("dialog:not([open])") === null &&
          (element.getAttribute("aria-label") ?? element.textContent ?? "").trim() === name,
      );
      const only = candidates[0];
      if (candidates.length !== 1 || only === undefined) {
        throw new Error(`${candidates.length} controls are named "${name}", expected exactly one`);
      }
      return only;
    },
    text: () => (target.textContent ?? "").replace(/\s+/g, " ").trim(),
  };
}

/** Unmounts everything this file mounted. Symmetric with `render`, and called from an `afterEach`. */
export function unmountAll(): void {
  for (const unmount of mounted.splice(0)) unmount();
}
