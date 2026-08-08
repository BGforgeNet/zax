/**
 * An action is a user intention expressed as one click - "enable full debugging" rather than eleven toggles
 * across two files. Its targets are the substrate it
 * writes to.
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
}

/**
 * An action is applied when every value it would write is already in place, so the same comparison drives both
 * the button state and the "already done" wording. Deriving it from `targets` keeps the two from drifting.
 */
export function isApplied(action: Action, valueOf: (settingId: string) => string | undefined): boolean {
  return Object.entries(action.targets).every(([id, want]) => valueOf(id) === want);
}

/** Targets that do not yet match, so the UI can say how much an action will change. */
export function pendingTargets(
  action: Action,
  valueOf: (settingId: string) => string | undefined,
): Array<{ id: string; from: string | undefined; to: string }> {
  return Object.entries(action.targets)
    .filter(([id, want]) => valueOf(id) !== want)
    .map(([id, want]) => ({ id, from: valueOf(id), to: want }));
}
