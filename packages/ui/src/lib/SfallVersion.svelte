<script lang="ts">
  /*
    The previous interface showed the installed sfall version beside the latest release, with a check and an
    update button. The installed one is read from ddraw.dll and needs no network; the latest one does, which is
    the half the browser preview cannot do.
  */
  import Dialog from "./Dialog.svelte";
  import { isPreview } from "./host.js";
  import { store } from "./store.svelte.js";

  const OUTSIDE = "The browser preview cannot reach the release feed - this needs the desktop build";

  let changing = $state(false);
  let wanted = $state("");

  function open() {
    changing = true;
    wanted = store.sfallInstalled ?? "";
    void store.loadSfallVersions();
  }
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
        title={store.sfallOutdated
          ? "Replace the installed sfall, keeping your settings"
          : "Nothing newer has been found"}
        onclick={() => void store.updateSfall()}
      >
        Update
      </button>
      <!-- Going back matters as much as going forward: mods pin particular sfall versions. -->
      <button
        disabled={isPreview || !store.install || store.busy !== null}
        title={isPreview ? OUTSIDE : null}
        onclick={open}
      >
        Change version
      </button>
    </span>
    <!--
      Kept in the layout whether or not it applies: a check that finds a newer release, or an update that
      clears one, would otherwise grow or shrink this row and move every row under it.
    -->
    <span class="help carried" class:applies={store.sfallOutdated}>
      Your settings are carried into the new ddraw.ini, and replaced files are backed up.
    </span>
  </div>
</div>

<!--
  In a dialog rather than inside the row: opened in place it grew the row and pushed every setting below it
  down. A dialog is drawn in the top layer, so it costs the page no height and nothing can clip it - which an
  absolutely positioned panel could not promise inside the scrolling settings pane.
-->
<Dialog open={changing} title="Change the sfall version" dismiss={() => (changing = false)}>
  <select class="pick" aria-label="sfall version" bind:value={wanted} disabled={store.sfallVersions.length === 0}>
    {#each store.sfallVersions as version (version)}
      <option value={version}>{version}{version === store.sfallInstalled ? " (installed)" : ""}</option>
    {:else}
      <option value="">Reading the list...</option>
    {/each}
  </select>
  <p class="explain">
    Files a newer release added are left in place. Settings are merged against what the installed version shipped, so
    defaults you never changed follow the release you move to.
  </p>
  {#snippet footer()}
    <button onclick={() => (changing = false)}>Cancel</button>
    <button
      disabled={wanted === "" || wanted === store.sfallInstalled || store.busy !== null}
      onclick={() => void store.changeSfall(wanted, `Changing sfall to ${wanted}`).then(() => (changing = false))}
    >
      Apply
    </button>
  {/snippet}
</Dialog>

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

  .carried {
    visibility: hidden;
  }

  .carried.applies {
    visibility: visible;
  }

  .pick {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 4px 7px;
    color: var(--text);
    font-size: 12.5px;
  }

  .explain {
    margin: 8px 0 0;
    font-size: 12.5px;
    color: var(--text-dim);
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
