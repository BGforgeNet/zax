<script lang="ts">
  import { GAME_TYPES, ownTarget, type GameType } from "@zax/core";
  import { createsInPlace, type ModOffer, type ModSettingsGroup } from "@zax/fallout2";
  import Dialog from "./Dialog.svelte";
  import EngineCaution from "./EngineCaution.svelte";
  import SettingRow from "./SettingRow.svelte";
  import { isPreview } from "./host.js";
  import { MOD_ICON } from "./icons.js";
  import { store } from "./store.svelte.js";

  const KIND_LABEL = { dat: "dat", folder: "folder", file: "file", missing: "missing" } as const;

  const PREVIEW_FEEDS = "The browser preview cannot reach the mod feeds - this needs the desktop build";

  /**
   * The version the choice dialog is sitting on. Set where the list arrives rather than by an effect watching
   * for it: the newest is a starting point, and an effect would fight the user's own pick.
   */
  let wantedVersion = $state("");

  /**
   * Why the rows cannot be acted on, on the one tab whose rows the sentence is about - it names the offers,
   * which is not what the other two draw.
   */
  const unsettled = $derived(store.modsTab === "installation" ? store.modsUnsettled : null);

  async function openVersions(offer: ModOffer): Promise<void> {
    await store.chooseModVersion(offer);
    wantedVersion = store.modVersionPick?.versions[0] ?? "";
  }

  function closeVersions(): void {
    store.dismissModVersion();
    wantedVersion = "";
  }

  // No read on showing: the store asks the feeds whenever the selected install changes, so opening this tab
  // finds either an answer or one on its way. Refresh is the deliberate way to ask again.

  /** The one line under an offer's name that says where things stand. */
  function statusOf(offer: ModOffer): string | null {
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
      case "nightly":
        // Not "a version it does not state": it states one, and it is a commit. Saying which, and that the
        // offer may be behind it, is the difference between a message that reads as a fault and one the user
        // can act on - a nightly is usually built from after the last release.
        return `Installed: a nightly build, from commit ${state.commit}. It names no release, so ${offer.version} may be older than what is here.`;
      case "installed":
        return "Installed and current.";
      case "upgrade":
        // The Current and Available cells are this sentence, so it would say the version a third time.
        return null;
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

  /**
   * Why the install button is there but refuses, or nothing where it acts. A disabled control with no title is
   * a defect rather than a state, so every arm here answers.
   */
  function installRefusal(offer: ModOffer): string | null {
    const state = offer.availability;
    if (state.kind === "installed") return `${offer.version} is what is installed.`;
    // Only a base mod: it is put in place by its own installer, which has no way back down. Anything that is
    // files in the mods folder takes an older release the same way it takes a newer one.
    if (state.kind === "downgrade" && offer.type === "base")
      return `${offer.version} is older than the installed ${state.from}, and a base mod cannot be put back.`;
    return null;
  }

  /**
   * The Current column. A word rather than a blank where no release is installed: the column answers on its
   * own, which is the point of having it, and the line below carries what a word cannot - which commit a
   * nightly was built from, why a row is refused.
   */
  function currentOf(offer: ModOffer): string {
    const state = offer.availability;
    switch (state.kind) {
      case "install":
        return "not installed";
      case "install-over":
        return "unstated";
      case "nightly":
        return "nightly";
      case "installed":
      case "unfollowed":
        return offer.version;
      case "upgrade":
      case "convert":
      case "downgrade":
        return state.from;
      case "retry":
        return "incomplete";
      case "blocked":
        // The sfall and payload gates answer before the version comparison, so a refused row is frequently an
        // installed mod - it carries what the record says, and only a refused install type has nothing.
        return state.from ?? "not installed";
    }
  }

  /**
   * The Available column. `version` on a row the record alone describes is what is on disk rather than an
   * offer, so it is not one to advertise - see `noFeed`.
   */
  const availableOf = (offer: ModOffer): string => (offer.noFeed ? "no feed" : offer.version);

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
    for (const def of group.settings) {
      const section = ownTarget(def).section;
      if (!seen.includes(section)) seen.push(section);
    }
    return seen;
  }

  /** Mechanical, not curated: the ini's own section names, made readable. Identity stays the raw name. */
  const sectionTitle = (section: string): string =>
    (section.charAt(0).toUpperCase() + section.slice(1)).replace(/_/g, " ");

  const activeSection = (group: ModSettingsGroup): string =>
    store.modSectionTab[group.modId] ?? sectionsOf(group)[0] ?? "";

  /** The name ZAX gives the game a base mod turns this install into. */
  const gameName = (type: GameType): string => GAME_TYPES[type].name;

  /**
   * Whether the install this mod makes is the one on screen rather than a folder inside it, which is what the
   * game it creates looks like once that folder is on the list itself. Naming the folder there would send the
   * user looking inside their own game for a copy of it.
   */
  const isThisInstall = (offer: ModOffer): boolean =>
    store.install !== undefined && createsInPlace(store.install.type, offer);

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
      // A nightly joins install-over because laying the release over it is the same operation. A commit
      // cannot be ordered against releases, so the offer may be older - which the status line says, and why
      // the version list this unlocks is unfiltered: `chooseModVersion` floors on states that name a version.
      case "install-over":
      case "nightly":
        return `Install ${offer.version} over it`;
      case "upgrade":
        return `Upgrade to ${offer.version}`;
      // Named though neither can be acted on, so the column keeps its shape down the list and the reason is
      // on the control rather than only in the prose - `installRefusal` supplies it.
      case "installed":
      case "downgrade":
        return `Install ${offer.version}`;
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
      <!-- Only where the machine can actually run it: an install nothing holds a Fission build for has no
         question to answer here, and a tab that is always present would be four tabs for three subjects. -->
      {#if store.fissionEngine}
        <button
          role="tab"
          class="tab"
          aria-selected={store.modsTab === "fission"}
          onclick={() => (store.modsTab = "fission")}
        >
          Fission load order
        </button>
      {/if}
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
    <div class="scroll" class:dimmed={unsettled !== null} inert={unsettled !== null}>
      {#if store.modsTab === "installation"}
        <div class="feed-tools">
          <!-- The one control that asks the feeds again: everything else is told what they said before. -->
          <button
            class="link"
            disabled={store.busy !== null}
            title={store.busyReason}
            onclick={() => void store.loadModOffers(true)}
          >
            Refresh
          </button>
        </div>

        {#if store.modListing === null}
          <p class="empty">{store.readingOffers ? "Reading the mod feeds..." : "The feeds have not been read yet."}</p>
        {:else}
          <div class="offers">
            {#if store.modListing.offers.length > 0}
              <!-- A heading for the two columns: a bare pair of versions beside a name does not say which is
               which. Every row states the same tracks, so the heading lines up with them. -->
              <div class="offer head">
                <span></span>
                <span>Mod</span>
                <span class="cell current">Current</span>
                <span class="cell offered">Available</span>
              </div>
            {/if}
            {#each store.modListing.offers as offer (offer.id)}
              <!-- Decoration beside a name that already says which mod it is, so it carries no alt text. -->
              {@const icon = MOD_ICON[offer.id]}
              {@const status = statusOf(offer)}
              <div class="offer" class:refused={offer.availability.kind === "blocked"}>
                {#if icon}
                  <img class="mod-icon" src={icon} alt="" width="64" height="34" />
                {:else}
                  <span class="mod-icon"></span>
                {/if}
                <div class="about">
                  <span class="mod-name">{offer.name}</span>
                  {#if offer.type !== "pluggable"}
                    <span class="badge">{offer.type}</span>
                  {/if}
                </div>
                <span class="cell current">{currentOf(offer)}</span>
                <span class="cell offered">{availableOf(offer)}</span>
                <div class="notes">
                  {#if status !== null}
                    <p class="status" class:warn={offer.availability.kind === "downgrade"}>{status}</p>
                  {/if}
                  {#if offer.type === "base"}
                    <!-- Said before install as well as after, because it is the thing to know going in. The two
                     kinds of base mod need different sentences: one replaces this installation and the other
                     leaves it alone, so the way back differs as much as the install does - and the folder one
                     of them makes is this installation itself once that folder is on the list. -->
                    <p class="status">
                      {offer.creates && isThisInstall(offer)
                        ? "ZAX will not remove it: what it installs is this whole game, which is a folder to delete by hand."
                        : offer.creates
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
                {#if installLabel(offer) !== null}
                  {@const refusal = installRefusal(offer)}
                  <button
                    class="primary"
                    disabled={refusal !== null || store.busy !== null || !store.modsSettled}
                    title={refusal ?? store.busyReason ?? store.modsUnsettled}
                    onclick={() => void store.prepareMod(offer)}
                  >
                    {installButtonLabel(offer)}
                  </button>
                {/if}
                <div class="offer-actions">
                  <!-- Beside the button that names one version rather than replacing it: the head of the line is
                     what most installs want, and picking another is the deliberate act. Disabled rather than
                     hidden where the list cannot be read, as the sfall panel's buttons are. -->
                  {#if installLabel(offer) !== null && installRefusal(offer) === null}
                    <button
                      disabled={isPreview || store.busy !== null || !store.modsSettled}
                      title={isPreview ? PREVIEW_FEEDS : (store.busyReason ?? store.modsUnsettled)}
                      onclick={() => void openVersions(offer)}
                    >
                      {store.busy === `Reading the ${offer.name} versions` ? "Reading..." : "Other version"}
                    </button>
                  {/if}
                  {#if offer.availability.kind === "retry"}
                    <button
                      disabled={store.busy !== null || !store.modsSettled}
                      title={store.busyReason ?? store.modsUnsettled}
                      onclick={() => void store.restoreMod(offer)}
                    >
                      {store.modWorking(offer.id, "restore") ? "Restoring..." : "Restore"}
                    </button>
                  {/if}
                  {#if removable(offer)}
                    <button
                      class="danger"
                      disabled={store.busy !== null || !store.modsSettled}
                      title={store.busyReason ?? store.modsUnsettled}
                      onclick={() => void store.removeMod(offer)}
                    >
                      {store.modWorking(offer.id, "remove") ? "Removing..." : "Remove"}
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
            {#each store.modListing.failures as failure (failure.id)}
              {@const icon = MOD_ICON[failure.id]}
              <div class="offer failure">
                {#if icon}
                  <img class="mod-icon" src={icon} alt="" width="64" height="34" />
                {:else}
                  <span class="mod-icon"></span>
                {/if}
                <div class="about">
                  <span class="mod-name">{failure.name}</span>
                  <p class="status">{failure.why}</p>
                </div>
              </div>
            {/each}
          </div>
          {#if store.modListing.offers.length === 0 && store.modListing.failures.length === 0}
            <p class="empty">No mod feeds are known for this game yet.</p>
          {/if}
        {/if}
      {:else if store.modsTab === "fission"}
        <!-- The same caution the engine list and the launch carry, over the list it is about: this tab is the
           one place the consequence is visible as a list rather than as a sentence. -->
        {#if store.fissionEngine?.caution}
          <div class="caution-slot">
            <EngineCaution text={store.fissionEngine.caution} title="What Fission will load" />
          </div>
        {/if}
        <div class="list">
          {#each store.fissionMods as mod (mod.name)}
            <!-- Read-only: the order file this reflects is sfall's, and Fission rewrites its own from a folder
               scan at every start, so a tick here would promise something no file could keep. The Load order
               tab is where the list is edited. -->
            <!-- No enabled state on these rows, unlike the load order's: the tick there is a comment marker in
               a file Fission does not read, and its folder scan finds a commented-out dat exactly as it finds
               any other. Dimming one here would report an sfall fact as a Fission one. -->
            <div class="mod">
              <span class="name">{mod.name}</span>
              <span class="badge">{KIND_LABEL[mod.kind]}</span>
              {#if mod.owner}
                <span class="owner">{mod.owner}</span>
              {/if}
            </div>
          {:else}
            <p class="empty">
              Nothing in this install's <code>mods</code> folder is named the way Fission needs. It would start with no mods
              loaded.
            </p>
          {/each}
        </div>
        <!-- What Fission cannot see, named rather than left out. A list quietly missing half the folder reads as
           the folder being half empty, which is the wrong conclusion to lead someone to. -->
        {#if store.fissionMissed.length > 0}
          <div class="missed">
            <p class="missed-head">
              {store.fissionMissed.length === 1 ? "One entry is" : `${store.fissionMissed.length} entries are`} in the mods
              folder and will not load under Fission:
            </p>
            <div class="list">
              {#each store.fissionMissed as mod (mod.name)}
                <div class="mod skipped">
                  <span class="name">{mod.name}</span>
                  <span class="badge">{KIND_LABEL[mod.kind]}</span>
                  {#if mod.owner}
                    <span class="owner">{mod.owner}</span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
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
              {#each group.settings.filter((def) => ownTarget(def).section === activeSection(group)) as def (def.id)}
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

    <!-- Why the rows cannot be acted on, over them rather than above them. Held out of the flow on purpose:
       in the flow it took its height from the list on every switch of game, so the rows it describes jumped
       down and back for the length of one read. The tab under it is dimmed and inert for the same moment,
       which is the part that says "not yet" without a control having to be read one at a time. -->
    {#if unsettled}
      <div class="reading">
        <p role="status">{unsettled}</p>
      </div>
    {/if}
  </main>
</div>

<!-- Asked before anything is downloaded, and only when the choice cannot be carried over from the record:
     a first install, or a release that took away what was chosen. The plan dialog follows it as always. -->
<!--
  Other releases of the same line, for an install that wants one that is not the newest. The answer comes from
  the backend, where the line that orders these versions is known. For a base mod nothing older than what is
  installed is in the list, its installer having no way back down; for anything else older releases are there,
  since replacing files in the mods folder goes either way.
-->
<Dialog open={store.modVersionPick !== null} title="Install another version" dismiss={closeVersions}>
  {#if store.modVersionPick}
    {@const pick = store.modVersionPick}
    <select class="pick" aria-label="Version" bind:value={wantedVersion} disabled={pick.versions.length === 0}>
      {#each pick.versions as version (version)}
        <option value={version}>{version}{version === pick.offer.version ? " (newest)" : ""}</option>
      {:else}
        <option value="">{pick.read ? "Nothing else to install" : "Reading the list..."}</option>
      {/each}
    </select>
    <p class="plan-lead">
      {pick.offer.name} is installed from the release you pick here, the same way the button beside the row installs the newest
      one.
    </p>
  {/if}
  {#snippet footer()}
    <button onclick={closeVersions}>Cancel</button>
    <button
      class="primary"
      disabled={wantedVersion === "" || store.busy !== null}
      title={store.busyReason}
      onclick={() => {
        const held = store.modVersionPick;
        const version = wantedVersion;
        closeVersions();
        if (held) void store.prepareMod(held.offer, undefined, undefined, version);
      }}
    >
      Install {wantedVersion}
    </button>
  {/snippet}
</Dialog>

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
             refusal from the install rather than an answer. The placeholder names the file the picker opens
             on, since what comes back is the folder around it rather than the file itself. -->
          <input type="text" readonly value={answers[input.id] ?? ""} placeholder="Find {input.holds}" />
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

  /* The gutter the rows carry, so the block lines up with the names under it rather than with the pane edge. */
  .caution-slot {
    padding: 8px var(--gutter) 0;
  }

  .missed {
    margin-top: 14px;
    border-top: 1px solid var(--border);
  }

  .missed-head {
    margin: 0;
    padding: 10px var(--gutter) 4px;
    font-size: 12.5px;
    color: var(--text-dim);
  }

  /*
    Struck through as a missing entry is, and for the same reason: the row names something the engine will not
    load. Not the invalid red - nothing here is broken, these mods work under sfall - and the rule carries the
    state where colour alone would not.
  */
  .skipped .name {
    text-decoration: line-through;
    color: var(--text-dim);
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

  /* The frame the message is placed against, so it follows the tab rather than the list's scroll position. */
  main {
    position: relative;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* What the rows are while the reading is out: still legible, so the message can say they are the game left
     behind, but plainly not the surface being offered. `inert` on the element is what actually refuses them. */
  .dimmed {
    opacity: 0.4;
    filter: saturate(0.6);
  }

  /*
    Why the rows cannot be acted on, over the tab rather than in its flow. Carries the accent bar the frame
    titles use rather than a warning colour: nothing has gone wrong, ZAX is still reading.

    Near the top rather than centred: the message belongs to the rows it is about, and a sentence floating in
    the middle of a long list reads as a dialog waiting for an answer. Clear of the column headings, though -
    a heading covered over reads as a defect where a covered row reads as the float it is.
  */
  .reading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 96px var(--gutter) 0;
    /* The dimmed tab underneath is the signal; this layer only carries the sentence. */
    pointer-events: none;
  }

  .reading p {
    margin: 0;
    max-width: 46ch;
    padding: 10px 14px;
    border-left: 3px solid var(--accent);
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--text);
    font-size: 13px;
    /* An outline rather than a shadow: nothing else in ZAX casts one, and the dimmed rows behind this are
       what separates it - the border only has to hold where a row happens to sit right under it. */
    outline: 1px solid var(--border-strong);
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

  /*
    One grid for the whole list rather than one per row. The actions column is sized by its content, so a row
    that sizes it alone puts its version columns wherever its own buttons end - the rows subgrid onto these
    tracks instead, which is what makes the two columns and their heading line up down the list.

    The icon keeps its column even where a feed has none, so the names of two rows still line up rather than
    stepping in and out with whichever mods happen to ship art. Wide enough for the one project whose mark is
    a banner rather than a disc, since a track sized to the discs renders that one as an unreadable strip.

    The slack goes to the empty track after the version columns rather than to the name, which is what keeps
    Mod, Current and Available where they are from one game to the next. Taking it, the name grew by whatever
    a game's buttons did not need, and a game offering no install at all collapsed both button tracks and
    moved the version columns a quarter of the pane.

    Its ceiling is what makes that hold, so it sits under the narrowest room any game leaves and above the
    longest name beside its badge - the version columns are cut to their own widest word to afford both. The
    buttons stay sized to their text: the longest label names a version, and no fixed track can promise to
    hold one.
  */
  .offers {
    display: grid;
    grid-template-columns: 64px minmax(0, 19rem) 6.75rem 6.75rem minmax(0, 1fr) auto auto;
    column-gap: 12px;
    padding: 0 var(--gutter);
  }

  /* The gutter is the list's: a subgrid's own horizontal padding shifts its tracks off the parent's lines. */
  .offer {
    display: grid;
    grid-template-columns: subgrid;
    grid-column: 1 / -1;
    align-items: center;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
  }

  .about {
    min-width: 0;
    grid-column: 2;
    grid-row: 1;
  }

  /* The two version columns. Monospace, so the numbers line up down a column as well as across a row. */
  .cell {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
    grid-row: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .current {
    grid-column: 3;
  }

  .offered {
    grid-column: 4;
  }

  /* Under the name and across the columns' room, so a long sentence does not squeeze the name's track. */
  .notes {
    grid-column: 2 / -1;
    grid-row: 2;
    min-width: 0;
  }

  .head {
    padding-top: 6px;
    padding-bottom: 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }

  /* A feed that could not answer has nothing to put in the version columns, so its reason takes their room. */
  .failure .about {
    grid-column: 2 / -1;
  }

  /*
    One box, two shapes: contain letterboxes rather than stretching or cropping, so a disc fills the height at
    its own aspect and the banner fills the width at its.
  */
  .mod-icon {
    grid-column: 1;
    grid-row: 1;
    width: 64px;
    height: 34px;
    object-fit: contain;
    border-radius: 4px;
  }

  /* Dimmed with the rest of a refused row - a full-strength icon reads as the one live thing in it. */
  .refused .mod-icon {
    opacity: 0.45;
  }

  .mod-name {
    font-weight: 600;
  }

  /*
    A row nothing can be done with reads as one tone throughout. The name is all this sets: the version, the
    badge and the status beneath are already the faint tone, so dimming the name is what makes the row uniform,
    and fading the whole thing further would put the sentence explaining the refusal under 4.5:1.
  */
  .refused .mod-name {
    color: var(--text-dim);
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

  /*
    A track of its own, so every install button is the width of the widest one in the list rather than of its
    own label - one grid means the track is sized once for all the rows. Stretched into it for the same reason:
    a button sized to its text would leave the track it was measured for.
  */
  .primary {
    grid-column: 6;
    grid-row: 1;
    justify-self: stretch;
  }

  .offer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-self: end;
    grid-column: 7;
    grid-row: 1;
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
