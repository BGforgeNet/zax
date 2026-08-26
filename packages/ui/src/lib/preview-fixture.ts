/**
 * The shared setup every test that drives the interface needs: the preview disk put back the way it was
 * seeded, and - for the component tests - a component mounted against it.
 *
 * Extracted rather than repeated because the store is a singleton over a mutable in-memory disk, so a test
 * that saves leaves the next one reading its output. One reseed, written once, is what keeps a suite of
 * component files from each carrying its own half-correct copy of it.
 */

import { flushSync, mount, unmount, type Component } from "svelte";
import { ENGINE_CONFIG_FILES } from "@zax/fallout2";
import { PREVIEW_INSTALL, previewPlatform } from "./host.js";
import { store } from "./store.svelte.js";
import fallout2cfg from "../../../../fixtures/f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/f2up/ddraw.ini?raw";

/** Re-exported so a test names the install it drives through the same module it gets its setup from. */
export { PREVIEW_INSTALL } from "./host.js";

/** latin1, as every config file this application reads and writes is. */
export const bytes = (text: string) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

/** The two mod files a test mutates, named here so a test asserting on one reaches it through the same path. */
export const ORDER_FILE = `${PREVIEW_INSTALL}/mods/mods_order.txt`;
export const MOD_INI = `${PREVIEW_INSTALL}/mods/fo2tweaks.ini`;

/** Captured on the first run, before any test has written to them, so the seed is not repeated here to drift. */
let seededOrder: Uint8Array | null = null;
let seededModIni: Uint8Array | null = null;

/**
 * Puts the preview disk back to its seeded state and reloads the store from it.
 *
 * Without this the gate and conflict cases run against an empty baseline, where every value reads as absent -
 * and they pass, because "absent" is also what a closed gate looks like.
 */
export async function reseedPreview(): Promise<void> {
  // One install, deliberately narrower than the six a fresh preview lists: these cases are about adding,
  // refusing and relabelling, and each of them asserts against the whole list. The other five directories stay
  // on the disk - the state file is what decides which are listed, so they are inert until something adds them.
  const seeded = `games:\n- path: ${PREVIEW_INSTALL}\ntheme: system\n`;
  await previewPlatform.fs.write("preview/config/zax.yml", new TextEncoder().encode(seeded));
  // The config files too: a test that saves rewrites them, and the next test would inherit that.
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fallout2.cfg`, bytes(fallout2cfg));
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/f2_res.ini`, bytes(f2resini));
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(ddrawini));
  // And an engine's own config goes, so a test that writes one does not leave the next install looking like
  // one an engine has already run in. Reseeding fallout2.cfg clears fallout2-ce's mark with it.
  for (const name of ENGINE_CONFIG_FILES) await previewPlatform.fs.remove(`${PREVIEW_INSTALL}/${name}`);
  seededOrder ??= await previewPlatform.fs.read(ORDER_FILE);
  await previewPlatform.fs.write(ORDER_FILE, seededOrder);
  seededModIni ??= await previewPlatform.fs.read(MOD_INI);
  await previewPlatform.fs.write(MOD_INI, seededModIni);
  await store.start();
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
    if (found.length !== 1) throw new Error(`${found.length} elements match "${selector}", expected exactly one`);
    return found[0]!;
  };

  return {
    target,
    settle: flushSync,
    one,
    all: <E extends Element = HTMLElement>(selector: string) => [...target.querySelectorAll<E>(selector)],
    control: (name: string) => {
      // Exact accessible name rather than a text search: `testing.md` wants a control driven by identity, and
      // "Install" as a substring matches "Install the latest sfall" as readily as the button meant here.
      // Controls inside a closed dialog are skipped: the interface keeps all four in the DOM at once, and the
      // browser makes only the open one reachable, so counting the others would find duplicates a user cannot
      // press.
      const candidates = [...target.querySelectorAll<HTMLElement>("button, a, input, select, [role=tab]")].filter(
        (element) =>
          element.closest("dialog:not([open])") === null &&
          (element.getAttribute("aria-label") ?? element.textContent ?? "").trim() === name,
      );
      if (candidates.length !== 1) {
        throw new Error(`${candidates.length} controls are named "${name}", expected exactly one`);
      }
      return candidates[0]!;
    },
    text: () => (target.textContent ?? "").replace(/\s+/g, " ").trim(),
  };
}

/** Unmounts everything this file mounted. Symmetric with `render`, and called from an `afterEach`. */
export function unmountAll(): void {
  while (mounted.length > 0) mounted.pop()!();
}
