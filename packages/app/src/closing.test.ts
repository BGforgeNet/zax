import { describe, expect, it } from "vitest";
import { CLOSE_ANYWAY, busyLabel, closePrompt } from "./closing.js";

describe("busyLabel", () => {
  it("takes what the interface reported", () => {
    expect(busyLabel("Installing Restoration Project 2.3.3")).toBe("Installing Restoration Project 2.3.3");
  });

  it("reads nothing running from anything that is not a label", () => {
    // The value crossed a process boundary, where only a string and null were ever sent. A window that refuses
    // to close on one of these would be one the user cannot close at all.
    expect(busyLabel(null)).toBeNull();
    expect(busyLabel(undefined)).toBeNull();
    expect(busyLabel("")).toBeNull();
    expect(busyLabel("   ")).toBeNull();
    expect(busyLabel({ what: "Saving" })).toBeNull();
  });

  it("flattens a label to the one line a dialog gives it", () => {
    expect(busyLabel("Installing Some\nMod\t1.0")).toBe("Installing Some Mod 1.0");
  });

  it("bounds a label, since the names in one come from the feeds", () => {
    const label = busyLabel(`Installing ${"x".repeat(500)}`);
    expect(label).toHaveLength(83);
    expect(label?.endsWith("...")).toBe(true);
  });
});

describe("closePrompt", () => {
  it("asks about the operation rather than about the window", () => {
    expect(closePrompt("Installing Restoration Project 2.3.3").message).toBe(
      "Installing Restoration Project 2.3.3 is still running.",
    );
  });

  it("says what closing does without claiming what this operation would leave", () => {
    // One gate covers a version check and a mod install alike, so a detail describing the install would be
    // untrue of the check - which is the kind of warning a user learns to click past. ZAX's part of it, since
    // an installer ZAX started keeps running after the window has gone.
    expect(closePrompt("Checking for a newer ZAX").detail).toBe(
      "Closing now ends ZAX's part of it where it stands, and an operation that writes to the game folder can leave it part way through.",
    );
  });

  it("indexes the button that closes anyway, and defaults to the answer that loses nothing", () => {
    const prompt = closePrompt("Saving");
    expect(prompt.buttons[CLOSE_ANYWAY]).toBe("Close anyway");
    // Esc and the dialog's own close both answer with `cancelId`, so both have to mean "keep it open".
    expect(prompt.defaultId).toBe(0);
    expect(prompt.cancelId).toBe(0);
    expect(prompt.buttons[prompt.cancelId]).toBe("Keep ZAX open");
  });
});
