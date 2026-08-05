<script lang="ts">
  import SettingsView from "./lib/SettingsView.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import TroubleView from "./lib/TroubleView.svelte";
  import { store } from "./lib/store.svelte.js";

  // The palette reads the used color-scheme, so applying a theme is one attribute on the root element.
  // "system" removes it rather than pinning a value, or the choice would stop following the OS.
  $effect(() => {
    const root = document.documentElement;
    if (store.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", store.theme);
  });

  let searchBox = $state<HTMLInputElement | null>(null);

  // Ctrl/Cmd-F is what a user reaches for; the browser's own find would search the rendered tab only.
  function onWindowKey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === "f") {
      event.preventDefault();
      store.view = "settings";
      searchBox?.focus();
      searchBox?.select();
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="shell">
  <header class="top">
    <div class="brand">ZAX <span class="version">0.8</span></div>

    <!-- The two the previous interface had at this level, in its order. -->
    <div class="views" role="tablist">
      <button role="tab" aria-selected={store.view === "settings"} onclick={() => (store.view = "settings")}>
        Settings
      </button>
      <button role="tab" aria-selected={store.view === "trouble"} onclick={() => (store.view = "trouble")}>
        Troubleshooting
      </button>
    </div>

    <!--
      Searches every file and tab, not the one on screen: the tabs are the previous interface's, and finding a
      setting in them means already knowing which component owns it.
    -->
    {#if store.view === "settings"}
      <input
        bind:this={searchBox}
        class="search"
        type="search"
        placeholder="Search all settings"
        bind:value={store.query}
      />
    {/if}

    <div class="spacer"></div>

    {#if store.modifiedCount > 0}
      <span class="chip">{store.modifiedCount} unsaved</span>
    {:else}
      <span class="chip muted">No changes</span>
    {/if}
  </header>

  <div class="body">
    <Sidebar />
    {#if store.view === "settings"}<SettingsView />{:else}<TroubleView />{/if}
  </div>
</div>

<style>
  .shell {
    /* The header sits outside the pane, so it needs its own reference for `--gutter`. */
    container-type: inline-size;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 8px 12px;
    padding: 9px var(--gutter);
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }

  /* Everything in the bar holds its size except the search box, or they all shrink together and it wraps. */
  .top > * {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .brand {
    font-weight: 650;
    letter-spacing: 0.02em;
  }

  .version {
    color: var(--text-faint);
    font-weight: 400;
    font-size: 12px;
  }



  .views {
    display: flex;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 2px;
    gap: 2px;
  }

  .views button {
    background: none;
    border: none;
    border-radius: 5px;
    padding: 4px 13px;
    color: var(--text-dim);
    font-size: 12.5px;
  }

  .views button[aria-selected="true"] {
    background: var(--panel);
    color: var(--text);
    font-weight: 550;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
  }

  .search {
    flex: 0 1 260px;
    min-width: 130px;
    background: var(--panel-alt);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 5px 10px;
  }

  .spacer {
    flex: 1;
  }

  .chip {
    border: 1px solid var(--modified);
    color: var(--modified);
    background: var(--modified-soft);
    border-radius: 999px;
    padding: 3px 11px;
    font-size: 12.5px;
  }

  .chip.muted {
    border-color: var(--border);
    color: var(--text-faint);
    background: none;
  }

  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
</style>
