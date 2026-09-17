// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModListing } from "./bindings/ModListing";
import type { ModOffer } from "./bindings/ModOffer";
import type { ModPart } from "./bindings/ModPart";
import type { SettingDef } from "./bindings/SettingDef";
import { commands } from "./commands.js";
import ModsView from "./ModsView.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The mods tab. Almost everything here turns on what state a mod is already in, and each state gets its own
  sentence: installed and current, a version behind, installed by hand with no record, newer than the feed
  offers, an install that never finished. Getting one of those wrong tells the user something false about their
  own game folder.

  Which state a mod is in is worked out on the other side of the command boundary, and tested there. What is
  pinned here is the sentence each state gets, so the listing is presented directly.
*/

/**
 * An offer as the listing carries it: whatever the case needs, over a mod that is otherwise unremarkable. `type`
 * is accepted for the mod's type, which is how these cases read.
 */
const offer = (over: Record<string, unknown> = {}): ModOffer => {
  const { type, ...rest } = over;
  return {
    id: "fo2tweaks",
    name: "FO2tweaks",
    version: "14.8",
    modType: (type as ModOffer["modType"] | undefined) ?? "pluggable",
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
    ...rest,
  } as ModOffer;
};

/** A blocked availability names what is installed, or states that nothing is. */
const available = (availability: Record<string, unknown>) =>
  (availability.kind === "blocked" ? { from: null, ...availability } : availability) as ModOffer["availability"];

const listing = (offers: ModOffer[], failures: ModListing["failures"] = []) =>
  vi.spyOn(store, "modListing", "get").mockReturnValue({ offers, failures });

const publish = (
  over: Record<string, unknown> = {},
  availability: Record<string, unknown> = { kind: "install" },
  failures: ModListing["failures"] = [],
) => listing([offer({ ...over, availability: available(availability) })], failures);

/** Rows only the install's record describes arrive complete, as the listing carries them. */
const onlyInRecord = (offers: Array<Record<string, unknown>>) =>
  listing(offers.map((one) => offer({ ...one, availability: available(one.availability as Record<string, unknown>) })));

const nothingPublished = (failures: ModListing["failures"] = []) => listing([], failures);

/** A catalog setting any case can draw a row for. */
const someSetting = (): SettingDef => {
  const first = store.catalog?.settings[0];
  if (!first) throw new Error("the catalog is empty");
  return first;
};

beforeEach(async () => {
  await reseedPreview();
  // Startup reads the feeds on its own; let that read finish so the tab is not mid-flight.
  await vi.waitFor(() => expect(store.readingOffers).toBe(false));
  store.modsTab = "installation";
});
afterEach(() => {
  unmountAll();
  store.busy = null;
  vi.restoreAllMocks();
});

const view = () => render(ModsView as never, {} as never);

