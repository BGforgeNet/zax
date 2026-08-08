<script lang="ts">
  import { isPreview, PREVIEW_REASON } from "./host.js";
  import { store } from "./store.svelte.js";

  let { file }: { file: string } = $props();

  /*
    A tab whose config file the install does not have keeps its settings on screen, read-only: the previous
    interface disabled the whole tab, which said it was unavailable but not why. Editing is what stays off,
    because saving would write a config file for a component that is not there.

    Only sfall is offered for installation. The hi-res patch is distributed from a forum thread rather than a
    release feed, so there is nothing to install it from.
  */
  const WHAT: Record<string, string> = {
    "ddraw.ini": "sfall is not installed, so these settings are not in effect and cannot be edited.",
    "fallout2.cfg": "The game has not written its configuration file yet. It does that the first time it runs.",
  };

  // The patch's own library is what says whether it is there, so a config file missing beside an installed
  // patch is a different situation from one missing because nothing installed it.
  const hires = $derived(
    store.hiresInstalled
      ? `The High Resolution Patch ${store.hiresInstalled} is installed, but its f2_res.ini is not in the game folder.`
      : "The High Resolution Patch is not installed, so these settings are not in effect and cannot be edited.",
  );
</script>

<div class="missing" role="status">
  <span>
    {file === "f2_res.ini" ? hires : (WHAT[file] ?? "This file is not in the game folder, so its settings cannot be edited.")}
  </span>
  {#if file === "ddraw.ini"}
    <button
      disabled={isPreview || store.busy !== null}
      title={isPreview ? PREVIEW_REASON : null}
      onclick={() => void store.installSfall()}
    >
      {store.busy === "Installing sfall" ? "Installing..." : "Install the latest sfall"}
    </button>
  {/if}
</div>

<style>
  .missing {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    padding: 9px var(--gutter);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
    color: var(--text);
  }

  button {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 2px 11px;
    color: var(--text);
    font-size: 12px;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
