/**
 * Where mods belong in `mods_order.txt`, as far as ZAX is prepared to say.
 *
 * The orders ship in code for the same reason the feed list does: they are a judgement ZAX makes on the
 * user's behalf, so they are reviewable and change only with a release. A mod earns a line when where it
 * belongs is actually stated somewhere - not inferred from what it looks like. Everything else stays
 * unranked, which is the honest answer for most of a mods folder and keeps the interface from telling
 * someone their working order is wrong.
 *
 * Nothing here moves a file on its own. The advice is shown, the sort is a button, and both land in the same
 * unsaved-then-save flow a manual reorder does.
 */

import type { GameType } from "@zax/core";
import type { Mod, OrderClaim } from "./mods.js";

/**
 * The Restoration Project Updated's own shipped order (`release/mods_order.txt` in
 * BGforgeNet/Fallout2_Restoration_Project), earliest-loading first - a mod further down overrides one above
 * it, so the last line wins.
 *
 * It is not a list of RPU's own files: `rpu.dat` is RPU and the `rpu_*` lines are its components, but the
 * rest name separate mods whose place RPU states rather than owns.
 */
export const RPU_ORDER: readonly string[] = [
  "rpu.dat",
  "party_orders.dat",
  "npc_armor.dat",
  "rpu_czech.dat",
  "rpu_french.dat",
  "rpu_german.dat",
  "rpu_hungarian.dat",
  "rpu_italian.dat",
  "rpu_polish.dat",
  "rpu_portuguese.dat",
  "rpu_russian.dat",
  "upu_russian_sound.dat",
  "rpu_spanish.dat",
  "rpu_enhanced_worldmap.dat",
  "rpu_extended_flamer.dat",
  "rpu_rifle_animations.dat",
  "rpu_wakizashi_animations.dat",
  "cassidy_head.dat",
  "cassidy_voice_joey_bracken_hq.dat",
  "rpu_improved_mysterious_stranger.dat",
  "walk_speed_fix_low_fps.dat",
  "goris_fast_derobing_low_fps.dat",
  "fo2tweaks.dat",
  "InventoryFilter.dat",
];

/**
 * The Unofficial Patch Updated's own (`release/mods_order.txt` in BGforgeNet/Fallout2_Unofficial_Patch):
 * the same list with `upu.dat` and the `upu_*` translations where RPU carries its own. The two installs are
 * exclusive, so no folder is ever judged against both.
 */
export const UPU_ORDER: readonly string[] = [
  "upu.dat",
  "party_orders.dat",
  "npc_armor.dat",
  "upu_czech.dat",
  "upu_french.dat",
  "upu_german.dat",
  "upu_hungarian.dat",
  "upu_italian.dat",
  "upu_polish.dat",
  "upu_portuguese.dat",
  "upu_russian.dat",
  "upu_spanish.dat",
  "upu_russian_sound.dat",
  "rpu_enhanced_worldmap.dat",
  "rpu_extended_flamer.dat",
  "rpu_rifle_animations.dat",
  "rpu_wakizashi_animations.dat",
  "cassidy_head.dat",
  "cassidy_voice_joey_bracken_hq.dat",
  "rpu_improved_mysterious_stranger.dat",
  "walk_speed_fix_low_fps.dat",
  "goris_fast_derobing_low_fps.dat",
  "fo2tweaks.dat",
  "InventoryFilter.dat",
];

const fold = (name: string) => name.toLowerCase();

/**
 * What an install neither project speaks for gets: the mods both of them place, in the order both give them.
 * Neither file was written for a vanilla or a killap-patched install, but where two independently maintained
 * orders agree about a third party's mod, that agreement is as good a statement of its place as exists.
 *
 * Computed rather than written out, so it shrinks by itself the day one project moves an entry - which the
 * order's own test asserts, since a disagreement would otherwise be settled silently in RPU's favour.
 */
export const SHARED_ORDER: readonly string[] = RPU_ORDER.filter((name) =>
  UPU_ORDER.some((other) => fold(other) === fold(name)),
);

/**
 * The order an install is judged against. The two Updated projects each state their own; every other type
 * falls back to what they agree on, and no type is judged against a project it is not.
 */
export function recommendationFor(type: GameType): readonly string[] {
  if (type === "fallout2rpu") return RPU_ORDER;
  if (type === "fallout2upu") return UPU_ORDER;
  return SHARED_ORDER;
}

