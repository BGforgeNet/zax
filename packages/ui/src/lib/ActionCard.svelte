<script lang="ts">
  import { pendingTargets, type Action } from "@zax/core";
  import { store } from "./store.svelte.js";

  let { action }: { action: Action } = $props();

  const applied = $derived(store.actionApplied(action));
  const pending = $derived(pendingTargets(action, (id) => store.valueOf(id), store.actionWineDebug));
</script>

<article class:applied>
  <div class="text">
    <span class="name">{action.label}</span>
    <span class="desc">{action.description}</span>
  </div>
  {#if applied}
    <span class="done">{action.appliedLabel}</span>
  {:else}
    <button onclick={() => store.applyAction(action)}>Apply</button>
    <span class="count">{pending.length}</span>
  {/if}
</article>

<style>
  article {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px var(--gutter);
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
  }

  article.applied {
    background: none;
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 9px;
  }

  .name {
    font-weight: 600;
    white-space: nowrap;
  }

  .desc {
    color: var(--text-dim);
    font-size: 12px;
  }

  button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 3px 14px;
    font-size: 12.5px;
    font-weight: 550;
  }

  .count {
    font-size: 11px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    min-width: 14px;
  }

  .done {
    font-size: 12px;
    color: var(--text-faint);
    font-style: italic;
    white-space: nowrap;
  }
</style>
