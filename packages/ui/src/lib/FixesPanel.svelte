<script lang="ts">
  import ActionCard from "./ActionCard.svelte";
  import { store } from "./store.svelte.js";

  // Actions that repair a symptom, as opposed to a setting you choose. Each writes several keys at once, which
  // is the whole reason it exists as one button rather than as the settings it happens to touch.
  const FIXES = ["fix.not-responding"];
  const fixes = $derived(FIXES.map((id) => store.actionById(id)).filter((a) => a !== undefined));
</script>

<div class="list">
  <p class="intro">One click each, for a game that misbehaves in a known way.</p>

  <!-- The action only; the settings behind it stay on their own tabs rather than being listed twice. -->
  {#each fixes as fix (fix.id)}
    <ActionCard action={fix} />
  {:else}
    <p class="empty">No fixes apply to this install.</p>
  {/each}
</div>

<style>
  .intro {
    padding: 12px var(--gutter) 0;
    color: var(--text-dim);
    font-size: 12.5px;
  }
</style>
