<script lang="ts">
  /*
    What a first run looks like. Without this the settings pane renders all 166 controls against nothing - every
    row reading "not in your config" and every control editable, with no file behind any of them. The previous
    interface hid both top-level tabs entirely until a game was on the list; this says why instead.
  */
  import { store } from "./store.svelte.js";
</script>

<div class="empty">
  <h2>No game to configure yet</h2>
  <p>ZAX edits the config files inside a Fallout 2 folder, so it needs to know where one is.</p>
  <div class="actions">
    <button class="primary" onclick={() => ((store.panel = "games"), (store.view = "settings"))}>
      Add one from the Games column
    </button>
    <button disabled={store.busy !== null} onclick={() => void store.scan()}>Scan the usual places</button>
  </div>
  {#if store.busy === "Scanning"}<p class="working">Looking...</p>{/if}
</div>

<style>
  .empty {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 40px var(--gutter);
    text-align: center;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  p {
    margin: 0;
    max-width: 46ch;
    color: var(--text-dim);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 8px;
  }

  button {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 4px 14px;
    color: var(--text-dim);
    font-size: 12.5px;
  }

  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .working {
    color: var(--text-faint);
  }
</style>