/** Where the order puts an entry, or null for one it does not name. */
export function rankOf(name: string, order: readonly string[]): number | null {
  const at = order.findIndex((named) => fold(named) === fold(name));
  return at === -1 ? null : at;
}

/**
 * Where a claim's entry belongs in an order, or null while the order names nothing it hangs off.
 *
 * As late as the claim allows, for the reason `placeFor` puts a new line as late as the order allows: the
 * entries either side of it are the whole of what has been stated, and the space between them is not
 * something to have an opinion about. A claim whose two sides cross - after something the order puts below
 * what it must precede - states a place that does not exist, and goes back to having no place rather than
 * being resolved in one side's favour.
 */
function placementIn(order: readonly string[], claim: OrderClaim): number | null {
  const ranks = (names: readonly string[]) =>
    names.map((name) => rankOf(name, order)).filter((rank): rank is number => rank !== null);
  const below = ranks(claim.after);
  const above = ranks(claim.before);
  if (below.length === 0 && above.length === 0) return null;
  const earliest = below.length === 0 ? 0 : Math.max(...below) + 1;
  const latest = above.length === 0 ? order.length : Math.min(...above);
  return earliest <= latest ? latest : null;
}

/**
 * The order with the mods that state their own place put into it - what the recommendation becomes for an
 * install whose mods describe themselves.
 *
 * The shipped order wins where it names the entry already: RPU's own file is a statement about an RPU
 * install, made by the project the install is, and a third party's claim about where it sits does not
 * override that. Everything else is placed against what the order names, repeatedly, so a mod may state its
 * place beside another mod that stated its own - and a claim that never resolves, because what it names is
 * absent or because two of them wait on each other, leaves its entry unranked, which is what every entry
 * nobody has spoken for already gets.
 */
export function orderWith(base: readonly string[], claims: readonly OrderClaim[]): readonly string[] {
  const out = [...base];
  let pending = claims.flatMap((claim) => claim.entries.map((entry) => ({ ...claim, entry })));
  while (pending.length > 0) {
    const unresolved: typeof pending = [];
    for (const claim of pending) {
      if (rankOf(claim.entry, out) !== null) continue;
      const at = placementIn(out, claim);
      if (at === null) unresolved.push(claim);
      else out.splice(at, 0, claim.entry);
    }
    if (unresolved.length === pending.length) break;
    pending = unresolved;
  }
  return out;
}

/**
 * The same list with the mods the order names put in its order, and every other entry left exactly where it
 * was. Only the known ones move, and only into the places they already occupied between them: ZAX has no
 * opinion about where an unranked mod sits, and shuffling one to make room would be acting on an opinion it
 * does not have.
 */
export function recommendedOrder(mods: readonly Mod[], order: readonly string[]): readonly Mod[] {
  const ranked = mods.map((mod, at) => ({ mod, at, rank: rankOf(mod.name, order) }));
  const known = ranked.filter((item): item is { mod: Mod; at: number; rank: number } => item.rank !== null);
  const sorted = known.toSorted((a, b) => a.rank - b.rank);
  const out = [...mods];
  known.forEach((item, i) => (out[item.at] = sorted[i]!.mod));
  return out;
}

/** The entries a sort would move, in the order they sit now. Empty when the file already follows the order. */
export function againstRecommendation(mods: readonly Mod[], order: readonly string[]): readonly string[] {
  const sorted = recommendedOrder(mods, order);
  return mods.filter((mod, at) => sorted[at] !== mod).map((mod) => mod.name);
}

/**
 * Where a newly installed entry goes: as late as the order allows, which is just above the first mod loaded
 * after this one, and the end of the file when it names none of them.
 *
 * As late as possible rather than as early: the end is where an install has always put a new dat, and every
 * entry the order says nothing about is one ZAX has no grounds to load a new mod under. So the placement
 * only ever pulls a mod up off the end, and only past a mod the recommendation actually names.
 */
export function placeFor(mods: readonly Mod[], name: string, order: readonly string[]): number {
  const rank = rankOf(name, order);
  if (rank === null) return mods.length;
  const at = mods.findIndex((mod) => {
    const other = rankOf(mod.name, order);
    return other !== null && other > rank;
  });
  return at === -1 ? mods.length : at;
}
