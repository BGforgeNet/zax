/**
 * Settling a setting several engines carry when their files have come to disagree.
 *
 * ZAX writes one value to every live address at once, so two addresses only ever differ because something
 * else changed one - the engine's own preferences screen, or a hand edit. Which side moved is answered by the
 * base: the value ZAX itself last wrote there, kept in the install's record. Without one the only available
 * rule is to prefer the setting's own address, which is right the first time and wrong afterwards, since it
 * would revert whatever the user had just changed inside the engine.
 *
 * A base is also what accepting a disagreement records. Reverting a carry is the user saying these engines
 * may differ, and nothing on disk changes when they do - so without somewhere to put that answer the next
 * load reads the same files against the same bases and asks again, forever.
 */

import { IniDocument, type ConfigFileContents, type SettingDef, type SettingTarget } from "@zax/core";
import { liveTargets } from "./engine-config.js";

/** How a base is keyed. Unique across the catalog, which `catalog.test.ts` asserts from the other side. */
export const addressOf = (at: { file: string; section: string; key: string }): string =>
  `${at.file}|${at.section}|${at.key}`;

/** One address taking part, and what it now says. */
export interface HeldTarget {
  target: SettingTarget;
  value: string;
}

/**
 * One linked setting whose addresses do not agree, and what needs doing about it. At most one of `settle`
 * and `choose` is set: neither, where the disagreement has already been accepted and there is nothing left
 * to do - it is still reported, because a caller has to know these addresses differ whether or not it is
 * being asked to act on them.
 */
export interface Divergence {
  id: string;
  /**
   * Every address taking part, as it now reads. What accepting the disagreement records as the new base:
   * the caller holds no other view of which addresses were weighed, and re-deriving them from the files a
   * second time is a second answer to the same question.
   */
  at: readonly HeldTarget[];
  /**
   * The value that survives and where it came from. It is by definition a value ZAX did not write, so the
   * interface says where it came from rather than propagating it silently.
   */
  settle?: HeldTarget;
  /** Two addresses moved since ZAX wrote, so which value survives is the user's to choose, not ZAX's. */
  choose?: readonly HeldTarget[];
}

/**
 * What every linked setting in this install needs, read off the files as they are now.
 *
 * An address holding no value at all takes no part. A key a file does not carry means that component's own
 * default rather than a value, so it cannot disagree with anything - and filling it in from a partner would
 * change what the component does, unasked, on a load the user only meant as a load.
 */
export function reconcileSettings(
  settings: readonly SettingDef[],
  contents: ConfigFileContents,
  written: Readonly<Record<string, string>>,
): readonly Divergence[] {
  const documents = new Map<string, IniDocument | undefined>();
  const held = (target: SettingTarget): string | undefined => {
    if (!documents.has(target.file)) {
      const text = contents[target.file];
      documents.set(target.file, text === undefined ? undefined : IniDocument.parse(text));
    }
    return documents.get(target.file)?.get(target.section, target.key);
  };

  const out: Divergence[] = [];
  for (const def of settings) {
    if (def.targets.length < 2) continue;
    const stated = liveTargets(def, contents)
      .map((target) => ({ target, value: held(target) }))
      .filter((one): one is HeldTarget => one.value !== undefined);
    if (stated.length < 2) continue;
    if (new Set(stated.map((one) => one.value)).size === 1) continue;

    // An address ZAX has never written cannot have moved: it holds whatever put it there, which is what a
    // newly installed engine's own first run leaves behind.
    const moved = stated.filter((one) => {
      const base = written[addressOf(one.target)];
      return base !== undefined && one.value !== base;
    });
    if (moved.length === 0) {
      // Every address holding a base holds exactly what ZAX left there. Where that is all of them, the
      // disagreement is one ZAX has already been told about and had accepted - reverting the carry is what
      // records it - so asking again is the loop that acceptance exists to end. Reported all the same: the
      // addresses still differ, and an edit to this setting still has to reach the ones that lag.
      if (stated.every((one) => written[addressOf(one.target)] !== undefined)) {
        out.push({ id: def.id, at: stated });
        continue;
      }
      // Otherwise nothing here says which side is the newer intention. The setting's own address wins:
      // `ddraw.ini` and `f2_res.ini` hold only what a person put there, while an engine writes a value for
      // every key it knows the first time it runs.
      out.push({ id: def.id, at: stated, settle: stated[0]! });
      continue;
    }
    const agreed = new Set(moved.map((one) => one.value));
    out.push(
      agreed.size === 1 ? { id: def.id, at: stated, settle: moved[0]! } : { id: def.id, at: stated, choose: moved },
    );
  }
  return out;
}
