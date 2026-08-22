<script lang="ts">
  import { onMount } from "svelte";
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
        return "Not installed.";
      case "install-over":
        return "In the mods folder without a record - installed by hand, or before ZAX kept one.";
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
                {#if offer.type === "permanent"}
                  <span class="badge">permanent</span>
                {/if}
                <p class="status" class:warn={offer.availability.kind === "downgrade"}>{statusOf(offer)}</p>
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

<!-- The resolved plan is the confirmation: what will land, what moves aside, which lines change - before
     anything is written. Cancelling keeps the download, so saying no costs nothing. -->
<Dialog
  open={store.modPlan !== null}
  title="Install {store.modPlan?.offer.name} {store.modPlan?.offer.version}"
  dismiss={() => store.dismissModPlan()}
>
  {#if store.modPlan}
    <p class="plan-lead">Lands in the game folder:</p>
    <ul class="plan">
      {#each store.modPlan.plan.files as file (file.path)}
        <li>
          <code>{file.path}</code>
          {#if file.overwrites}<span class="note">replaces the file there; a copy is kept</span>{/if}
        </li>
      {/each}
    </ul>
    {#if store.modPlan.plan.removes.length > 0}
      <p class="plan-lead">No longer shipped, removed - copies go to the backup first:</p>
      <ul class="plan">
        {#each store.modPlan.plan.removes as path (path)}
          <li><code>{path}</code></li>
        {/each}
      </ul>
    {/if}
    {#if store.modPlan.plan.orderLines.length > 0}
      <p class="plan-lead">
        Load order: <code>{store.modPlan.plan.orderLines.join(", ")}</code> enabled.
      </p>
    {/if}
  {/if}
  {#snippet footer()}
    <button onclick={() => store.dismissModPlan()}>Cancel</button>
    <button class="primary" onclick={() => void store.confirmModInstall()}>Install</button>
  {/snippet}
</Dialog>

<style>
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
     button reads as clickable, which is worse than the removal it replaced. */
  .tools button:disabled {
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
</style>
