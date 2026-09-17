import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppView } from "./bindings/AppView";
import type { DebugPackage } from "./bindings/DebugPackage";
import type { EngineListing } from "./bindings/EngineListing";
import type { ModOffer } from "./bindings/ModOffer";
import type { SfallUpdate } from "./bindings/SfallUpdate";
import { commands } from "./commands.js";
import { bytes, disk, PREVIEW_INSTALL, read, reseedPreview } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  What the store decides for itself. The settings, the mod order and the list of installs are held and ruled on
  the other side of the command boundary, and tested there; what is left here is how answers are laid over the
  view, the order edits go out in, when an autosave writes, the gate that keeps two operations apart, the
  dialogs a flow opens before anything runs, and the sentences an outcome is reported in.
*/

const MUSIC = "game.sound.music";

beforeEach(reseedPreview);
afterEach(() => {
  store.busy = null;
  store.progress = null;
  store.cancelling = false;
  vi.restoreAllMocks();
});

const flipped = () => (store.valueOf(MUSIC) === "1" ? "0" : "1");

describe("laying answers over the view", () => {
  /*
    An answer can arrive after a newer one: two quick clicks send two commands, and nothing orders the replies.
    The slower one landing last would put a state nobody is in back on screen.
  */
  test("drops an answer older than the view it would replace", async () => {
    const wanted = flipped();
    const stale = await commands.view();
    store.set(MUSIC, wanted);
    await store.idle();
    expect(store.valueOf(MUSIC)).toBe(wanted);

    const setSettings = vi.spyOn(commands, "setSettings").mockResolvedValue(stale);
    store.set(MUSIC, wanted);
    await store.idle();
    expect(setSettings).toHaveBeenCalled();
    expect(store.valueOf(MUSIC), "the older view did not replace the newer one").toBe(wanted);
  });

  /*
    Rows arrive as changes against a view. Laid over a different one they would show rows from two states, so
    the store asks for the whole view instead - which is what makes a dropped answer safe to drop.
  */
  test("asks for the whole view when the rows it was sent are changes against a view it does not hold", async () => {
    const wanted = flipped();
    // Answered and never shown: the next patch is based on this revision, which the store never saw.
    await commands.setSettings([{ id: MUSIC, to: { raw: wanted } }]);
    const whole = vi.spyOn(commands, "view");
    store.set(MUSIC, wanted === "1" ? "0" : "1");
    await store.idle();
    expect(whole).toHaveBeenCalled();
    expect(store.valueOf(MUSIC)).toBe(wanted === "1" ? "0" : "1");
  });
});

describe("edits", () => {
  /*
    A field someone is typing into must not be overwritten by the answer to the keystroke before last, so what a
    control shows is the latest edit until a view carries it.
  */
  test("shows an edit the moment it is made, before any answer has arrived", () => {
    const wanted = flipped();
    store.set(MUSIC, wanted);
    expect(store.valueOf(MUSIC)).toBe(wanted);
  });

  /* A slider drag is a stream of edits, and only where it was let go matters. */
  test("sends what piled up while an answer was on its way as one request, the latest value only", async () => {
    const sent = vi.spyOn(commands, "setSettings");
    store.set(MUSIC, "0");
    store.set(MUSIC, "1");
    store.set(MUSIC, "0");
    await store.idle();
    const edits = sent.mock.calls.flatMap(([batch]) => batch).filter((one) => one.id === MUSIC);
    expect(edits.at(-1)?.to).toEqual({ raw: "0" });
    expect(store.valueOf(MUSIC)).toBe("0");
    expect(sent.mock.calls.length, "not one request per edit").toBeLessThan(3);
  });

  test("says why an edit was refused, and shows the view as it stands after", async () => {
    vi.spyOn(commands, "setSettings").mockRejectedValue(new Error("the file is read-only"));
    const before = store.valueOf(MUSIC);
    store.set(MUSIC, flipped());
    await store.idle();
    expect(store.notice).toEqual({ kind: "problem", text: "the file is read-only" });
    expect(store.valueOf(MUSIC)).toBe(before);
  });
});

