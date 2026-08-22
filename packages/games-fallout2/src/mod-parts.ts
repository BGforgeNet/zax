/**
 * Which parts of a release an install is made of.
 *
 * A selection reaches here from the interface, from a record written by an earlier install, or from a journal
 * a retry resumes - three routes, one set of rules, so what a dialog offers and what an install carries out
 * cannot drift. Every refusal names the part in the words the manifest gave it, because the person reading it
 * chose from those words and not from ids.
 */

import { partOptions, type ModPart } from "./manifest.js";
import { chooseFrom } from "./mod-choice.js";
import { offeredParts, type ModRelease } from "./mod-feed.js";

/**
 * The parts a selection names, in the order the manifest declares them, or a refusal saying why the selection
 * could not be installed. Judged against what the release actually publishes rather than against what the
 * manifest declares: a part whose asset is missing is not something an install could carry out.
 */
export function chosenParts(release: ModRelease, selection: readonly string[]): readonly ModPart[] {
  const { manifest } = release;
  // Nothing chosen is a refusal here and not in the shared rules: an installer's components may legitimately
  // come to nothing but what is required, while a mod installing none of its own parts installs nothing.
  if (selection.length === 0)
    throw new Error(`Nothing of ${manifest.name} is selected, so there is nothing to install.`);
  return chooseFrom(offeredParts(release), selection, { thing: "part", of: manifest.name });
}

/** Where an install stands in a release's choices: what to install, what went, and whether to ask. */
export interface CarriedSelection {
  /** The parts to install, in declared order - the recorded choice re-matched against this release. */
  selection: readonly string[];
  /** Recorded parts this release no longer offers. Named before the upgrade runs, never silently. */
  dropped: readonly string[];
  /** Whether the choice has to be put to the user rather than carried over. */
  ask: boolean;
}

/**
 * The recorded selection against the release now on offer, matched by id - which is what makes a part id
 * permanent: renamed, it reads here as one part removed and another added, and the user loses the choice
 * they made.
 *
 * A part the release no longer offers is dropped; one it newly offers starts off, so a mod adding a fifth
 * voice does not stop the other four upgrading quietly. The question goes back to the user when a `one`
 * group has nothing selected and something was dropped - which over-asks where the empty group was the
 * user's own doing, and asking is the safe side of that: picking for them is picking wrong as often as not.
 */
export function carryOver(release: ModRelease, recorded: readonly string[] | undefined): CarriedSelection {
  if (!release.manifest.parts) return { selection: [], dropped: [], ask: false };
  if (recorded === undefined) return { selection: [], dropped: [], ask: true };

  const groups = offeredParts(release);
  const offered = new Set(groups.flatMap((group) => group.options).map((part) => part.id));
  const kept = new Set(recorded.filter((id) => offered.has(id)));
  const dropped = recorded.filter((id) => !kept.has(id));
  const selection = partOptions(release.manifest)
    .filter((part) => kept.has(part.id))
    .map((part) => part.id);

  const emptied = groups.some((group) => group.pick === "one" && !group.options.some((option) => kept.has(option.id)));
  return { selection, dropped, ask: selection.length === 0 || (dropped.length > 0 && emptied) };
}
