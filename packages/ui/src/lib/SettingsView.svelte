<script lang="ts">
  import { ENGINES, LAYOUT, SETTINGS } from "@zax/fallout2";
  import BugReportPanel from "./BugReportPanel.svelte";
  import FixesPanel from "./FixesPanel.svelte";
  import HiresVersion from "./HiresVersion.svelte";
  import LayoutNodes from "./LayoutNodes.svelte";
  import LinkedChoices from "./LinkedChoices.svelte";
  import SettingRow from "./SettingRow.svelte";
  import InstallPanel from "./InstallPanel.svelte";
  import Unavailable from "./Unavailable.svelte";
  import { store } from "./store.svelte.js";

  // A fix is one click and a report is a sequence you work through, so they stay apart.
  const TROUBLE_TABS = [
    { id: "report", title: "Bug report" },
    { id: "fixes", title: "Fixes" },
  ] as const;

  const offered = $derived(store.settingsGroups);
  const here = $derived(offered.find((one) => one.group.id === store.settingsTab));
  const file = $derived(here?.group);
  const refusal = $derived(here?.refusal ?? null);
  const tab = $derived(file ? (store.fileTab[file.id] ?? file.tabs[0]?.title ?? "") : "");
  // A group's own name in the tooltip: the filename for the game's three, the engine's full name for the rest,
  // since "fallout2-ce" is the id a person would have to already know.
  const nameOf = (f: (typeof LAYOUT)[number]) =>
    f.engine === undefined ? f.id : (ENGINES.find((e) => e.id === f.engine)?.name ?? f.engine);
  const items = $derived(file?.tabs.find((t) => t.title === tab)?.items ?? []);
  // The search box lives on the "all settings" tab; the window still focuses it with Ctrl-F.
  let searchBox = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (store.searchRequest > 0 && store.settingsTab === "all") {
      searchBox?.focus();
      searchBox?.select();
    }
  });
</script>