describe("autosave", () => {
  // Where a write is expected, wait for the write rather than for a span: a fixed sleep passes or fails on how
  // loaded the machine is.
  const saved = async () => expect.poll(() => store.isModified(MUSIC), { timeout: 5_000 }).toBe(false);

  // The one case with nothing to wait for: it asserts a write does NOT happen, and an absence cannot be polled
  // for. Past the store's coalescing window, whatever that is.
  const pastTheWindow = async () => new Promise((resolve) => setTimeout(resolve, 1_200));

  test("writes an edit without a save, once the run of edits stops", async () => {
    const wanted = flipped();
    await store.setAutosave(true);
    store.set(MUSIC, wanted);
    await store.idle();
    expect(store.isModified(MUSIC), "still pending straight after the edit").toBe(true);
    await saved();
    expect(read(`${PREVIEW_INSTALL}/fallout2.cfg`)).toContain(`music=${wanted}`);
    expect(store.notice, "and says nothing, like any other save that worked").toBeNull();
  });

  test("turning it off cancels the write its own edit scheduled", async () => {
    const before = read(`${PREVIEW_INSTALL}/fallout2.cfg`);
    await store.setAutosave(true);
    store.set(MUSIC, flipped());
    // Inside the coalescing window: the user changed their mind before the write went out.
    await store.setAutosave(false);
    await pastTheWindow();
    expect(store.isModified(MUSIC), "the edit is still pending, waiting for Save").toBe(true);
    expect(read(`${PREVIEW_INSTALL}/fallout2.cfg`), "and nothing reached the file").toBe(before);
  });
});

describe("a long operation", () => {
  test("reports its step and proportion while it runs, and nothing once it has stopped", () => {
    expect(store.progressParts, "nothing is running").toBeNull();

    store.busy = "Updating sfall";
    store.progress = { step: "Downloading sfall 4.5", received: 440_000, total: 880_000, cancellable: true };
    expect(store.progressParts).toEqual({ step: "Downloading sfall 4.5", amount: "50% of 0.8 MB" });

    // A step with no length says what it is doing and claims no proportion it cannot know.
    store.progress = { step: "Merging your settings", received: null, total: null, cancellable: false };
    expect(store.progressParts).toEqual({ step: "Merging your settings", amount: null });
  });

  /* The window asks about a running operation before it closes, so it is told from the one place it is set. */
  test("tells the window what is running, and takes it back when it stops - failing or not", async () => {
    const told = vi.spyOn(commands, "setBusy");
    vi.spyOn(commands, "scan").mockRejectedValue(new Error("nothing to scan"));
    await store.scan();
    expect(told.mock.calls).toEqual([["Scanning"], [null]]);
    expect(store.notice?.kind, "the failure is still the user's to read").toBe("problem");
  });

  test("says a second request was refused rather than dropping it in silence", async () => {
    store.busy = "Updating sfall";
    await store.scan();
    expect(store.notice).toEqual({ kind: "problem", text: "Updating sfall is still running - wait for it to finish." });
  });

  /*
    Switching install reads it, and a read writes ZAX's pinned values and any carry. Refused at the store rather
    than only greyed in the panel, so the keyboard and any later entry point get the same answer.
  */
  test("refuses a switch of install while one runs, and says so", async () => {
    const selected = vi.spyOn(commands, "selectInstall");
    store.busy = "Updating sfall";
    expect(await store.selectInstall("fixtures/f2"), "the caller is told, so a rename cannot follow").toBe(false);
    expect(store.selectedInstall).toBe(PREVIEW_INSTALL);
    expect(selected).not.toHaveBeenCalled();
    expect(store.notice?.text).toBe("Updating sfall is still running - wait for it to finish.");
  });

  test("refuses to drop an install from the list while one runs", async () => {
    const removed = vi.spyOn(commands, "removeInstall");
    store.busy = "Installing RPU";
    await store.removeInstall(PREVIEW_INSTALL);
    expect(removed).not.toHaveBeenCalled();
    expect(store.installs.map((one) => one.path)).toContain(PREVIEW_INSTALL);
  });

  test("says why the controls are refused, in a sentence, and nothing when they are not", () => {
    expect(store.busyReason).toBeNull();
    store.busy = "Installing Restoration Project Updated";
    expect(store.busyReason).toBe("Installing Restoration Project Updated is running.");
    store.cancelling = true;
    expect(store.busyReason).toBe("Stopping Installing Restoration Project Updated.");
  });
});

