<script lang="ts">
  import { onMount } from "svelte";
  import { GAME_TYPES, type GameType } from "@zax/core";
  import { type ModOffer, type ModSettingsGroup } from "@zax/fallout2";
  import Dialog from "./Dialog.svelte";
  import SaveBar from "./SaveBar.svelte";
  import SettingRow from "./SettingRow.svelte";
  import { store } from "./store.svelte.js";

  const KIND_LABEL = { dat: "dat", folder: "folder", file: "file", missing: "missing" } as const;

  // Once per showing, not per failure: a failed read leaves a listing with its failures named, so this does
  // not retry in a loop - the Refresh control is the deliberate way to ask again.
  onMount(() => {
    if (store.install && store.modListing === null) void store.loadModOffers();
  });

  /** The one line under an offer's name that says where things stand. */
  function statusOf(offer: ModOffer): string {
    const state = offer.availability;
    switch (state.kind) {
      case "install":
        // A mod that creates an install leaves this one alone, so it says what appears rather than what
        // this becomes - the two read almost the same and mean opposite things.
        if (offer.creates && offer.becomes)
          return `Not installed. Creates ${gameName(offer.becomes)} in ${offer.creates}, beside this installation.`;
        return offer.becomes
          ? `Not installed. Turns this installation into ${gameName(offer.becomes)}.`
          : "Not installed.";
      case "install-over":
        if (offer.creates) return `${offer.creates} is already here, at a version it does not state.`;
        // A base mod's directory is the record it has not got: this install already is what the mod makes.
        return offer.becomes
          ? `This installation is already ${gameName(offer.becomes)}, at a version it does not state. Installing lays this release over it.`
          : "In the mods folder without a record - installed by hand, or before ZAX kept one.";
      case "installed":
        return "Installed and current.";
      case "upgrade":
        return `Installed: ${state.from}.`;
      case "convert":
        return state.was === "pluggable"
          ? `Installed: ${state.from}, which can be removed. ${offer.version} cannot be - installing it gives that up.`
          : `Installed: ${state.from}, which cannot be removed. ${offer.version} can be.`;
      case "downgrade":
        return `Installed: ${state.from}, newer than what the feed offers - a feed answering with an older release is worth distrusting.`;
      case "retry":
        return `An install of ${state.version} never finished.`;
      case "unfollowed":
        return "Installed. No feed follows this mod any more, so updates will not be offered.";
      case "blocked":
        return state.why;
    }
  }

  /** Whether the row gets a Remove control: something of it is here, and its type permits removal. */
  function removable(offer: ModOffer): boolean {
    const state = offer.availability;
    // What is installed decides, not what is offered: a mod that turns permanent in its next release is
    // still the removable one on disk until that release is installed.
    if ((state.kind === "convert" ? state.was : offer.type) !== "pluggable") return false;
    return ["installed", "upgrade", "downgrade", "install-over", "unfollowed", "convert"].includes(state.kind);
  }

  /** A schema's sections, in the order the manifest declares them - the author's one lever over layout. */
  function sectionsOf(group: ModSettingsGroup): string[] {
    const seen: string[] = [];
    for (const def of group.settings) if (!seen.includes(def.section)) seen.push(def.section);
    return seen;
  }

  /** Mechanical, not curated: the ini's own section names, made readable. Identity stays the raw name. */
  const sectionTitle = (section: string): string =>
    (section.charAt(0).toUpperCase() + section.slice(1)).replace(/_/g, " ");

  const activeSection = (group: ModSettingsGroup): string =>
    store.modSectionTab[group.modId] ?? sectionsOf(group)[0] ?? "";

  /** The name ZAX gives the game a base mod turns this install into. */
  const gameName = (type: GameType): string => GAME_TYPES[type].name;

  /** Sizes as a person reads them. Bytes are what the release states; nobody counts in them. */
  const megabytes = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  /** Part ids as the manifest labels them; an id the release no longer offers stands for itself. */
  function partLabels(offer: ModOffer, ids: readonly string[]): string[] {
    const options = (offer.choices?.groups ?? []).flatMap((group) => group.options);
    return ids.map((id) => options.find((part) => part.id === id)?.label ?? id);
  }

  /** An input id as the manifest labels it, for a plan naming the folders it was pointed at. */
  const inputLabel = (offer: ModOffer, id: string): string => offer.asks?.find((input) => input.id === id)?.label ?? id;

  function installLabel(offer: ModOffer): string | null {
    switch (offer.availability.kind) {
      case "install":
        return `Install ${offer.version}`;
      case "install-over":
        return `Install ${offer.version} over it`;
      case "upgrade":
        return `Upgrade to ${offer.version}`;
      case "convert":
        return `Replace with ${offer.version}`;
      case "retry":
        return "Retry";
      default:
        return null;
    }
  }

  /**
   * The install button names the phase it is in while it runs, the way the sfall panel's buttons do. Both
   * phases are its own work: the download the plan needs, then the install the confirmed plan performs.
   */
  function installButtonLabel(offer: ModOffer): string | null {
    if (store.modWorking(offer.id, "prepare")) return "Preparing...";
    if (store.modWorking(offer.id, "install")) return "Installing...";
    return installLabel(offer);
  }
