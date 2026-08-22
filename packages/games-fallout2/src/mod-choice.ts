/**
 * A grouped choice made before an install, and the rules a selection has to satisfy.
 *
 * Two things ask it: a release's parts, each naming its own asset, and a Windows installer's own components,
 * each naming a string that installer understands. They are different fields of different manifests and they
 * are the same question, so the rules live here once - a group that takes at most one, an option that needs
 * another, an id nothing offers - and the interface draws both from one shape.
 */

/** The least an option has to be for the rules below to judge it, and for the interface to draw it. */
export interface ChoiceOption {
  id: string;
  label: string;
  help?: string;
  /** Another option in the same choice that this one is meaningless without. */
  needs?: string;
}

export interface ChoiceGroup<T extends ChoiceOption = ChoiceOption> {
  label: string;
  pick: "one" | "any";
  options: readonly T[];
}

/**
 * The options a selection names, in the order the groups declare them, or a refusal saying why the selection
 * could not be installed. Every refusal names the option in the words the manifest gave it, because the
 * person reading it chose from those words and not from ids.
 */
export function chooseFrom<T extends ChoiceOption>(
  groups: readonly ChoiceGroup<T>[],
  selection: readonly string[],
  what: { thing: string; of: string },
): readonly T[] {
  const offered = new Map(groups.flatMap((group) => group.options).map((option) => [option.id, option]));

  const picked = new Set<string>();
  for (const id of selection) {
    if (!offered.has(id)) throw new Error(`The ${what.of} release does not offer a ${what.thing} called "${id}".`);
    picked.add(id);
  }

  for (const group of groups) {
    const chosen = group.options.filter((option) => picked.has(option.id));
    if (group.pick === "one" && chosen.length > 1) {
      const names = chosen.map((option) => option.label).join(" and ");
      throw new Error(`Only one ${group.label} can be installed, and ${names} are both selected.`);
    }
  }

  for (const option of offered.values()) {
    if (!picked.has(option.id) || option.needs === undefined || picked.has(option.needs)) continue;
    throw new Error(
      `${option.label} needs ${offered.get(option.needs)?.label ?? option.needs}, which is not selected.`,
    );
  }

  return groups.flatMap((group) => group.options).filter((option) => picked.has(option.id));
}