describe("stopping an operation", () => {
  /** A scan the test resolves by hand, so what is asserted is the state during it. */
  const held = () => {
    let settle: (error?: Error) => void = () => {};
    vi.spyOn(commands, "scan").mockImplementation(
      async () =>
        new Promise((resolve, reject) => {
          settle = (error) => (error ? reject(error) : resolve({ view: undefined as unknown as AppView, answer: 0 }));
        }),
    );
    return (error?: Error) => settle(error);
  };

  /* Read from what the running step declares: only the transfer honours a cancel. */
  test("is offered only where the running step says a cancel would reach it", () => {
    expect(store.cancellable).toBe(false);
    store.busy = "Installing";
    store.progress = { step: "Downloading", received: 1, total: 10, cancellable: true };
    expect(store.cancellable).toBe(true);
    store.progress = { step: "Installing the files", received: null, total: null, cancellable: false };
    expect(store.cancellable).toBe(false);
  });

  test("asks once, and stops offering itself", async () => {
    const settle = held();
    const asked = vi.spyOn(commands, "cancel").mockResolvedValue(undefined);
    const scanning = store.scan();
    store.progress = { step: "Downloading", received: 1, total: 10, cancellable: true };

    await store.cancel();
    await store.cancel();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(store.cancellable).toBe(false);

    settle(new Error("Cancelled."));
    await scanning;
  });

  /*
    What comes back has crossed a boundary that keeps the message and drops the type, so the only side that still
    knows a cancel was asked for is the side that asked.
  */
  test("reports a stopped operation as stopped, and a genuine failure as one", async () => {
    vi.spyOn(commands, "cancel").mockResolvedValue(undefined);
    let settle = held();
    let scanning = store.scan();
    store.progress = { step: "Downloading", received: 1, total: 10, cancellable: true };
    await store.cancel();
    settle(new Error("Cancelled."));
    await scanning;
    expect(store.notice).toEqual({ kind: "note", text: "Scanning was stopped. What had been downloaded is kept." });
    expect(store.cancelling, "and the next operation starts clean").toBe(false);

    settle = held();
    scanning = store.scan();
    settle(new Error("nothing to scan"));
    await scanning;
    expect(store.notice).toEqual({ kind: "problem", text: "Scanning failed: nothing to scan" });
  });
});