</script>

<!-- One shape for both directions: the down button rotates it, so the two arrows cannot drift apart. -->
{#snippet chevron()}
  <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 7.75 6 4.25l3.5 3.5" /></svg>
{/snippet}

<div class="pane">
  <div class="heading">
    <h1>Mods</h1>
  </div>

  <div class="tabbar">
    <div class="tabs" role="tablist">
      <button
        role="tab"
        class="tab"
        aria-selected={store.modsTab === "installation"}
        onclick={() => (store.modsTab = "installation")}
      >
        Installation
      </button>
      <button
        role="tab"
        class="tab"
        aria-selected={store.modsTab === "order"}
        onclick={() => (store.modsTab = "order")}
      >
        Load order
        <span
          class="dot"
          class:unsaved={store.modsChanged}
          aria-hidden="true"
          title={store.modsChanged ? "The mod order has unsaved changes" : null}
        ></span>
      </button>
      <button
        role="tab"
        class="tab"
        aria-selected={store.modsTab === "settings"}
        onclick={() => (store.modsTab = "settings")}
      >
        Settings
        <span
          class="dot"
          class:unsaved={store.modSettingsChanged}
          aria-hidden="true"
          title={store.modSettingsChanged ? "Mod settings have unsaved changes" : null}
        ></span>
      </button>
    </div>
  </div>

  <main>
    <!-- One scrolling region per tab, so the save bar stays put while the content moves. -->
    <div class="scroll">
      {#if store.modsTab === "installation"}
        <div class="feed-tools">
          <button class="link" disabled={store.busy !== null} onclick={() => void store.loadModOffers()}>
            Refresh
          </button>
        </div>

        {#if store.modListing === null}
          <p class="empty">{store.busy ? "Reading the mod feeds..." : "The feeds have not been read yet."}</p>
        {:else}
          {#each store.modListing.offers as offer (offer.id)}
            <div class="offer">
              <div class="about">
                <span class="mod-name">{offer.name}</span>
                <span class="version">{offer.version}</span>
                {#if offer.type !== "pluggable"}
                  <span class="badge">{offer.type}</span>
                {/if}
                <p class="status" class:warn={offer.availability.kind === "downgrade"}>{statusOf(offer)}</p>
                {#if offer.type === "base"}
                  <!-- Said before install as well as after, because it is the thing to know going in. The two
                     kinds of base mod need different sentences: one replaces this installation and the other
                     leaves it alone, so the way back differs as much as the install does. -->
                  <p class="status">
                    {offer.creates
                      ? `ZAX will not remove it: what it installs is a whole game in ${offer.creates}, which is a folder to delete by hand.`
                      : "Cannot be uninstalled: it replaces the installation rather than adding to it."}
                  </p>
                {/if}
                {#if offer.type === "permanent" && offer.reason !== undefined}
                  <!-- The declared reason stands in for the Remove control the row never gets - and it is
                     said before install too, since permanence is something to know going in. -->
                  <p class="status">Cannot be uninstalled: {offer.reason}</p>
                {/if}
              </div>
              <div class="offer-actions">
                {#if installLabel(offer) !== null}
                  <button class="primary" disabled={store.busy !== null} onclick={() => void store.prepareMod(offer)}>
                    {installButtonLabel(offer)}
                  </button>
                {/if}
                {#if offer.availability.kind === "retry"}
                  <button disabled={store.busy !== null} onclick={() => void store.restoreMod(offer)}>
                    {store.modWorking(offer.id, "restore") ? "Restoring..." : "Restore"}
                  </button>
                {/if}
                {#if removable(offer)}
                  <button class="danger" disabled={store.busy !== null} onclick={() => void store.removeMod(offer)}>
                    {store.modWorking(offer.id, "remove") ? "Removing..." : "Remove"}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
          {#each store.modListing.failures as failure (failure.id)}
            <div class="offer">
              <div class="about">
                <span class="mod-name">{failure.id}</span>
                <p class="status">{failure.why}</p>
              </div>
            </div>
          {/each}
          {#if store.modListing.offers.length === 0 && store.modListing.failures.length === 0}
            <p class="empty">No mod feeds are known for this game yet.</p>
          {/if}
        {/if}
      {:else if store.modsTab === "order"}
        <!-- The strip is absent only where there is no list to act on. The sort is disabled rather than
           removed when the order already follows the recommendation, as the reorder arrows are at the ends
           of the list: the row keeps its shape, and nothing under the cursor moves when the state changes.
           The bulk forget does come and go - it waits for a second dead entry, one being the row's own
           Forget already, and there is no shape to hold for a control most folders never have. -->
        {#if store.mods.length > 0}
          <div class="tools">
            {#if store.missingMods.length > 1}
              <button
                title="Drops their lines from the file. Nothing on disk is touched - these mods are already gone."
                onclick={() => store.forgetMissingMods()}
              >
                Forget all missing
              </button>
            {/if}
            <!-- Which end wins is the one thing about this file nobody can see by looking at it, and getting
               it backwards is how two mods that both work end up cancelling each other out. -->
            <button
              title="The last line wins - a mod further down overrides one above it"
              disabled={store.againstRecommendation.length === 0}
              onclick={() => store.sortMods()}
            >
              Sort to the recommendation
            </button>
          </div>
        {/if}
        <div class="list">
          {#each store.mods as mod, i (mod.name)}
            <div class="mod" class:off={!mod.enabled} class:gone={mod.kind === "missing"}>
              <!-- The name is the label, so the whole of it is a target for the checkbox rather than the box alone. -->
              <label class="pick">
                <input
                  type="checkbox"
                  checked={mod.enabled}
                  disabled={mod.kind === "missing"}
                  onchange={() => store.toggleMod(mod.name)}
                />
                <span class="name">{mod.name}</span>
              </label>
              <span class="badge" class:missing={mod.kind === "missing"}>{KIND_LABEL[mod.kind]}</span>
              <!-- Named only where the record claims the entry: a blank is one ZAX did not put there - a dat
                 dropped in by hand, or one from before the record existed. -->
              {#if mod.owner}
                <span class="owner">{mod.owner}</span>
              {/if}

              <div class="actions">
                {#if mod.kind === "missing"}
                  <!-- The only thing here that deletes a line. Everything present would come back from the folder. -->
                  <button class="link" onclick={() => store.forgetMod(mod.name)}>Forget</button>
                {/if}
                <!-- Tighter to each other than to anything else in the row: the two arrows are one control. -->
                <div class="reorder">
                  <button
                    class="move"
                    disabled={i === 0}
                    aria-label="Move {mod.name} up"
                    title="Move up"
                    onclick={() => store.moveMod(mod.name, -1)}>{@render chevron()}</button
                  >
                  <button
                    class="move down"
                    disabled={i === store.mods.length - 1}
                    aria-label="Move {mod.name} down"
                    title="Move down"
                    onclick={() => store.moveMod(mod.name, 1)}>{@render chevron()}</button
                  >
                </div>
              </div>
            </div>
          {:else}
            <p class="empty">
              Nothing in this install's <code>mods</code> folder. A mod is a <code>.dat</code> archive or a folder put there;
              it will be listed here once it is.
            </p>
          {/each}
        </div>
      {:else}
        {#each store.modSettings as group (group.modId)}
          <section>
            <div class="section-head">
              <h2>{group.name}</h2>
              <!-- The schema is allowed to be partial; the file itself stays reachable for what it leaves out. -->
              {#each group.files as file (file)}
                <button class="link" onclick={() => void store.openModIni(group.modId, file)}>
                  Open {group.files.length > 1 ? file : "the file"}
                </button>
              {/each}
            </div>
            <!-- The ini's sections as sub-tabs, the same second level the engine's settings files carry. One
               section is no choice, so the strip only appears when there are two. -->
            {#if sectionsOf(group).length > 1}
              <div class="subtabs" role="tablist">
                {#each sectionsOf(group) as section (section)}
                  <button
                    role="tab"
                    class="subtab"
                    aria-selected={activeSection(group) === section}
                    onclick={() => (store.modSectionTab = { ...store.modSectionTab, [group.modId]: section })}
                  >
                    {sectionTitle(section)}
                  </button>
                {/each}
              </div>
            {/if}
            <div class="list">
              {#each group.settings.filter((def) => def.section === activeSection(group)) as def (def.id)}
                <SettingRow {def} />
              {/each}
            </div>
            <!-- Said once for the mod rather than per control: what is missing is the same answer each time,
               and a list of apologies down the section would drown the settings that do work. -->
            {#if group.dropped.length > 0}
              <p class="status">
                {group.dropped.length === 1 ? "One setting needs" : `${group.dropped.length} settings need`} a newer ZAX,
                and {group.dropped.length === 1 ? "is" : "are"} not shown: {group.dropped
                  .map((entry) => entry.address)
                  .join(", ")}.
              </p>
            {/if}
          </section>
        {:else}
          <p class="empty">
            No installed mod carries a settings schema yet. A mod that ships one gets its settings here, edited with the
            same controls the game's own use.
          </p>
        {/each}
      {/if}
    </div>

    <SaveBar />
  </main>
</div>

<!-- Asked before anything is downloaded, and only when the choice cannot be carried over from the record:
     a first install, or a release that took away what was chosen. The plan dialog follows it as always. -->
<Dialog open={store.modParts !== null} title="Choose what to install" dismiss={() => store.dismissModParts()}>
  {#if store.modParts?.offer.choices}
    {@const chosen = store.modParts.chosen}
    {#if store.modParts.offer.choices.dropped.length > 0}
      <p class="plan-lead">
        No longer offered by {store.modParts.offer.version}, so it cannot be kept:
        <code>{store.modParts.offer.choices.dropped.join(", ")}</code>.
      </p>
    {/if}
    {#each store.modParts.offer.choices.groups as group (group.label)}
      <fieldset class="parts">
        <legend>{group.label}</legend>
        {#each group.options as part (part.id)}
          <!-- What this part waits on, by the name the manifest gave it, or nothing when it waits on none. -->
          {@const waits =
            part.needs === undefined || chosen.includes(part.needs)
              ? null
              : partLabels(store.modParts.offer, [part.needs])[0]}
          <!-- A component the installer always selects is shown rather than hidden, and not as a choice: it
             is part of what installing means, so its box is ticked and beyond reach. -->
          {@const fixed = "required" in part && part.required === true}
          <label class="part" class:blocked={waits !== null}>
            <input
              type={group.pick === "one" ? "radio" : "checkbox"}
              name={group.label}
              checked={fixed || chosen.includes(part.id)}
              disabled={fixed || waits !== null}
              onchange={(event) => store.setModPart(part.id, event.currentTarget.checked)}
            />
            <span>
              <span class="part-name">{part.label}</span>
              {#if part.help}<span class="note">{part.help}</span>{/if}
              {#if fixed}<span class="note">Always installed.</span>{/if}
              <!-- Named rather than merely greyed: what to tick to make it available is the whole answer. -->
              {#if waits !== null}<span class="note">Needs {waits}.</span>{/if}
            </span>
          </label>
        {/each}
      </fieldset>
    {/each}
  {/if}
  {#snippet footer()}
    <button onclick={() => store.dismissModParts()}>Cancel</button>
    <!-- A mod installing none of its own parts installs nothing; an installer with nothing ticked still
       installs what it always installs, so only the first is a reason to hold the button. -->
    <button
      class="primary"
      disabled={store.modParts?.offer.choices?.what === "parts" && store.modParts.chosen.length === 0}
      onclick={() => void store.confirmModParts()}
    >
      Continue
    </button>
  {/snippet}
</Dialog>

<!-- What the mod cannot know and ZAX cannot find: where the user keeps the other game it reads from. Asked
     before the download, since a folder that is not the right one is the likeliest thing to be wrong. -->
<Dialog
  open={store.modInputs !== null}
  title="Point {store.modInputs?.offer.name ?? ''} at what it needs"
  dismiss={() => store.dismissModInputs()}
>
  {#if store.modInputs}
    {@const answers = store.modInputs.answers}
    {#each store.modInputs.offer.asks ?? [] as input (input.id)}
      <div class="ask">
        <span class="part-name">{input.label}</span>
        {#if input.help}<span class="note">{input.help}</span>{/if}
        <div class="ask-row">
          <!-- Read-only rather than a typed path: the picker is the shell's, and a folder typed by hand is a
             refusal from the install rather than an answer. The file that decides whether the folder is the
             right one is the placeholder rather than a line of its own, which the help above already is. -->
          <input
            type="text"
            readonly
            value={answers[input.id] ?? ""}
            placeholder="Choose the folder holding {input.holds}"
          />
          <button onclick={() => void store.browseForModInput(input.id)}>Browse...</button>
        </div>
      </div>
    {/each}
  {/if}
  {#snippet footer()}
    <button onclick={() => store.dismissModInputs()}>Cancel</button>
    <button
      class="primary"
      disabled={(store.modInputs?.offer.asks ?? []).some((input) => !store.modInputs?.answers[input.id])}
      onclick={() => void store.confirmModInputs()}
    >
      Continue
    </button>
  {/snippet}
</Dialog>

<!-- The resolved plan is the confirmation: what will land, what moves aside, which lines change - before
     anything is written. Cancelling keeps the download, so saying no costs nothing. -->
<Dialog
  open={store.modPlan !== null}
  title="Install {store.modPlan?.offer.name} {store.modPlan?.offer.version}"
  dismiss={() => store.dismissModPlan()}
>
  {#if store.modPlan?.plan.kind === "base"}
    {@const plan = store.modPlan.plan}
    <!-- Thinner than a stacking mod's plan, and honestly so: the installer decides what lands, so this names
       the release, what it will cost, and what it cannot undo. -->
    <p class="plan-lead">
      Runs {store.modPlan.offer.name}'s own installer (<code>{plan.asset}</code>), which turns this installation into {gameName(
        plan.becomes,
      )}.
    </p>
    <ul class="plan">
      <li>
        Download: {megabytes(plan.download)}{#if plan.unpacked}, unpacking to {megabytes(plan.unpacked)}{/if}
      </li>
      {#if plan.free !== undefined}<li>Free on this drive: {megabytes(plan.free)}</li>{/if}
      {#if plan.components && plan.components.length > 0}
        <!-- By the names they were chosen under, not the installer's own: `walk_speed\low_fps` is what goes
           on the command line, and nobody picked that. -->
        <li>Components: {partLabels(store.modPlan.offer, plan.components).join(", ")}</li>
      {/if}
      {#if plan.lowercasing}
        <!-- Its own line rather than something that happens silently: it is the widest-reaching rename here. -->
        <li>{plan.lowercasing} file(s) and folder(s) renamed to lowercase first, which this system needs</li>
      {/if}
    </ul>
    <p class="plan-lead warn">
      This cannot be undone. ZAX will not be able to remove it - going back means a fresh copy of the game.
    </p>
  {:else if store.modPlan?.plan.kind === "creates"}
    {@const plan = store.modPlan.plan}
    <!-- Thicker than a delegated base mod's plan, because ZAX performs this one: what it makes, what it
       reads, and what both cost. Not a file list - ten thousand entries is not something anybody reads. -->
    <p class="plan-lead">
      Creates {gameName(plan.becomes)} in <code>{plan.directory}</code>, inside this game folder. This installation is
      not changed.
    </p>
    <ul class="plan">
      <li>Download: {megabytes(plan.download)}, unpacking to {megabytes(plan.unpacked)}</li>
      {#if plan.free !== undefined}<li>Free on this drive: {megabytes(plan.free)}</li>{/if}
      {#each Object.entries(plan.inputs) as [id, folder] (id)}
        <li>
          {inputLabel(store.modPlan.offer, id)}: <code>{folder}</code>
          {#if plan.extracts}<span class="note">{plan.extracts} file(s) unpacked from it</span>{/if}
        </li>
      {/each}
    </ul>
  {:else if store.modPlan?.plan.kind === "stacking"}
    {@const plan = store.modPlan.plan}
    <p class="plan-lead">Lands in the game folder:</p>
    <ul class="plan">
      {#each plan.files as file (file.path)}
        <li>
          <code>{file.path}</code>
          {#if file.overwrites}<span class="note">replaces the file there; a copy is kept</span>{/if}
        </li>
      {/each}
    </ul>
    {#if plan.removes.length > 0}
      <p class="plan-lead">No longer shipped, removed - copies go to the backup first:</p>
      <ul class="plan">
        {#each plan.removes as path (path)}
          <li><code>{path}</code></li>
        {/each}
      </ul>
    {/if}
    {#if plan.parts}
      <p class="plan-lead">
        Parts: <code>{partLabels(store.modPlan.offer, plan.parts).join(", ")}</code>.
      </p>
    {/if}
    {#if store.modPlan.offer.choices && store.modPlan.offer.choices.dropped.length > 0}
      <!-- Said before the install runs rather than left for the record to explain afterwards. -->
      <p class="plan-lead">
        <code>{store.modPlan.offer.choices.dropped.join(", ")}</code>
        {store.modPlan.offer.choices.dropped.length === 1 ? "is" : "are"} no longer offered, and will not be reinstalled.
      </p>
    {/if}
    {#if plan.orderLines.length > 0}
      <p class="plan-lead">
        Load order: <code>{plan.orderLines.join(", ")}</code> enabled.
      </p>
    {/if}
  {/if}
  {#snippet footer()}
    <button onclick={() => store.dismissModPlan()}>Cancel</button>
    <button class="primary" onclick={() => void store.confirmModInstall()}>Install</button>
  {/snippet}
</Dialog>

<style>
  /* One question per folder the mod asks for: what it is, the picker, and the file that says it is right. */
  .ask {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 1rem;
  }

  .ask-row {
    display: flex;
    gap: 0.5rem;
  }

  .ask-row input {
    flex: 1;
    min-width: 0;
  }

  /*
    Fixed tracks rather than a flex row, for the reason the settings rows have them: with the badge following
    the name it sat at a different place on every row, and a column of badges that never lines up reads as
    ragged rather than as a column. The name track is wide enough for the longest a mods folder holds.
  */
  .mod {
    display: grid;
    grid-template-columns: minmax(0, 22rem) auto minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 12px;
    padding: 7px var(--gutter);
    border-bottom: 1px solid var(--border);
    /* The same left rule the settings rows carry, so an edited row reads the same in both views. */
    border-left: 2px solid transparent;
  }

  /* Zebra and hover as the settings list has them: the two are the same kind of list and read alike. */
  .mod:nth-of-type(even) {
    background: color-mix(in srgb, var(--band) 40%, transparent);
  }

  .mod:hover {
    background: var(--panel-alt);
  }

  /* Above the list rather than in it - these act on the order as a whole - and drawn where the Installation
     tab draws its own control, so the two tabs put their tools in the same place. */
  .tools {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px var(--gutter) 0;
  }

  /* What the save bar and the panels draw for a button that is present but cannot act. Without it a kept
     button reads as clickable, which is worse than the removal it replaced. Every button in this view, not
     the tool strip's alone: the row actions grey out while an operation runs, and a dialog's Continue is
     disabled until something is picked. */
  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .pick {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .name {
    font-family: var(--mono);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }

  /* Dimmed rather than hidden: a mod that is off is still part of the order, and still has its place in it. */
  .off .name {
    color: var(--text-dim);
  }

  /*
    Struck through rather than faded away: the faint tone is under 4.5:1 on both palettes, and an entry the
    engine cannot load is exactly the row that has to stay readable. The rule and the badge carry the state.
  */
  .gone .name {
    text-decoration: line-through;
    color: var(--text-dim);
  }

  .badge {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 10.5px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 3px;
    padding: 0 4px;
  }

  /* An entry pointing at nothing is the one state here that is wrong rather than merely off. */
  .badge.missing {
    background: color-mix(in srgb, var(--invalid) 14%, transparent);
    color: var(--invalid);
  }

  /*
    ZAX's own knowledge rather than the folder's, so it reads as annotation beside the entry: the interface
    font against the name's mono, and the dim tone the status lines use.
  */
  .owner {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
    color: var(--text-dim);
  }

  /* At the row's right edge, where the settings rows put theirs, whatever the name and badge before it are.
     Pinned to its own track so a row with no owner keeps the arrows where the row above has them. */
  .actions {
    display: flex;
    align-items: center;
    justify-self: end;
    grid-column: 4;
    gap: 10px;
  }

  .reorder {
    display: flex;
    gap: 4px;
  }

  /* Square, so the pair reads as one two-part control rather than as two buttons of different widths. */
  .move {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 22px;
    background: var(--panel-alt);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 0;
    color: var(--text);
  }

  .move svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .move.down svg {
    transform: rotate(180deg);
  }

  /* At the ends of the list rather than hidden, so the row keeps its shape wherever a mod sits in the order. */
  .move:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .link {
    background: none;
    border: none;
    padding: 0;
    font-size: 12.5px;
    color: var(--accent);
    text-decoration: underline;
  }

  .empty code {
    font-family: var(--mono);
    font-size: 0.92em;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* The tab names the content, so the one control up here sits alone at the edge rather than under a heading. */
  .feed-tools {
    display: flex;
    justify-content: flex-end;
    padding: 8px var(--gutter) 0;
  }

  /* As the settings tabs draw theirs: space held in every state, only the ink toggles. */
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--modified);
    visibility: hidden;
  }

  .dot.unsaved {
    visibility: visible;
  }

  /* Inside the one scroller a list is plain flow - the pane-wide rule that makes a lone list grow and scroll
     would otherwise open dead space between the last row and the next section. */
  .scroll .list {
    flex: none;
    overflow-y: visible;
  }

  /* The same section head twice, so the two halves of the view read as siblings rather than strangers. */
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 10px var(--gutter) 4px;
  }

  .section-head h2 {
    font-size: 13px;
    margin: 0;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .offer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 12px;
    padding: 9px var(--gutter);
    border-bottom: 1px solid var(--border);
  }

  .about {
    min-width: 0;
  }

  .mod-name {
    font-weight: 600;
  }

  .version {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
    margin-left: 6px;
  }

  /* One line under the name; the row's height does not change with the state it reports. */
  .status {
    margin: 2px 0 0;
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .status.warn {
    color: var(--invalid);
  }

  .offer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-self: end;
  }

  /* The same clothes the save bar's primary and the wipe buttons' danger wear, so the same kind of action
     reads the same everywhere - in the rows and in the plan dialog's footer alike. */
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 550;
  }

  .danger {
    border-color: var(--invalid);
    color: var(--invalid);
  }

  .plan-lead {
    margin: 8px 0 4px;
  }

  .plan {
    margin: 0;
    padding-left: 18px;
    font-size: 12.5px;
  }

  .plan code {
    font-family: var(--mono);
  }

  .plan .note {
    color: var(--text-dim);
    margin-left: 6px;
  }

  /* A box per group, so a pick-one and a pick-any read as two questions rather than one list of ticks. */
  .parts {
    border: 1px solid var(--border);
    border-radius: 4px;
    margin: 10px 0 0;
    padding: 4px 10px 8px;
  }

  .parts legend {
    padding: 0 4px;
    color: var(--text-dim);
    font-size: 12px;
  }

  .part {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 5px 0;
  }

  .part input {
    margin-top: 2px;
  }

  .part .note {
    display: block;
    color: var(--text-dim);
    font-size: 12px;
  }

  /* Dimmed rather than hidden: a part that needs another is still one of the choices, and the line under it
     says which tick makes it available. */
  .blocked .part-name {
    color: var(--text-dim);
  }
</style>
