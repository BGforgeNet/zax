/**
 * Which parts of a release an install is made of.
 *
 * A selection reaches here from the interface, from a record written by an earlier install, or from a journal
 * a retry resumes - three routes, one set of rules, so what a dialog offers and what an install carries out
 * cannot drift. Every refusal names the part in the words the manifest gave it, because the person reading it
 * chose from those words and not from ids.
 */

import { partOptions, type ModPart } from "./manifest.js";
import { offeredParts, type ModRelease } from "./mod-feed.js";

/**
 * The parts a selection names, in the order the manifest declares them, or a refusal saying why the selection
 * could not be installed. Judged against what the release actually publishes rather than against what the
 * manifest declares: a part whose asset is missing is not something an install could carry out.
 */
export function chosenParts(release: ModRelease, selection: readonly string[]): readonly ModPart[] {
  const { manifest } = release;
  const groups = offeredParts(release);
  const offered = new Map(groups.flatMap((group) => group.options).map((part) => [part.id, part]));

  const picked = new Set<string>();
  for (const id of selection) {
    const part = offered.get(id);
    if (!part) throw new Error(`The ${manifest.name} release does not offer a part called "${id}".`);
    picked.add(id);
  }
  if (picked.size === 0) throw new Error(`Nothing of ${manifest.name} is selected, so there is nothing to install.`);

  for (const group of groups) {
    const chosen = group.options.filter((part) => picked.has(part.id));
    if (group.pick === "one" && chosen.length > 1) {
      const names = chosen.map((part) => part.label).join(" and ");
      throw new Error(`Only one ${group.label} can be installed, and ${names} are both selected.`);
    }
  }

  for (const part of offered.values()) {
    if (!picked.has(part.id) || part.needs === undefined || picked.has(part.needs)) continue;
    const needed = offered.get(part.needs)?.label ?? part.needs;
    throw new Error(`${part.label} needs ${needed}, which is not selected.`);
  }

  return partOptions(manifest).filter((part) => picked.has(part.id));
}