describe("the tab strip", () => {
  // Four in the preview, whose seeded install has Fission deployed; three where it has not.
  test("offers a tab per subject, in the order they are read in", () => {
    const v = view();
    const tabs = v.all(".tabbar [role=tab]").map((tab) => (tab.textContent ?? "").trim());
    expect(tabs).toEqual(["Installation", "Load order", "Fission load order", "Settings"]);
  });

  /* Held in the markup shown or not, like the top strip's: a dot appearing must not resize its tab. */
  test("reserves the unsaved dot on the two tabs that can have one", () => {
    const dots = view().all(".tabbar .dot");
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  test("switching tab changes what is drawn", () => {
    const v = view();
    v.all(".tabbar [role=tab]")[1]!.click();
    v.settle();
    expect(store.modsTab).toBe("order");
  });

  // Each tab is its own handler, so a strip where one of them does not switch is a live possibility.
  test("every tab in the strip reaches its own pane", () => {
    const v = view();
    const strip = v.all(".tabbar [role=tab]");
    for (const [at, expected] of [
      [3, "settings"],
      [2, "fission"],
      [1, "order"],
      [0, "installation"],
    ] as const) {
      strip[at]!.click();
      v.settle();
      expect(store.modsTab).toBe(expected);
    }
  });
});

describe("asking the feeds again", () => {
  afterEach(() => vi.restoreAllMocks());

  test("re-reads past the cache, which is the whole point of the button", () => {
    const asked = vi.spyOn(store, "loadModOffers").mockResolvedValue();
    const v = view();
    v.control("Refresh").click();
    v.settle();
    // `true` is the refresh: without it the button would answer from the same cached listing it just showed.
    expect(asked).toHaveBeenCalledWith(true);
  });
});

describe("before the feeds have answered", () => {
  /* "Reading" and "not read yet" are different states, and a shared message would hide which one this is. */
  test("distinguishes a read in flight from one that never started", () => {
    vi.spyOn(store, "modListing", "get").mockReturnValue(null);
    expect(view().one("p.empty").textContent).toContain("have not been read yet");
  });
});

describe("what an offer's status says", () => {
  /*
    The first status line, which is the availability one. A base or permanent mod draws a second below it
    saying it cannot be uninstalled - that note has its own cases further down, and folding the two together
    here would let either sentence satisfy an assertion meant for the other.
  */
  const status = (availability: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    publish(over, availability);
    return view().all("p.status")[0]?.textContent ?? "";
  };

  /* The heading states the same two classes, so a row's cells are the ones outside it. */
  const columns = (availability: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    publish(over, availability);
    const cell = (name: string) => view().all(`.offer:not(.head) .${name}`)[0]?.textContent?.trim() ?? "";
    return { current: cell("current"), available: cell("offered") };
  };

  test("a mod that is not installed", () => {
    expect(status({ kind: "install" })).toBe("Not installed.");
  });

  test("a mod that is installed and current", () => {
    expect(status({ kind: "installed" })).toBe("Installed and current.");
  });

  test("a mod a version behind names the version installed", () => {
    expect(columns({ kind: "upgrade", from: "14.7" })).toEqual({ current: "14.7", available: "14.8" });
    // The sentence that used to carry it would now be saying the same version a third time.
    expect(status({ kind: "upgrade", from: "14.7" })).toBe("");
  });

  /* A nightly names the commit it was built from, so nothing orders it against a release - which is why the
     row was inert. Laying the release over it is the only way off one, so the button has to be there. */
  test("a nightly is installable, and the column says what is there", () => {
    const nightly = { kind: "nightly", commit: "fc706658" };
    expect(columns(nightly)).toEqual({ current: "nightly", available: "14.8" });
    publish({}, nightly);
    const labels = view()
      .all("button")
      .map((button) => (button.textContent ?? "").trim());
    expect(labels).toContain("Install 14.8 over it");
  });

  /* `version` on a row the record alone describes is what is on disk, not an offer - printing it under
     Available would advertise the installed version as an upgrade. */
  test("a mod no feed follows offers nothing in the available column", () => {
    onlyInRecord([
      {
        id: "old",
        name: "An older mod",
        version: "1.0",
        type: "pluggable",
        noFeed: true,
        availability: { kind: "unfollowed" },
      },
    ]);
    const v = view();
    expect(v.all(".offer:not(.head) .current")[0]?.textContent?.trim()).toBe("1.0");
    expect(v.all(".offer:not(.head) .offered")[0]?.textContent?.trim()).toBe("no feed");
  });

  /* The sfall gate answers before the version comparison, so a refused row is frequently an installed mod. */
  test("a refused row still names what is installed", () => {
    expect(columns({ kind: "blocked", why: "Needs newer sfall.", from: "14.7" }).current).toBe("14.7");
  });

  /* A feed answering with an older release than what is installed is worth distrusting, so the row says so. */
  test("a feed offering something older than what is installed says the feed is suspect", () => {
    const text = status({ kind: "downgrade", from: "15.0" });
    expect(text).toContain("newer than what the feed offers");
    expect(text).toContain("worth distrusting");
  });

  test("a mod in the folder with no record says it was installed by hand", () => {
    expect(status({ kind: "install-over" })).toContain("installed by hand");
  });

  /* A nightly stamps the commit it was built from, and is usually built from after the last release. Read as
     "a version it does not state", the row said the install was unidentifiable and offered the older release
     as an ordinary install-over - which reads as an upgrade and is not one. */
  test("a nightly build names the commit, and warns the offer may be behind it", () => {
    const text = status({ kind: "nightly", commit: "fc706658" });
    expect(text).toContain("nightly build");
    expect(text).toContain("fc706658");
    expect(text).toContain("may be older than what is here");
    expect(text, "the wording that sent the user looking for a fault").not.toContain("does not state");
  });

  test("an install that never finished says so", () => {
    expect(status({ kind: "retry", version: "14.8" })).toContain("never finished");
  });

  /*
    An unfollowed row comes from the install's own record rather than from any feed, so it is driven the way
    production produces it - through `state.unfollowed` - not as a published mod wearing that availability.
  */
  test("a mod no feed follows any more says updates will not be offered", () => {
    onlyInRecord([
      { id: "old", name: "An older mod", version: "1.0", type: "pluggable", availability: { kind: "unfollowed" } },
    ]);
    expect(view().one("p.status").textContent).toContain("No feed follows this mod");
  });

  test("a blocked mod gives the reason it is blocked, in its own words", () => {
    expect(status({ kind: "blocked", why: "Needs the Restoration Project first." })).toBe(
      "Needs the Restoration Project first.",
    );
  });

  /*
    The two kinds of base mod read almost the same and mean opposite things: one replaces this installation, the
    other builds a second game beside it. Getting them the wrong way round tells the user their game is about to
    be overwritten when it is not, or the reverse.
  */
  test("a base mod that replaces this installation says so", () => {
    const text = status({ kind: "install" }, { type: "base", becomes: "fo1in2" });
    expect(text).toContain("Turns this installation into");
    expect(text).not.toContain("beside this installation");
  });

  test("a base mod that builds a second game beside this one says that instead", () => {
    const text = status({ kind: "install" }, { type: "base", becomes: "fo1in2", creates: "Fallout1in2" });
    expect(text).toContain("beside this installation");
    expect(text).not.toContain("Turns this installation into");
  });

  /*
    The same mod on the game it made, once that folder is on the list as an installation of its own: the folder
    it names is this installation, and sending the user to look for a copy of their game inside their game is
    the mistake the branch is here to avoid. Driven through the preview's own et tu install rather than a
    hand-made offer, since what decides is the type ZAX reads off that directory.
  */
  test("names this installation rather than a folder inside it where the created game is the one on screen", () => {
    publish({ type: "base", becomes: "fo1in2", creates: "Fallout1in2" }, { kind: "install" });
    // Whether it is, is decided against the type read off the directory - on the other side, and tested there.
    vi.spyOn(store, "createsInPlace").mockReturnValue(true);
    const notes = view()
      .all("p.status")
      .map((p) => p.textContent ?? "");
    expect(notes.some((line) => line.includes("what it installs is this whole game"))).toBe(true);
    expect(notes.some((line) => line.includes("a whole game in Fallout1in2"))).toBe(false);
  });

  test("a converting mod says which direction removability moves", () => {
    const gone = status({ kind: "convert", from: "14.7", was: "pluggable" });
    expect(gone).toContain("installing it gives that up");
    unmountAll();

    const gained = status({ kind: "convert", from: "14.7", was: "permanent" });
    expect(gained).toContain("cannot be removed. 14.8 can be");
  });
});

describe("what a row says the mod is", () => {
  test("shows the description and author a release publishes", () => {
    publish({ author: "Lexx", description: "Small fixes and options." });
    const text = view().text();
    expect(text).toContain("Small fixes and options.");
    expect(text).toContain("By Lexx");
  });

  test("says nothing where the manifest says nothing", () => {
    publish();
    expect(view().all(".offer .by")).toEqual([]);
  });

  test("offers only the pages the release publishes", () => {
    publish({ forum: true });
    const labels = view()
      .all(".offer .by button")
      .map((button) => (button.textContent ?? "").trim());
    expect(labels).toEqual(["Forum"]);
  });

  /* The address never reaches this side: the row asks for a page of a mod by name and the backend resolves it. */
  test("asks the backend for the page rather than for an address", () => {
    const opened = vi.spyOn(commands, "open").mockResolvedValue();
    publish({ homepage: true });
    view().all(".offer .by button")[0]?.click();
    expect(opened).toHaveBeenCalledWith({ what: "mod", id: "fo2tweaks", page: "homepage" });
  });
});

describe("what a row offers to do", () => {
  const actions = (availability: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    publish(over, availability);
    // The install button sits outside the actions box, in a track of its own that equalises its width, so a
    // row's controls are that button plus whatever the box holds.
    return view()
      .all(".offer .primary, .offer-actions button")
      .map((b) => (b.textContent ?? "").trim());
  };

  /** The install button's refusal, where it has one: the reason a disabled control owes its reader. */
  const refusal = (availability: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    publish(over, availability);
    const button = view().all(".offer .primary")[0];
    return button === undefined ? null : { label: button.textContent?.trim(), title: button.getAttribute("title") };
  };

  test("names the install by what it will do and to which version", () => {
    expect(actions({ kind: "install" })).toContain("Install 14.8");
    unmountAll();
    expect(actions({ kind: "upgrade", from: "14.7" })).toContain("Upgrade to 14.8");
    unmountAll();
    expect(actions({ kind: "install-over" })).toContain("Install 14.8 over it");
  });

  /*
    Shown refused rather than left out: a row whose button disappears makes the column jump, and the reason
    belongs on the control the user is reaching for rather than only in the line underneath.
  */
  test("shows the install refused, with its reason, for a version already installed", () => {
    expect(refusal({ kind: "installed" })).toEqual({
      label: "Install 14.8",
      title: "14.8 is what is installed.",
    });
  });

  /*
    A base mod is put in place by its own installer, which has no way back down. A mod that is files in the
    mods folder is replaced by an older release the same way it is by a newer one, so that one is offered.
  */
  test("refuses an older release for a base mod, and offers it for one that is not", () => {
    expect(refusal({ kind: "downgrade", from: "15.0" }, { type: "base" })?.title).toBe(
      "14.8 is older than the installed 15.0, and a base mod cannot be put back.",
    );
    unmountAll();
    expect(refusal({ kind: "downgrade", from: "15.0" })?.title).toBeNull();
  });

  /* Nothing to choose between when the one on offer cannot be installed, so the list is not offered either. */
  test("offers no version list on a row whose install is refused", () => {
    expect(actions({ kind: "installed" })).not.toContain("Other version");
  });

  test("offers a retry rather than an install for an attempt that never finished, plus the way back", () => {
    const labels = actions({ kind: "retry", version: "14.8" });
    expect(labels).toContain("Retry");
    expect(labels).toContain("Restore");
  });

  /* Refused rather than absent, so the row keeps its shape; the reason it carries is asserted above. */
  test("offers nothing that can be clicked to install for a mod that is already current", () => {
    publish({}, { kind: "installed" });
    expect(view().all(".offer .primary")[0]?.hasAttribute("disabled")).toBe(true);
  });

  /*
    What is installed decides removability, not what is offered: a mod that turns permanent in its next release
    is still the removable one on disk until that release is installed.
  */
  test("offers Remove for a pluggable mod that is here", () => {
    expect(actions({ kind: "installed" })).toContain("Remove");
  });

  test("offers no Remove for a permanent or base mod", () => {
    expect(actions({ kind: "installed" }, { type: "permanent" })).not.toContain("Remove");
    unmountAll();
    expect(actions({ kind: "installed" }, { type: "base" })).not.toContain("Remove");
  });

  test("judges removability by what is on disk, not by what the release becomes", () => {
    expect(actions({ kind: "convert", from: "14.7", was: "pluggable" }, { type: "permanent" })).toContain("Remove");
  });

  /*
    A refused release is the ordinary state of a mod that raised its sfall floor in a later one: the gate
    answers before the version comparison, so the row is blocked while the older release sits on disk. What is
    installed is still installed, and the version the refusal names is how the row knows it.
  */
  test("offers Remove for an installed mod whose newest release is refused", () => {
    expect(actions({ kind: "blocked", why: "needs sfall 4.1.3", from: "14.7" })).toContain("Remove");
  });

  test("offers no Remove where the refusal names no installed version, nothing being there to remove", () => {
    expect(actions({ kind: "blocked", why: "installs on Restoration Project" })).not.toContain("Remove");
  });

  /*
    A change of game leaves the previous game's rows on screen until the new game's reading lands. Disabled
    for that moment rather than clickable-and-refused: the row describes a folder the button would no longer
    act on, and the tab has no other way to say so before the click.
  */
  test("keeps a row's actions live, and says nothing, while the rows describe the selected game", () => {
    publish();
    const drawn = view();
    expect(drawn.all(".offer .primary")[0]?.hasAttribute("disabled")).toBe(false);
    expect(drawn.all(".reading")).toHaveLength(0);
    expect(drawn.one(".scroll").hasAttribute("inert")).toBe(false);
  });

  test("disables a row's actions while the feeds and the folder are being read again, and says why", () => {
    publish();
    vi.spyOn(store, "readingOffers", "get").mockReturnValue(true);
    const drawn = view();
    expect(drawn.all(".offer .primary")[0]?.hasAttribute("disabled")).toBe(true);
    // The reason on screen, not only a greyed control: both come from one sentence in the store.
    expect(drawn.one(".reading p").textContent).toBe(store.modsUnsettled);
    expect(drawn.text()).toContain("Rereading the feeds and this game's folder.");
    // The whole tab under it, refused in one act rather than control by control.
    expect(drawn.one(".scroll").hasAttribute("inert")).toBe(true);
  });

  test("places the reason outside the scrolling flow, so the rows it describes do not move under it", () => {
    // The sentence used to sit above the rows and take its height from them, so every change of game pushed
    // the list down and let it back up for the length of one read.
    publish();
    vi.spyOn(store, "readingOffers", "get").mockReturnValue(true);
    const drawn = view();
    expect(drawn.one(".scroll").contains(drawn.one(".reading"))).toBe(false);
  });

  test("refuses the version picker where the feeds cannot be read, and says which host can", () => {
    publish();
    const button = view().control("Other version");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toMatch(/desktop build/i);
  });

  test("installs through the store rather than doing anything itself", () => {
    const prepare = vi.spyOn(store, "prepareMod").mockResolvedValue(undefined);
    publish();
    view().control("Install 14.8").click();
    expect(prepare).toHaveBeenCalledOnce();
  });
});

describe("a mod that says up front it cannot be uninstalled", () => {
  /* Permanence is something to know going in, so it is said before install as well as after. */
  test("a permanent mod gives its declared reason", () => {
    publish({ type: "permanent", reason: "it rewrites the master dat." }, { kind: "install" });
    expect(view().text()).toContain("Cannot be uninstalled: it rewrites the master dat.");
  });

  test("a base mod that replaces the installation says why there is no way back", () => {
    publish({ type: "base" }, { kind: "install" });
    expect(view().text()).toContain("it replaces the installation rather than adding to it");
  });
});

describe("a feed that could not be read", () => {
  test("is listed with its reason rather than dropped silently", () => {
    nothingPublished([
      {
        repository: "BGforgeNet/Fallout2_Restoration_Project",
        id: "rpu",
        name: "Restoration Project",
        why: "The feed did not answer.",
      },
    ]);
    const v = view();
    expect(v.text()).toContain("Restoration Project");
    expect(v.text()).toContain("The feed did not answer.");
  });

  test("says no feeds are known when there is neither an offer nor a failure", () => {
    nothingPublished();
    expect(view().one("p.empty").textContent).toContain("No mod feeds are known");
  });
});

describe("the Fission sub-tab", () => {
  /** What the folder holds, split the way Fission's folder scan splits it - a rule tested on the other side. */
  const folderOf = (loads: string[], missed: string[]) => {
    const mods = [...loads, ...missed].map((name) => ({ name, enabled: true, kind: "dat" as const, owner: null }));
    vi.spyOn(store, "mods", "get").mockReturnValue(mods);
    vi.spyOn(store, "fissionMods", "get").mockReturnValue(mods.filter((one) => loads.includes(one.name)));
    vi.spyOn(store, "fissionMissed", "get").mockReturnValue(mods.filter((one) => missed.includes(one.name)));
  };

  const tabs = () =>
    view()
      .all(".tabbar [role=tab]")
      .map((tab) => (tab.textContent ?? "").trim());

  // The seeded install has Fission deployed, which is what the sub-tab follows: a build in the machine's cache
  // says nothing about whether this folder has ever run it.
  test("appears where it is deployed", () => {
    expect(tabs()).toContain("Fission load order");
  });

  test("is absent in a folder Fission has never run in", () => {
    vi.spyOn(store, "engineDeployed", "get").mockReturnValue({});
    expect(tabs()).not.toContain("Fission load order");
  });

  test("lists only what Fission would load", () => {
    folderOf(["mod_rpu.dat"], ["fo2tweaks.dat", "restoration"]);
    store.modsTab = "fission";
    expect(
      view()
        .all(".mod:not(.skipped) .name")
        .map((one) => one.textContent),
    ).toEqual(["mod_rpu.dat"]);
  });

  /*
    The load order's tick is a comment marker in a file Fission does not read, so a mod switched off there is
    still one its folder scan finds. Reporting it as off here would attribute an sfall fact to Fission.
  */
  test("draws no enabled state, which belongs to a file this engine ignores", () => {
    const mods = [
      { name: "mod_rpu.dat", enabled: true, kind: "dat" as const, owner: null },
      { name: "mod_bgs.dat", enabled: false, kind: "dat" as const, owner: null },
    ];
    vi.spyOn(store, "mods", "get").mockReturnValue(mods);
    vi.spyOn(store, "fissionMods", "get").mockReturnValue(mods);
    vi.spyOn(store, "fissionMissed", "get").mockReturnValue([]);
    store.modsTab = "fission";
    const v = view();
    expect(v.all(".mod:not(.skipped) .name").map((one) => one.textContent)).toEqual(["mod_rpu.dat", "mod_bgs.dat"]);
    expect(v.all(".mod.off")).toHaveLength(0);
  });

  /*
    The half that matters most: a list quietly missing two of the three entries reads as a folder holding one
    mod, which is the wrong thing to conclude and the reason this tab exists.
  */
  test("names what it left out rather than dropping it silently", () => {
    folderOf(["mod_rpu.dat"], ["fo2tweaks.dat", "restoration"]);
    store.modsTab = "fission";
    const v = view();
    expect(v.all(".mod.skipped .name").map((one) => one.textContent)).toEqual(["fo2tweaks.dat", "restoration"]);
    expect(v.one(".missed-head").textContent).toContain("2 entries");
  });

  test("says so where nothing in the folder is named the way Fission needs", () => {
    folderOf([], ["fo2tweaks.dat"]);
    store.modsTab = "fission";
    const v = view();
    expect(v.all(".mod:not(.skipped)")).toHaveLength(0);
    expect(v.one(".empty").textContent).toContain("named the way Fission needs");
  });

  /* The same sentence the engines list and the launch dialog carry - one text, read off the listing. */
  test("carries the engine's caution over the list it is about", () => {
    folderOf(["mod_rpu.dat"], []);
    store.modsTab = "fission";
    const caution = store.engines.find((one) => one.id === "fission")?.caution;
    if (!caution) throw new Error("Fission no longer declares a caution");
    expect(view().one(".caution-slot").textContent).toContain(caution);
  });
});

describe("the load order", () => {
  beforeEach(() => {
    store.modsTab = "order";
  });

  test("lists what is in the mods folder, each with the kind it is", () => {
    const v = view();
    expect(v.all(".mod").length).toBeGreaterThan(0);
    expect(v.all(".badge").map((b) => b.textContent)).toContain("dat");
  });

  test("names the installed mod an entry belongs to, and leaves the rest blank", () => {
    const v = view();
    const owners = v.all(".owner").map((o) => o.textContent);
    expect(owners).toContain("FO2tweaks");
    expect(owners.length).toBeLessThan(v.all(".mod").length);
  });

  test("toggling an entry marks the order changed", async () => {
    const v = view();
    const first = v.all<HTMLInputElement>(".pick input")[0]!;
    first.click();
    await store.idle();
    v.settle();
    expect(store.modsChanged).toBe(true);
  });

  test("an entry whose file is gone cannot be toggled, only forgotten", () => {
    const v = view();
    const gone = v.all(".mod.gone");
    expect(gone.length).toBeGreaterThan(0);
    expect(gone[0]!.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(gone[0]!.textContent).toContain("Forget");
  });

  /* The arrows are one control, and each end of the list has one that cannot move any further. */
  test("the first entry cannot move up and the last cannot move down", () => {
    const v = view();
    const rows = v.all(".mod");
    expect(rows[0]!.querySelector("button.move")!.hasAttribute("disabled")).toBe(true);
    expect(rows.at(-1)!.querySelector("button.move.down")!.hasAttribute("disabled")).toBe(true);
  });

  test("each arrow names the entry it moves, so the pair is not two unlabelled buttons", () => {
    const v = view();
    const name = v.all(".mod")[0]!.querySelector(".name")!.textContent;
    expect(v.all(".mod")[0]!.querySelector("button.move")!.getAttribute("aria-label")).toBe(`Move ${name} up`);
  });

  test("moving an entry down reorders the list", async () => {
    const v = view();
    const before = store.mods.map((mod) => mod.name);
    v.all(".mod")[0]!.querySelector<HTMLButtonElement>("button.move.down")!.click();
    await store.idle();
    v.settle();
    expect(store.mods.map((mod) => mod.name)).toEqual([before[1], before[0], ...before.slice(2)]);
  });

  /*
    Which end wins is the one thing about this file nobody can see by looking at it, and getting it backwards is
    how two mods that both work end up cancelling each other out.
  */
  test("the sort says which end wins in its tooltip", () => {
    expect(view().control("Sort to the recommendation").getAttribute("title")).toContain("last line wins");
  });

  test("the bulk forget appears only once more than one entry is dead", () => {
    const v = view();
    const offered = v.all("button").some((b) => b.textContent?.trim() === "Forget all missing");
    expect(offered).toBe(store.missingMods.length > 1);
  });

  test("says the folder is empty rather than drawing nothing", () => {
    vi.spyOn(store, "mods", "get").mockReturnValue([]);
    const v = view();
    expect(v.one("p.empty").textContent).toContain("Nothing in this install's");
  });

  /*
    The two bulk actions. Both rewrite the whole file in one press, and neither is reachable except by clicking
    - so the tooltip tests above assert what they say while nothing asserted what they do.
  */
  test("sorting to the recommendation reorders the file and marks it changed", async () => {
    const v = view();
    const sort = v.control("Sort to the recommendation") as HTMLButtonElement;
    expect(store.againstRecommendation.length, "the seed has to be out of order for this to move").toBeGreaterThan(0);

    const before = store.mods.map((mod) => mod.name);
    sort.click();
    await store.idle();
    v.settle();
    expect(store.mods.map((mod) => mod.name)).not.toEqual(before);
    expect(store.modsChanged).toBe(true);
  });

  test("forgetting the missing entries drops them from the list and leaves the rest", async () => {
    const v = view();
    const before = store.mods.length;
    const missing = store.missingMods.length;
    expect(missing, "the seed has to carry at least one dead entry for this to mean anything").toBeGreaterThan(0);

    // One row's own Forget where that is all there is, the bulk control where the view offers it.
    const bulk = v.all("button").find((button) => button.textContent?.trim() === "Forget all missing");
    (bulk ?? v.all(".mod.gone button").find((b) => b.textContent?.trim() === "Forget"))!.click();
    await store.idle();
    v.settle();

    expect(store.mods).toHaveLength(before - (bulk ? missing : 1));
    expect(store.modsChanged).toBe(true);
  });
});

describe("mod settings", () => {
  beforeEach(() => {
    store.modsTab = "settings";
  });

  test("says no mod carries a schema rather than showing an empty pane", () => {
    vi.spyOn(store, "modSettings", "get").mockReturnValue([]);
    expect(view().one("p.empty").textContent).toContain("No installed mod carries a settings schema");
  });

  test("draws a section per mod, headed by its name, with a way to open the file itself", () => {
    vi.spyOn(store, "modSettings", "get").mockReturnValue([
      {
        modId: "fo2tweaks",
        name: "FO2tweaks",
        files: ["mods/fo2tweaks.ini"],
        settings: [{ def: someSetting(), default: null }],
        dropped: [],
      },
    ]);
    const v = view();
    expect(v.one(".section-head h2").textContent).toBe("FO2tweaks");
    expect(v.text()).toContain("Open the file");
  });

  /* One section is no choice, so the strip only appears when there are two. */
  test("shows the ini's sections as sub-tabs only where there is more than one", () => {
    const a = someSetting();
    const b = store.catalog?.settings.find((s) => s.targets[0]!.section !== a.targets[0]!.section);
    if (!b) throw new Error("the catalog holds one section only");
    const group = (defs: SettingDef[]) => [
      {
        modId: "m",
        name: "M",
        files: ["mods/m.ini"],
        settings: defs.map((def) => ({ def, default: null })),
        dropped: [],
      },
    ];
    const schemas = vi.spyOn(store, "modSettings", "get").mockReturnValue(group([a]));
    expect(view().all(".subtabs")).toHaveLength(0);
    unmountAll();

    schemas.mockReturnValue(group([a, b]));
    expect(view().all(".subtabs")).toHaveLength(1);
  });

  /*
    Said once for the mod rather than per control: what is missing is the same answer each time, and a list of
    apologies down the section would drown the settings that do work.
  */
  test("says once how many settings need a newer ZAX, naming them", () => {
    vi.spyOn(store, "modSettings", "get").mockReturnValue([
      {
        modId: "m",
        name: "M",
        files: ["mods/m.ini"],
        settings: [{ def: someSetting(), default: null }],
        dropped: [{ address: "main.newthing", why: "unknown kind" }],
      },
    ]);
    const text = view().text();
    expect(text).toContain("One setting needs a newer ZAX");
    expect(text).toContain("main.newthing");
  });

  test("pluralises that note rather than saying 'One setting' twice", () => {
    vi.spyOn(store, "modSettings", "get").mockReturnValue([
      {
        modId: "m",
        name: "M",
        files: ["mods/m.ini"],
        settings: [{ def: someSetting(), default: null }],
        dropped: [
          { address: "main.a", why: "unknown kind" },
          { address: "main.b", why: "unknown kind" },
        ],
      },
    ]);
    expect(view().text()).toContain("2 settings need a newer ZAX");
  });
});

/*
  The four dialogs. Each one is the last thing a user reads before something irreversible happens to their game
  folder - which release is installed, which parts of it, which folder it reads from, what lands where - and
  none of that wording is reachable from a test of the store, which knows the values but not the sentences.
*/

describe("the version dialog", () => {
  test("marks the release the feed offers, and leaves the others plain", () => {
    store.modVersionPick = { offer: offer(), versions: ["14.8", "14.7"], read: true } as never;
    expect(
      view()
        .all("option")
        .map((one) => one.textContent),
    ).toEqual(["14.8 (newest)", "14.7"]);
  });

  test("says the list is still being read rather than showing an empty one", () => {
    store.modVersionPick = { offer: offer(), versions: [], read: false } as never;
    const drawn = view();
    expect(drawn.text()).toContain("Reading the list...");
    expect(drawn.one<HTMLSelectElement>("select.pick").disabled).toBe(true);
  });

  test("distinguishes a list still arriving from one that arrived empty", () => {
    store.modVersionPick = { offer: offer(), versions: [], read: true } as never;
    expect(view().text()).toContain("Nothing else to install");
  });

  test("holds the install button until a version is picked", () => {
    store.modVersionPick = { offer: offer(), versions: ["14.8"], read: true } as never;
    const drawn = view();
    // The dialog opens on nothing selected, and installing "" would be a request for a release that is not
    // one. Picking the newest is what the open does, but only once the list has arrived.
    expect(drawn.control("Install").hasAttribute("disabled")).toBe(true);
  });
});

describe("the parts dialog", () => {
  const part = (id: string, label: string, over: Partial<ModPart> = {}): ModPart => ({
    id,
    label,
    help: null,
    archive: `${id}.dat`,
    entries: null,
    needs: null,
    ...over,
  });
  const choice = (over: { dropped?: string[]; groups?: unknown[] } = {}) => ({
    carried: { selection: ["core"], dropped: over.dropped ?? [], ask: true },
    groups: over.groups ?? [
      {
        label: "Content",
        pick: "any",
        options: [part("core", "Core files"), part("extra", "Extra maps", { help: "Adds two maps.", needs: "core" })],
      },
    ],
  });

  test("draws one control per part, under the group the manifest named", () => {
    store.modParts = { offer: offer({ choices: choice() }), chosen: ["core"] } as never;
    const drawn = view();
    expect(drawn.one("legend").textContent).toBe("Content");
    expect(drawn.all(".part-name").map((one) => one.textContent)).toEqual(["Core files", "Extra maps"]);
    expect(drawn.text()).toContain("Adds two maps.");
  });

  test("names what an unavailable part is waiting for rather than only greying it", () => {
    store.modParts = { offer: offer({ choices: choice() }), chosen: [] } as never;
    const drawn = view();
    expect(drawn.text()).toContain("Needs Core files.");
    expect(drawn.all<HTMLInputElement>("input[type=checkbox]")[1]!.disabled).toBe(true);
  });

  test("stops waiting once the part it needs is ticked", () => {
    store.modParts = { offer: offer({ choices: choice() }), chosen: ["core"] } as never;
    const drawn = view();
    expect(drawn.text()).not.toContain("Needs Core files.");
    expect(drawn.all<HTMLInputElement>("input[type=checkbox]")[1]!.disabled).toBe(false);
  });

  test("names a recorded part this release dropped, by the version that dropped it", () => {
    store.modParts = { offer: offer({ choices: choice({ dropped: ["oldmaps"] }) }), chosen: ["core"] } as never;
    expect(view().text()).toContain("No longer offered by 14.8, so it cannot be kept: oldmaps");
  });

  test("draws a pick-one group as radios", () => {
    const groups = [{ label: "Speed", pick: "one", options: [part("fast", "Fast")] }];
    store.modParts = { offer: offer({ choices: choice({ groups }) }), chosen: ["fast"] } as never;
    expect(view().all("input[type=radio]").length).toBe(1);
  });

  test("holds Continue when nothing is ticked, since that installs nothing", () => {
    store.modParts = { offer: offer({ choices: choice() }), chosen: [] } as never;
    expect(view().control("Continue").hasAttribute("disabled")).toBe(true);

    store.modParts = { offer: offer({ choices: choice() }), chosen: ["core"] } as never;
    expect(view().control("Continue").hasAttribute("disabled")).toBe(false);
  });
});

describe("the folder-question dialog", () => {
  const asks = [{ id: "fallout1", label: "Fallout 1 folder", holds: "master.dat", help: "The original game." }];

  test("names the mod in its title, and the file that says the folder is the right one", () => {
    store.modInputs = { offer: offer({ asks }), chosen: [], answers: {} } as never;
    const drawn = view();
    expect(drawn.text()).toContain("Point FO2tweaks at what it needs");
    expect(drawn.text()).toContain("Fallout 1 folder");
    expect(drawn.text()).toContain("The original game.");
    expect(drawn.one<HTMLInputElement>(".ask-row input").placeholder).toBe("Find master.dat");
  });

  test("opens the picker on the file rather than on the folder around it", async () => {
    // A folder picker shows no files, so the one thing that settles whether this is the right copy of the
    // other game is the thing the user cannot see. The shell answers with the folder either way.
    const picker = vi.spyOn(commands, "chooseFolder").mockResolvedValue("/games/fallout");
    // To the field's own type rather than `never`: the assertion below reads the answer back, and `never`
    // narrows the field out of existence for the rest of the test.
    store.modInputs = { offer: offer({ asks }), chosen: [], answers: {} } as typeof store.modInputs;

    await store.browseForModInput("fallout1");

    expect(picker).toHaveBeenCalledWith("master.dat");
    expect(store.modInputs?.answers["fallout1"]).toBe("/games/fallout");
  });

  test("holds Continue until every folder has been answered", () => {
    store.modInputs = { offer: offer({ asks }), chosen: [], answers: {} } as never;
    expect(view().control("Continue").hasAttribute("disabled")).toBe(true);
  });

  test("shows the folder that was chosen, and lets the install proceed", () => {
    store.modInputs = { offer: offer({ asks }), chosen: [], answers: { fallout1: "/games/fallout" } } as never;
    const drawn = view();
    expect(drawn.one<HTMLInputElement>(".ask-row input").value).toBe("/games/fallout");
    expect(drawn.control("Continue").hasAttribute("disabled")).toBe(false);
  });
});

describe("the plan dialog", () => {
  test("names what a base mod turns the install into, and that it cannot be undone", () => {
    store.modPlan = {
      offer: offer({ name: "Fallout et tu", becomes: "fo1in2" }),
      version: "1.4",
      plan: {
        kind: "base",
        version: "1.4",
        asset: "ettu-setup.exe",
        route: "windows",
        download: 5 * 1024 * 1024,
        unpacked: 20 * 1024 * 1024,
        free: 900 * 1024 * 1024,
        lowercasing: 12,
        becomes: "fo1in2",
        fingerprint: "f",
      },
    } as never;
    const text = view().text();
    expect(text).toContain("ettu-setup.exe");
    expect(text).toContain("Download: 5.0 MB, unpacking to 20.0 MB");
    expect(text).toContain("Free on this drive: 900.0 MB");
    expect(text).toContain("12 file(s) and folder(s) renamed to lowercase first");
    expect(text).toContain("This cannot be undone.");
  });

  test("warns that a Windows installer opens a window of its own, and what is chosen in it", () => {
    // The plan is the last screen before the install runs, and on this route it is about to hand over to a
    // wizard. Unannounced, that window reads as something having gone wrong rather than as the next step.
    store.modPlan = {
      offer: offer({ becomes: "fallout2rpu" }),
      version: "1.4",
      plan: {
        kind: "base",
        version: "1.4",
        asset: "a.exe",
        route: "windows",
        download: 1024,
        unpacked: null,
        free: null,
        lowercasing: null,
        becomes: "fallout2rpu",
        fingerprint: "f",
      },
    } as never;
    expect(view().text()).toContain("Its own installer window opens, where you choose what to install");
  });

  test("says nothing of a wizard on the route that has none, which runs a script and returns", () => {
    store.modPlan = {
      offer: offer({ becomes: "fallout2rpu" }),
      version: "1.4",
      plan: {
        kind: "base",
        version: "1.4",
        asset: "a.zip",
        route: "other",
        download: 1024,
        unpacked: null,
        free: null,
        lowercasing: null,
        becomes: "fallout2rpu",
        fingerprint: "f",
      },
    } as never;
    expect(view().text()).not.toContain("installer window opens");
  });

  test("names the folder a creating mod makes and the folders it reads", () => {
    store.modPlan = {
      offer: offer({
        name: "Fo1in2",
        asks: [{ id: "fallout1", label: "Fallout 1 folder", holds: "master.dat", help: null }],
      }),
      version: "2.0",
      plan: {
        kind: "creates",
        version: "2.0",
        directory: "Fo1in2",
        asset: "fo1in2.zip",
        download: 700 * 1024,
        unpacked: 3 * 1024 * 1024,
        free: null,
        inputs: { fallout1: "/games/fallout" },
        extracts: 42,
        becomes: "fo1in2",
        fingerprint: "f",
      },
    } as never;
    const text = view().text();
    expect(text).toContain("Fo1in2");
    expect(text).toContain("This installation is not changed.");
    // Under a megabyte is read in kilobytes; nobody counts a 700 KB download in fractions of a megabyte.
    expect(text).toContain("Download: 700 KB, unpacking to 3.0 MB");
    expect(text).toContain("Fallout 1 folder: /games/fallout");
    expect(text).toContain("42 file(s) unpacked from it");
  });

  test("lists every file a stacking mod lands, marking the ones that replace something", () => {
    store.modPlan = {
      offer: offer(),
      version: "14.8",
      plan: {
        kind: "stacking",
        files: [
          { path: "mods/fo2tweaks.dat", size: 10, overwrites: false, part: null },
          { path: "mods/fo2tweaks.ini", size: 2, overwrites: true, part: null },
        ],
        orderLines: ["fo2tweaks.dat"],
        removes: ["mods/old.dat"],
        parts: null,
        fingerprint: "f",
      },
    } as never;
    const text = view().text();
    expect(text).toContain("mods/fo2tweaks.dat");
    expect(text).toContain("replaces the file there; a copy is kept");
    expect(text).toContain("No longer shipped, removed");
    expect(text).toContain("mods/old.dat");
    expect(text).toContain("Load order: fo2tweaks.dat enabled.");
  });

  test("says a single dropped part is, and two are, no longer offered", () => {
    const withDropped = (dropped: string[]) => ({
      offer: offer({ choices: { carried: { selection: [], dropped, ask: false }, groups: [] } }),
      version: "14.8",
      plan: { kind: "stacking", files: [], orderLines: [], removes: [], parts: ["core"], fingerprint: "f" },
    });
    store.modPlan = withDropped(["oldmaps"]) as never;
    expect(view().text()).toContain("oldmaps is no longer offered");
    unmountAll();
    store.modPlan = withDropped(["oldmaps", "oldmusic"]) as never;
    expect(view().text()).toContain("oldmaps, oldmusic are no longer offered");
  });

  test("names a part the release no longer offers by its id, having no label left to use", () => {
    store.modPlan = {
      offer: offer({
        choices: {
          carried: { selection: ["core"], dropped: [], ask: false },
          groups: [
            {
              label: "Content",
              pick: "any",
              options: [
                { id: "core", label: "Core files", help: null, archive: "core.dat", entries: null, needs: null },
              ],
            },
          ],
        },
      }),
      version: "14.8",
      plan: { kind: "stacking", files: [], orderLines: [], removes: [], parts: ["core", "gone"], fingerprint: "f" },
    } as never;
    expect(view().text()).toContain("Parts: Core files, gone.");
  });
});
