<script lang="ts">
  import { LAYOUT } from "@zax/fallout2";
  import LayoutNodes from "./LayoutNodes.svelte";
  import SettingRow from "./SettingRow.svelte";
  import WinePanel from "./WinePanel.svelte";
  import { store } from "./store.svelte.js";

  const file = $derived(LAYOUT.find((f) => f.file === store.settingsTab));
  const tab = $derived(file ? (store.fileTab[file.file] ?? file.tabs[0]?.title ?? "") : "");
  const items = $derived(file?.tabs.find((t) => t.title === tab)?.items ?? []);
  const searching = $derived(store.query.trim() !== "");
</script>

<div class="pane" class:searching={searching}>
  <div class="tabbar">
    <div class="tabs" role="tablist">
      {#each LAYOUT as f (f.file)}
        <button
          role="tab"
          class="tab"
          aria-selected={store.settingsTab === f.file}
          title={f.file}
          onclick={() => (store.settingsTab = f.file)}
        >
          {f.label}
          {#if store.modifiedInFile(f.file) > 0}
            <!-- Hidden from the accessible name, which is the tab's label - the count belongs in the tooltip. -->
            <span class="dot" aria-hidden="true" title="{store.modifiedInFile(f.file)} unsaved"></span>
          {/if}
        </button>
      {/each}
      <!-- The previous interface hid this tab entirely on Windows rather than disabling it. -->
      {#if store.wineAvailable}
        <button
          role="tab"
          class="tab"
          aria-selected={store.settingsTab === "wine"}
          onclick={() => (store.settingsTab = "wine")}
        >
          Wine
        </button>
      {/if}
    </div>
  </div>

  {#if file}
    <div class="subtabs" role="tablist">
      {#each file.tabs as t (t.title)}
        <button
          role="tab"
          class="subtab"
          aria-selected={tab === t.title}
          onclick={() => (store.fileTab = { ...store.fileTab, [file.file]: t.title })}
        >
          {t.title}
        </button>
      {/each}
    </div>
  {/if}

  <main>
    <div class="list">
      {#if searching}
        {#if store.wineMatches}
          <button class="found" onclick={() => { store.settingsTab = "wine"; store.query = ""; }}>Wine</button>
          <WinePanel />
        {/if}
        <!--
          A flat list across every file and tab: the point of searching is to find a setting whose tab you do
          not know, so each result carries its own address and a way to go there.
        -->
        {#each store.results as r, i (r.def.id)}
          <!-- Grouped under the address they came from, so a run of results reads as the tab it belongs to
               rather than as one badge repeated down the column. -->
          {#if r.where !== store.results[i - 1]?.where}
            <button class="found" onclick={() => store.goTo(r.place)}>{r.where}</button>
          {/if}
          <SettingRow def={r.def} />
        {:else}
          {#if !store.wineMatches}
            <p class="empty">Nothing matches "{store.query}".</p>
          {/if}
        {/each}
      {:else if file}
        <LayoutNodes {items} />
      {:else}
        <WinePanel />
      {/if}
    </div>

    <!--
      Both sat under the settings tabs in the previous interface, not in the window chrome. Disabled rather
      than wired to something that clears the pending edits: that would look exactly like a successful write.
    -->
    <div class="footer">
      <button class="primary" disabled title="Needs the desktop build - the preview cannot write config files">
        Save
      </button>
      <button disabled title="Needs the desktop build - the preview cannot launch the game">Play</button>
      {#if store.modifiedCount > 0}
        <span class="pending">{store.modifiedCount} unsaved</span>
        <button class="link" onclick={() => store.revertAll()}>Revert all</button>
      {/if}
      <span class="unavailable">saving needs the desktop build</span>
    </div>
  </main>
</div>

<style>
  /* While searching, the tab strips no longer describe what is on screen. */
  .searching :global(.tab[aria-selected="true"]),
  .searching :global(.subtab[aria-selected="true"]) {
    opacity: 0.5;
  }

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



  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--modified);
  }

  .footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px var(--gutter);
    border-top: 1px solid var(--border);
    background: var(--panel);
    flex: 0 0 auto;
  }

  .footer button {
    background: var(--panel-alt);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 4px 16px;
    color: var(--text);
  }

  .footer .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 550;
  }

  .footer button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .pending {
    color: var(--modified);
    font-size: 12.5px;
  }

  .link {
    background: none;
    border: none;
    padding: 0;
    font-size: 12.5px;
    color: var(--accent);
    text-decoration: underline;
  }

  .unavailable {
    margin-left: auto;
    color: var(--text-faint);
    font-size: 12px;
  }
</style>
