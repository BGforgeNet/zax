<script lang="ts">
  import BugReportPanel from "./BugReportPanel.svelte";
  import FixesPanel from "./FixesPanel.svelte";
  import { store } from "./store.svelte.js";

  // Two things a broken game needs, kept apart: a fix is one click, a report is a sequence you work through.
  const TABS = [
    { id: "report", title: "Bug report" },
    { id: "fixes", title: "Fixes" },
  ] as const;
</script>

<div class="pane">
  <div class="subtabs tabbar-edge" role="tablist">
    {#each TABS as t (t.id)}
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

  <main>
    {#if store.troubleTab === "report"}<BugReportPanel />{:else}<FixesPanel />{/if}
  </main>
</div>

<style>
  /* Sits directly under the window header here, where Settings has a file-tab strip above it. */
  .tabbar-edge {
    background: var(--panel);
    padding-top: 2px;
  }
</style>
