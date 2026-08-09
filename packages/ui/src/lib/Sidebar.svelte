<script lang="ts">
  import GamesPanel from "./GamesPanel.svelte";
  import ZaxPanel from "./ZaxPanel.svelte";
  import { store } from "./store.svelte.js";
</script>

<!--
  A permanent column rather than a destination you navigate to, as the previous implementation had it: which
  install you are editing is context for every other screen, and picking one should not cost you your place in
  the settings. It also spends width that the capped content column was leaving empty.
-->
<aside class="sidebar">
  <div class="tabbar">
    <div class="tabs" role="tablist">
      <button role="tab" class="tab" aria-selected={store.panel === "games"} onclick={() => (store.panel = "games")}>
        Games
        <span class="count">{store.installs.length}</span>
      </button>
      <button role="tab" class="tab" aria-selected={store.panel === "zax"} onclick={() => (store.panel = "zax")}>
        ZAX
      </button>
    </div>
  </div>

  <div class="body">
    {#if store.panel === "games"}<GamesPanel />{:else}<ZaxPanel />{/if}
  </div>
</aside>

<style>
  .sidebar {
    /* Wide enough for a mod name beside its badge, and it does not grow with the window. */
    flex: 0 0 var(--sidebar);
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* Bordered on both sides now that it no longer runs into the window's edge. */
    border-inline: 1px solid var(--border);
    background: var(--panel-alt);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* The shared strip centres its content on the pane's gutter, which is wrong in a 264px column. */
  .tabs {
    padding-inline: var(--tab-inset);
  }

  /* Below this the settings pane is at its own minimum and the column has to go, or the two would overlap. */
  @media (max-width: 820px) {
    .sidebar {
      display: none;
    }
  }
</style>
