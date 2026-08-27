/**
 * What a close during a running operation asks, and what the interface's report of one is worth.
 *
 * Its own module for the reason `picker.ts` is one: `main.ts` is wiring no test reaches, and this is a decision
 * with cases. The Electron call itself stays there.
 */

/** The subset of Electron's message-box options this dialog needs. Structurally what `dialog` expects. */
export interface ClosePrompt {
  type: "warning";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

/** The answer that closes the window regardless. Anything else - Esc and the dialog's own close included - keeps it. */
export const CLOSE_ANYWAY = 1;

/**
 * How much of a label a dialog line can carry. Names arrive from the mod feeds, so both the length and any line
 * breaks in one are a release someone else wrote rather than anything from here.
 */
const LABEL_CAP = 80;

/**
 * What the interface says it is doing, made fit for a dialog: one line, bounded, and null where there is nothing
 * running. Null for a non-string too - the value crossed a process boundary, and only a string was ever sent.
 */
export function busyLabel(what: unknown): string | null {
  if (typeof what !== "string") return null;
  const line = what.replace(/\s+/g, " ").trim();
  if (line === "") return null;
  return line.length > LABEL_CAP ? `${line.slice(0, LABEL_CAP)}...` : line;
}

/**
 * The question, in terms of the operation the user started rather than of the window.
 *
 * The detail says what closing does without claiming what this particular operation would leave behind: the same
 * gate covers a version check and a mod install, and a line that described the install would be untrue of the
 * check. ZAX's part of it, because that is the part this promises: an installer ZAX started is a process of its
 * own and goes on running. Waiting is the default and the escape, since it is the answer that loses nothing.
 */
export function closePrompt(what: string): ClosePrompt {
  return {
    type: "warning",
    title: "ZAX is working",
    message: `${what} is still running.`,
    detail:
      "Closing now ends ZAX's part of it where it stands, and an operation that writes to the game folder can leave it part way through.",
    buttons: ["Keep ZAX open", "Close anyway"],
    defaultId: 0,
    cancelId: 0,
  };
}
