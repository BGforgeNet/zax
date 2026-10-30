<script lang="ts">
  import { store } from "./store.svelte.js";

  /*
    A setting several components share whose value has moved in more than one of them since ZAX last wrote.
    A link cannot be broken, so one of those values is about to be lost - and which one is not something ZAX
    can work out. Both are offered, each named by the file it is in, and nothing is written until one is
    picked. Answering leaves an ordinary pending edit, so it can still be reverted before the save.
  */
</script>

{#each store.settingsChoices as choice (choice.id)}
  <div class="tab-banner choice" role="alert">
    <span class="what">
      <strong>{choice.label}</strong> was changed in more than one place. Which one is right?
    </span>
    {#each choice.options as moved (moved.file)}
      <button onclick={() => store.chooseLinked(choice.id, moved.value)}>
        {moved.label}
        <span class="where">{moved.file}</span>
      </button>
    {/each}
  </div>
{/each}

<style>
  .what {
    flex: 1 1 auto;
  }

  button {
    display: flex;
    align-items: baseline;
    gap: 6px;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 2px 11px;
    color: var(--text);
    font-size: 12px;
  }

  /* The value is the choice; the file says which component it came from, so it reads as the smaller half. */
  .where {
    color: var(--text-faint);
    font-size: 11.5px;
  }
</style>
