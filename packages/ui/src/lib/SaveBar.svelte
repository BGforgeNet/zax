<script lang="ts">
  import { isPreview } from "./host.js";
  import { store } from "./store.svelte.js";
</script>

<!--
  Both sat under the settings tabs in the previous interface, not in the window chrome. One bar shared by every
  view rather than one per view: Save writes the config files and the mod order together, and a second button
  that wrote only half of that would be a different Save wearing the same word.
-->
<div class="footer">
  <!-- Disabled rather than hidden under autosave: a button that vanished would move Play under the pointer. -->
  <button
    class="primary"
    disabled={store.autosave || !store.install || store.modifiedCount === 0 || store.busy !== null}
    title={store.autosave ? "Autosave is on - every change is written as it is made" : null}
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
    <button class="link" onclick={() => store.revertAll()}>Revert all</button>
  {/if}

  <!-- Status rather than an action, so it sits away from the buttons at the far end of their own bar. -->
  <div class="spacer"></div>
  {#if store.modifiedCount > 0}
    <span class="chip">{store.modifiedCount} unsaved</span>
  {:else}
    <span class="chip muted">No changes</span>
  {/if}
</div>

<style>
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

  .link {
    background: none;
    border: none;
    padding: 0;
    font-size: 12.5px;
    color: var(--accent);
    text-decoration: underline;
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
    white-space: nowrap;
  }

  .chip.muted {
    border-color: var(--border);
    color: var(--text-faint);
    background: none;
  }
</style>