describe("the note a carry raises", () => {
  const BARTER = "sfall.Interface.ExpandBarter";

  /** ZAX wrote 0 to both engines, and Fission's own screen then moved its copy. */
  const carried = async () => {
    disk().writeFile(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
    await store.start();
    store.set(BARTER, "0");
    await store.idle();
    await store.save();
    disk().writeFile(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await store.start();
  };

  test("goes up with the reading that carried a value, and down when the carry is reverted", async () => {
    await carried();
    expect(store.notice?.kind).toBe("note");
    expect(store.notice?.text).toContain("carried across to the other engines");

    await store.revertAll();
    expect(store.notice).toBeNull();
  });

  /* Held by identity: reverting the carry must not take down a report that landed on top of its note. */
  test("leaves a later report standing when the carry goes", async () => {
    await carried();
    store.notice = { kind: "done", text: "Something else happened." };
    await store.revertAll();
    expect(store.notice).toEqual({ kind: "done", text: "Something else happened." });
  });
});

describe("the checks ZAX makes for itself at startup", () => {
  test("do not hold the busy gate, and report nothing when the machine cannot be reached", async () => {
    const during = store.checkForUpdates();
    expect(store.busy, "nobody asked for these, so they must not lock the interface").toBeNull();
    await during;
    // The preview refuses every one of them the way an offline machine would.
    expect(store.zaxLatest).toBeNull();
    expect(store.sfallLatest).toBeNull();
    expect(store.notice, "several notices about being offline would bury the ones that matter").toBeNull();
  });
});

describe("a mod flow", () => {
  const offer = (over: Partial<ModOffer> = {}): ModOffer => ({
    id: "fo2tweaks",
    name: "FO2tweaks",
    version: "14.8",
    modType: "pluggable",
    author: null,
    description: null,
    forum: false,
    homepage: false,
    reason: null,
    becomes: null,
    creates: null,
    asks: [],
    choices: null,
    noFeed: false,
    availability: { kind: "install" },
    ...over,
  });

  const part = (id: string, label: string, needs: string | null = null) => ({
    id,
    label,
    help: null,
    archive: `${id}.dat`,
    entries: null,
    needs,
  });

  const withParts = (ask: boolean, selection: string[] = []) =>
    offer({
      choices: {
        carried: { selection, dropped: [], ask },
        groups: [
          { label: "Head", pick: "any", options: [part("head", "New head")] },
          { label: "Voice", pick: "one", options: [part("joey", "Joey", "head"), part("tom", "Tom", "head")] },
        ],
      },
    });

  test("asks which parts before planning, when the choice cannot be carried over", async () => {
    const plan = vi.spyOn(commands, "planMod");
    await store.prepareMod(withParts(true));
    expect(store.modParts?.chosen).toEqual([]);
    expect(plan, "nothing is downloaded until the choice is made").not.toHaveBeenCalled();
  });

  test("carries a recorded choice straight to the plan, without asking", async () => {
    const plan = vi.spyOn(commands, "planMod").mockRejectedValue(new Error("the preview reaches no feed"));
    await store.prepareMod(withParts(false, ["head", "joey"]));
    expect(store.modParts).toBeNull();
    expect(plan).toHaveBeenCalledWith("fo2tweaks", ["head", "joey"], undefined, undefined);
  });

  /* The rule is the other side's; what is pinned here is that the dialog shows its answer. */
  test("ticks a part by the rule that keeps a pick-one group to one and a needed part with what needs it", async () => {
    await store.prepareMod(withParts(true));
    await store.setModPart("head", true);
    await store.setModPart("joey", true);
    await store.setModPart("tom", true);
    expect(store.modParts?.chosen).toEqual(["head", "tom"]);
    await store.setModPart("head", false);
    expect(store.modParts?.chosen).toEqual([]);
  });

  test("asks for the folders a mod reads before anything is downloaded, and plans with the answers", async () => {
    const asks = [{ id: "fallout1", label: "Your Fallout 1 folder", help: null, holds: "master.dat" }];
    const plan = vi.spyOn(commands, "planMod").mockRejectedValue(new Error("the preview reaches no feed"));
    await store.prepareMod(offer({ asks }));
    expect(store.modInputs?.answers).toEqual({});
    expect(plan).not.toHaveBeenCalled();

    store.modInputs = { ...store.modInputs!, answers: { fallout1: "/games/fallout1" } };
    await store.confirmModInputs();
    expect(store.modInputs).toBeNull();
    expect(plan).toHaveBeenCalledWith("fo2tweaks", [], { fallout1: "/games/fallout1" }, undefined);
    expect(store.notice?.kind, "the refusal is reported rather than swallowed").toBe("problem");
  });

  test("marks the control that started it, and clears the mark however the flow ends", async () => {
    let settle: () => void = () => {};
    vi.spyOn(commands, "restoreMod").mockImplementation(
      async () =>
        new Promise((_, reject) => {
          settle = () => reject(new Error("nothing is waiting to be restored"));
        }),
    );
    const running = store.restoreMod(offer());
    await Promise.resolve();
    expect(store.modWorking("fo2tweaks", "restore")).toBe(true);
    expect(store.modWorking("fo2tweaks", "remove")).toBe(false);
    settle();
    await running;
    expect(store.modWorking("fo2tweaks", "restore")).toBe(false);
    expect(store.notice?.kind).toBe("problem");
  });

  describe("choosing a version", () => {
    const base = offer({ id: "rpu23", modType: "base", availability: { kind: "upgrade", from: "2.3.32" } });

    /* Only a base mod has a floor: its installer has no way back down. */
    test("asks for what a base mod could move to, and for everything otherwise", async () => {
      const versions = vi.spyOn(commands, "modVersions").mockResolvedValue(["2.3.34", "2.3.33"]);
      await store.chooseModVersion(base);
      expect(versions).toHaveBeenLastCalledWith("rpu23", "2.3.32");
      expect(store.modVersionPick).toEqual({ offer: base, versions: ["2.3.34", "2.3.33"], read: true });

      await store.chooseModVersion(offer({ availability: { kind: "downgrade", from: "15.0" } }));
      expect(versions).toHaveBeenLastCalledWith("fo2tweaks", undefined);
    });

    /* A conversion states what is on disk separately: the offered type is the one it would become. */
    test("floors on the type that is installed, not the one on offer", async () => {
      const versions = vi.spyOn(commands, "modVersions").mockResolvedValue([]);
      await store.chooseModVersion({
        ...base,
        modType: "pluggable",
        availability: { kind: "convert", from: "2.3.32", was: "base" },
      });
      expect(versions).toHaveBeenCalledWith("rpu23", "2.3.32");
    });

    test("closes the dialog rather than sitting on a list that will never arrive", async () => {
      vi.spyOn(commands, "modVersions").mockRejectedValue(new Error("the machine cannot be reached"));
      await store.chooseModVersion(base);
      expect(store.modVersionPick).toBeNull();
      expect(store.notice?.text).toContain("the machine cannot be reached");
    });

    test("plans the version picked rather than the one the row names", async () => {
      const plan = vi.spyOn(commands, "planMod").mockResolvedValue({ kind: "base", version: "2.3.33" } as never);
      await store.prepareMod(base, undefined, undefined, "2.3.33");
      expect(plan).toHaveBeenCalledWith("rpu23", undefined, undefined, "2.3.33");
      expect(store.modPlan?.version).toBe("2.3.33");
    });
  });

  describe("reporting an install", () => {
    const answering = (outcome: Record<string, unknown>) =>
      vi.spyOn(commands, "installMod").mockImplementation(async () => ({
        view: await commands.view(),
        answer: { outcome: { conflicts: [], ...outcome }, refusedRegistration: null } as never,
      }));

    const confirm = async () => {
      store.modPlan = {
        offer: offer({ name: "Fallout et tu", version: "1.16.3771" }),
        version: "1.16.3771",
        plan: { kind: "creates", fingerprint: "f", inputs: { fallout1: "/games/fallout1" } } as never,
      };
      await store.confirmModInstall();
    };

    test("says a created game is now on the list", async () => {
      answering({ kind: "creates", version: "1.16.3771", created: `${PREVIEW_INSTALL}/Fallout1in2`, skipped: [] });
      await confirm();
      expect(store.notice?.text).toContain("is now on the list of installations");
    });

    test("names the paths the user's archive did not hold, while a reader can still read them", async () => {
      const skipped = ["SOUND/SPEECH/LIEUT/LI3ACD~5.TXT", "SOUND/SPEECH/LIEUT/LI3ACF~5.TXT"];
      answering({ kind: "creates", version: "1.16.3771", created: "x", skipped });
      await confirm();
      expect(store.notice?.text).toContain(`Your archive does not hold ${skipped.join(", ")}, so they were skipped.`);
    });

    test("counts them instead once there are more than a banner can carry", async () => {
      const skipped = Array.from({ length: 176 }, (_, i) => `SOUND/SPEECH/A${i}~1.TXT`);
      answering({ kind: "creates", version: "1.16.3771", created: "x", skipped });
      await confirm();
      expect(store.notice?.text).toContain("Your archive does not hold 176 of the files the mod asked for");
      expect(store.notice?.text).not.toContain("SOUND/SPEECH/A0~1.TXT");
    });

    test("sends the plan's own choices and folders, not the dialogs'", async () => {
      const install = answering({ kind: "creates", version: "1.16.3771", created: "x", skipped: [] });
      await confirm();
      expect(install).toHaveBeenCalledWith({
        modId: "fo2tweaks",
        fingerprint: "f",
        choices: [],
        answers: { fallout1: "/games/fallout1" },
        version: null,
      });
    });
  });
});

describe("running the game", () => {
  const fission = (): EngineListing => {
    const found = store.engines.find((one) => one.id === "fission");
    if (!found?.caution) throw new Error("the preview no longer lists Fission with a caution");
    return found;
  };
  const launching = () => vi.spyOn(commands, "launch").mockImplementation(async () => commands.view());

  test("starts the game's own executable, or an engine, with the build the caller names", async () => {
    const launch = launching();
    await store.play();
    expect(launch).toHaveBeenLastCalledWith(null, null);
    await store.play("fallout2-ce", { pick: "published", published: "2026-07-01T00:00:00Z" });
    expect(launch).toHaveBeenLastCalledWith("fallout2-ce", { pick: "published", published: "2026-07-01T00:00:00Z" });
  });

  /* What Fission does to the mods folder outlives the session, so it is said before the launch. */
  test("holds a launch behind the engine's caution, and cancelling starts nothing", async () => {
    fission();
    const launch = launching();
    await store.play("fission");
    expect(store.pendingLaunch?.caution).not.toBeNull();
    store.dismissLaunch();
    expect(launch).not.toHaveBeenCalled();
    expect(store.acceptedCautions).toEqual([]);
  });

  test("running anyway launches the build the held launch was for, and asks again next time", async () => {
    fission();
    const launch = launching();
    await store.play("fission", { pick: "latest" });
    expect(launch).not.toHaveBeenCalled();
    await store.confirmLaunch(false);
    expect(launch).toHaveBeenCalledWith("fission", { pick: "latest" });

    await store.play("fission");
    expect(store.pendingLaunch?.caution, "the box was left unticked").not.toBeNull();
  });

  /* The box silences the caution only: the swap rewrites a file the user owns, so it is said every time. */
  test("ticking the box records the engine and stops raising its caution, and the swap is still said", async () => {
    fission();
    launching();
    await store.play("fission");
    await store.confirmLaunch(true);
    expect(store.acceptedCautions).toEqual(["fission"]);

    await store.play("fission");
    expect(store.pendingLaunch, "still held, by the swap").not.toBeNull();
    expect(store.pendingLaunch?.caution).toBeNull();
    expect(store.pendingLaunch?.swap?.to).toBe("fission");
  });

  test("does not hold an engine that declares no caution, over a folder whose order stays put", async () => {
    const launch = launching();
    await store.play("fallout2-ce");
    expect(store.pendingLaunch).toBeNull();
    expect(launch).toHaveBeenCalled();
  });

  /* Holding a build is what makes a fetch not the first, so the fetch caution needs nothing remembered. */
  test("holds the first fetch of an engine that declares a caution, and not a later one", async () => {
    const listing = fission();
    const fetched = vi.spyOn(commands, "fetchEngine").mockRejectedValue(new Error("the preview reaches no feed"));
    vi.spyOn(store, "engines", "get").mockReturnValue([{ ...listing, versions: [] }]);
    await store.fetchEngine("fission");
    expect(store.pendingFetch?.engine.id).toBe("fission");
    store.dismissFetch();
    expect(fetched).not.toHaveBeenCalled();

    await store.fetchEngine("fission");
    await store.confirmFetch();
    expect(fetched).toHaveBeenCalledWith("fission", null);
  });
});

describe("the sentences an outcome is reported in", () => {
  const update = (over: Partial<SfallUpdate> = {}) =>
    vi.spyOn(commands, "changeSfall").mockImplementation(async () => ({
      view: await commands.view(),
      answer: { version: "4.5", replaced: ["ddraw.dll"], backup: null, conflicts: [], removed: [], ...over },
    }));

  test("a sfall change names the version, and what it kept, dropped and set aside", async () => {
    update();
    await store.changeSfall("4.5");
    expect(store.notice).toEqual({ kind: "done", text: "sfall is now 4.5." });

    update({ backup: "backup/2026-08-31" });
    await store.changeSfall("4.5");
    expect(store.notice?.text).toBe("sfall is now 4.5. Replaced files are in backup/2026-08-31.");

    update({
      conflicts: [
        { section: "Misc", key: "DamageFormula", mine: "1", theirs: "0" },
        { section: "Input", key: "ItemFastMoveKey", mine: "30", theirs: "0" },
      ],
    });
    await store.changeSfall("4.5");
    expect(store.notice?.text).toBe("sfall is now 4.5. Kept your value for DamageFormula, ItemFastMoveKey.");

    update({ removed: [{ section: "Misc", key: "Old" }] });
    await store.changeSfall("4.5");
    expect(store.notice?.text).toBe("sfall is now 4.5. Dropped 1 setting this release does not have.");

    update({
      removed: [
        { section: "Misc", key: "Old" },
        { section: "Misc", key: "Older" },
      ],
    });
    await store.changeSfall("4.5");
    expect(store.notice?.text).toBe("sfall is now 4.5. Dropped 2 settings this release does not have.");
  });

  test("installing sfall asks for the newest release and says which went in", async () => {
    const changed = update();
    await store.installSfall();
    expect(changed).toHaveBeenCalledWith(null);
    expect(store.notice).toEqual({ kind: "done", text: "sfall 4.5 is installed." });
  });

  test("a list of sfall versions that named none is still read, and says so", async () => {
    vi.spyOn(commands, "listSfallVersions").mockResolvedValue([]);
    await store.loadSfallVersions();
    expect(store.sfallVersionsRead).toBe(true);
    expect(store.notice?.text).toBe("The release listing named no versions. It may be worth trying again.");
  });

  test("the debug package says where it went and how much went in, whether or not its folder opens", async () => {
    const written: DebugPackage = { path: "/tmp/zax-debug.zip", contents: ["ddraw.ini", "SLOT01"] };
    vi.spyOn(commands, "createDebugPackage").mockResolvedValue(written);
    const opened = vi.spyOn(commands, "open").mockRejectedValue(new Error("no file manager here"));
    await store.createDebugPackage(["SLOT01"]);
    expect(opened).toHaveBeenCalledWith({ what: "own", directory: "debug" });
    expect(store.notice).toEqual({ kind: "done", text: "Wrote /tmp/zax-debug.zip - 2 files." });
  });

  test("the two wipes read differently, one emptying a directory and one clearing a file", async () => {
    const wiped = vi.spyOn(commands, "wipe").mockResolvedValue(undefined);
    await store.wipe("log");
    expect(wiped).toHaveBeenLastCalledWith({ what: "log" });
    expect(store.notice).toEqual({ kind: "done", text: "Cleared the log." });
    await store.wipe("packages");
    expect(wiped).toHaveBeenLastCalledWith({ what: "own", directory: "packages" });
    expect(store.notice).toEqual({ kind: "done", text: "Emptied the packages directory." });
  });

  test("a gate fix names what it set, since that can be on another tab", async () => {
    const def = store.defOf("fo2tweaks.run_speed.dude");
    if (!def) throw new Error("the preview's mod schema no longer carries the chained setting");
    await store.satisfyGate(def);
    expect(store.notice).toEqual({ kind: "done", text: expect.stringContaining("Set 2 settings") });
  });
});
