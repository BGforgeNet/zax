/**
 * An action is a user intention expressed as one click - "enable full debugging" rather than eleven toggles
 * across two files. Its targets are the substrate it writes to.
 */

/**
 * Where an action is offered. Declared on the action rather than listed by the panel that shows it: a panel
 * holding its own list of ids silently drops any action added afterwards, which is how one of these came to
 * exist in the catalog and appear nowhere in the interface.
 */
export type ActionGroup = "report" | "fix";

export interface Action {
  id: string;
  label: string;
  group: ActionGroup;
  /** What the user gets, in their language. Not a list of the keys involved. */
  description: string;
  /** Setting id -> the value this action writes. */
  targets: Readonly<Record<string, string>>;
  /** Button wording once every target already matches. */
  appliedLabel: string;
  /**
   * What this action leaves in the install's WINEDEBUG, for the two that are about logging. It belongs to the
   * install's own record rather than to a config file, so it is written at once where the targets stay pending.
   */
  wine?: { debug: string };
}

/**
 * `wineDebug` is the install's current value, or null on a machine with no Wine - where the field is not shown
 * and so must not decide whether an action counts as applied.
 */
const wineMatches = (action: Action, wineDebug: string | null): boolean =>
  action.wine === undefined || wineDebug === null || wineDebug === action.wine.debug;

/**
 * An action is applied when every value it would write is already in place, so the same comparison drives both
 * the button state and the "already done" wording. Deriving it from `targets` keeps the two from drifting.
 */
export function isApplied(
  action: Action,
  valueOf: (settingId: string) => string | undefined,
  wineDebug: string | null = null,
): boolean {
  return wineMatches(action, wineDebug) && Object.entries(action.targets).every(([id, want]) => valueOf(id) === want);
}

/** Targets that do not yet match, so the UI can say how much an action will change. */
export function pendingTargets(
  action: Action,
  valueOf: (settingId: string) => string | undefined,
  wineDebug: string | null = null,
): Array<{ id: string; from: string | undefined; to: string }> {
  const pending = Object.entries(action.targets)
    .filter(([id, want]) => valueOf(id) !== want)
    .map(([id, want]) => ({ id, from: valueOf(id), to: want }));
  // Named for the variable rather than a catalog id, because that is what it is: nothing looks this one up.
  if (action.wine && !wineMatches(action, wineDebug)) {
    pending.push({ id: "WINEDEBUG", from: wineDebug ?? undefined, to: action.wine.debug });
  }
  return pending;
}
