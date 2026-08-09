<script lang="ts">
  /*
    The previous interface showed the installed sfall version beside the latest release, with a check and an
    update button. The installed one is read from ddraw.dll and needs no network; the latest one does, which is
    the half the browser preview cannot do.
  */
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
    {#if changing}
      <span class="change">
        <select aria-label="sfall version" bind:value={wanted} disabled={store.sfallVersions.length === 0}>
          {#each store.sfallVersions as version (version)}
            <option value={version}>{version}{version === store.sfallInstalled ? " (installed)" : ""}</option>
          {:else}
            <option value="">Reading the list...</option>
          {/each}
        </select>
        <span class="buttons">
          <button
            disabled={wanted === "" || wanted === store.sfallInstalled || store.busy !== null}
            onclick={() => void store.changeSfall(wanted, `Changing sfall to ${wanted}`).then(() => (changing = false))}
          >
            Apply
          </button>
          <button onclick={() => (changing = false)}>Cancel</button>
        </span>
        <span class="help">
          Files a newer release added are left in place. Settings are merged against what the installed version shipped,
          so defaults you never changed follow the release you move to.
        </span>
      </span>
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

  .carried {
    visibility: hidden;
  }

  .carried.applies {
    visibility: visible;
  }

  .change {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
    margin-top: 6px;
  }

  .change select {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 2px 6px;
    color: var(--text);
    font-size: 12px;
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
