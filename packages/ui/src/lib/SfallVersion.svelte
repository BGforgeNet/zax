<script lang="ts">
  /*
    The previous interface showed the installed sfall version beside the latest release, with a check and an
    update button. The installed one is read from ddraw.dll and needs no network; the latest one does, which is
    the half the browser preview cannot do.
  */
  import { isPreview } from "./host.js";
  import { store } from "./store.svelte.js";

  const OUTSIDE = "The browser preview cannot reach the release feed - this needs the desktop build";
</script>

<div class="row">
  <div class="label"><span class="name">sfall version</span></div>
  <div class="control">
    {#if store.sfallInstalled}
      <strong>{store.sfallInstalled}</strong>
    {:else}
      <span class="unknown">{store.install ? "not installed" : "no install selected"}</span>
    {/if}
  </div>
  <div class="notes">
    <span class="help">
      Latest release:
      {#if store.sfallLatest}{store.sfallLatest.version}{:else}<span class="unknown">not checked</span>{/if}
    </span>
    <span class="buttons">
      <button
        disabled={isPreview || store.busy !== null}
        title={isPreview ? OUTSIDE : null}
        onclick={() => void store.checkSfallVersion()}
      >
        Check
      </button>
      <button
        disabled={!store.sfallOutdated || store.busy !== null}
        title={store.sfallOutdated ? "Replace the installed sfall, keeping your settings" : "Nothing newer has been found"}
        onclick={() => void store.updateSfall()}
      >
        Update
      </button>
    </span>
    {#if store.sfallOutdated}
      <span class="help">Your settings are carried into the new ddraw.ini, and replaced files are backed up.</span>
    {/if}
  </div>
</div>

<style>
  .unknown {
    color: var(--text-faint);
    font-style: italic;
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }

  .buttons button {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 2px 11px;
    color: var(--text-dim);
    font-size: 12px;
  }

  .buttons button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
