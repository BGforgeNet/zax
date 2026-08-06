<script lang="ts">
  import { LAYOUT } from "@zax/fallout2";
  import BugReportPanel from "./BugReportPanel.svelte";
  import FixesPanel from "./FixesPanel.svelte";
  import LayoutNodes from "./LayoutNodes.svelte";
  import SettingRow from "./SettingRow.svelte";
  import InstallPanel from "./InstallPanel.svelte";
  import MissingFile from "./MissingFile.svelte";
  import { isPreview } from "./host.js";
  import { store } from "./store.svelte.js";

  // A fix is one click and a report is a sequence you work through, so they stay apart.
  const TROUBLE_TABS = [
    { id: "report", title: "Bug report" },
    { id: "fixes", title: "Fixes" },
  ] as const;

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
      {#if searching}
        {#if store.installMatches}
          <button class="found" onclick={() => { store.settingsTab = "install"; store.query = ""; }}>Install</button>
          <InstallPanel />
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
          {#if !store.installMatches}
            <p class="empty">Nothing matches "{store.query}".</p>
          {/if}
        {/each}
      {:else if file}
        <!-- The settings stay on screen when their file is absent; the rows themselves refuse input. -->
        {#if store.install && !store.hasFile(file.file)}
          <MissingFile file={file.file} />
        {/if}
        <LayoutNodes {items} />
      {:else if store.settingsTab === "trouble"}
        {#if store.troubleTab === "report"}<BugReportPanel />{:else}<FixesPanel />{/if}
      {:else}
        <InstallPanel />
      {/if}
    </div>

    <!-- Both sat under the settings tabs in the previous interface, not in the window chrome. -->
    <div class="footer">
      <button
        class="primary"
        disabled={!store.install || store.modifiedCount === 0 || store.busy !== null}
        onclick={() => void store.save()}
      >
        {store.busy === "Saving" ? "Saving..." : "Save"}
      </button>
      <button
        disabled={!store.install || isPreview || store.busy !== null}
        title={isPreview ? "The browser preview cannot start a program - this needs the desktop build" : null}
        onclick={() => void store.play()}
      >
        Play
      </button>
      {#if store.modifiedCount > 0}
        <span class="pending">{store.modifiedCount} unsaved</span>
        <button class="link" onclick={() => store.revertAll()}>Revert all</button>
      {/if}
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

</style>