<div class="pane">
  <div class="tabbar">
    <div class="tabs" role="tablist">
      {#each offered as { group: f, refusal: why } (f.id)}
        <button
          role="tab"
          class="tab"
          aria-selected={store.settingsTab === f.id}
          title={why ?? nameOf(f)}
          onclick={() => (store.settingsTab = f.id)}
        >
          {f.label}
          <!--
            Always in the markup, shown or not: appearing on the first edit would widen the tab and shove every
            tab after it sideways while the pointer is still over one. Hidden from the accessible name, which is
            the tab's label - the count belongs in the tooltip.
          -->
          <span
            class="dot"
            class:unsaved={store.modifiedInGroup(f.id) > 0}
            aria-hidden="true"
            title={store.modifiedInGroup(f.id) > 0 ? `${store.modifiedInGroup(f.id)} unsaved` : null}
          ></span>
        </button>
      {/each}
      <!-- Always shown, unlike the Wine tab it replaced: an install has an alias on every platform. -->
      <button
        role="tab"
        class="tab"
        aria-selected={store.settingsTab === "install"}
        onclick={() => (store.settingsTab = "install")}
      >
        Install
      </button>
      <!--
        A tab rather than the top-level switch it used to be. Its fixes write the same config files as every
        other tab, so it belongs beside them and under the same Save, which the separate view had no room for.
      -->
      <button
        role="tab"
        class="tab"
        aria-selected={store.settingsTab === "trouble"}
        onclick={() => (store.settingsTab = "trouble")}
      >
        Troubleshooting
      </button>
      <!-- The whole catalog, flat. Its own tab rather than a mode that took over whichever tab you were on. -->
      <button
        role="tab"
        class="tab"
        aria-selected={store.settingsTab === "all"}
        onclick={() => (store.settingsTab = "all")}
      >
        All settings
      </button>
    </div>
  </div>

  {#if file}
    <div class="subtabs" role="tablist">
      {#each file.tabs as t (t.title)}
        <button
          role="tab"
          class="subtab"
          aria-selected={tab === t.title}
          onclick={() => (store.fileTab = { ...store.fileTab, [file.id]: t.title })}
        >
          {t.title}
        </button>
      {/each}
    </div>
  {:else if store.settingsTab === "trouble"}
    <div class="subtabs" role="tablist">
      {#each TROUBLE_TABS as t (t.id)}
        <button
          role="tab"
          class="subtab"
          aria-selected={store.troubleTab === t.id}
          onclick={() => (store.troubleTab = t.id)}
        >
          {t.title}
        </button>
      {/each}
    </div>
  {/if}

  <main>
    <div class="list">
      <!-- Above whichever tab of settings is open, rather than on the one the setting happens to live on: the
           value is about to be lost either way, and an answer is wanted before anything here is saved. -->
      {#if file || store.settingsTab === "all"}
        <LinkedChoices />
      {/if}
      {#if store.settingsTab === "all"}
        <!--
          Every setting in one flat list, whatever tab it normally lives on. Each carries its own address and a
          way to go there, since finding one here means not knowing which component owns it.
        -->
        <div class="find">
          <input
            bind:this={searchBox}
            type="search"
            placeholder="Filter by name, key, section or tab"
            aria-label="Filter settings"
            bind:value={store.query}
          />
          <!-- Only while narrowing: with nothing typed, a count against the catalog total reads as a filter
               being applied, when what is on screen is everything the layout places. -->
          {#if store.query.trim() !== ""}
            <span class="count">{store.results.length} of {SETTINGS.length}</span>
          {/if}
        </div>
        {#if store.installMatches}
          <button
            class="found"
            onclick={() => {
              store.settingsTab = "install";
              store.query = "";
            }}>Install</button
          >
          <InstallPanel />
        {/if}
        {#each store.results as r, i (r.def.id)}
          <!-- Grouped under the address they came from, so a run of rows reads as the tab it belongs to
               rather than as one badge repeated down the column. -->
          {#if r.where !== store.results[i - 1]?.where}
            <button class="found" onclick={() => store.goTo(r.place)}>{r.where}</button>
          {/if}
          <SettingRow def={r.def} />
        {:else}
          {#if !store.installMatches}
            <p class="empty">Nothing matches "{store.query}".</p>
          {/if}
        {/each}
      {:else if file}
        <!-- The rows stay on screen and refuse input either way, whether what is missing is the config file or
             the engine's own first run. Hiding them would answer "what can this engine do" with a blank pane. -->
        {#if refusal}
          <Unavailable reason={refusal} />
        {:else if store.install && file.engine === undefined && !store.hasFile(file.id)}
          <Unavailable file={file.id} />
        {/if}
        <!--
          The hi-res patch's version, which the previous interface never showed and so has no place in the
          generated layout. It goes where sfall's does - the top of the file's first tab - rather than above
          every tab, and only once there is an f2_res.ini to say anything about.
        -->
        {#if file.id === "f2_res.ini" && tab === file.tabs[0]?.title && store.hasFile(file.id)}
          <HiresVersion />
        {/if}
        <LayoutNodes {items} group={file.id} />
      {:else if store.settingsTab === "trouble"}
        {#if store.troubleTab === "report"}<BugReportPanel />{:else}<FixesPanel />{/if}
      {:else}
        <InstallPanel />
      {/if}
    </div>
  </main>
</div>

<style>
  /* Same band as a frame heading, because that is what it is: the group a result was found in. */
  .found {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px var(--gutter);
    border-left: 3px solid var(--accent);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text);
    background: var(--band);
    border: none;
    border-top: 1px solid var(--border-strong);
    border-bottom: 1px solid var(--border-strong);
  }

  .found:hover {
    color: var(--accent);
  }

  /* The filter sits with the list it filters, not in the window chrome, so it is clear what it narrows. */
  .find {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px var(--gutter);
    border-bottom: 1px solid var(--border);
  }

  .find input {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 4px 10px;
    color: var(--text);
  }

  .find .count {
    flex: 0 0 auto;
    font-size: 11.5px;
    color: var(--text-faint);
  }

  /* Holds its space in every tab; only its ink toggles, so the strip never re-lays-out on an edit. */
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
</style>
