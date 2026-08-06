<script lang="ts">
  import { isPreview, PREVIEW_REASON } from "./host.js";
  import { store } from "./store.svelte.js";

  let { file, label }: { file: string; label: string } = $props();

  /*
    A tab whose file the install does not have is shown rather than hidden. The previous interface disabled it,
    which said the tab was unavailable but not why or what to do; and its settings grid would otherwise write a
    config file for a component that is not there. What replaces the grid is the way to get the component.
  */
  const WHAT: Record<string, { what: string; why: string }> = {
    "ddraw.ini": {
      what: "sfall is not installed.",
      why: "sfall is the engine patch these settings belong to. Installing it writes ddraw.ini beside the game.",
    },
    "f2_res.ini": {
      what: "The High Resolution Patch is not installed.",
      why: "It is what lets the game run above 640x480. It is distributed from a forum thread rather than a release feed, so it is downloaded and run by hand.",
    },
    "fallout2.cfg": {
      what: "The game has no configuration file yet.",
      why: "Fallout 2 writes fallout2.cfg the first time it runs. Launch the game once and come back.",
    },
  };

  const detail = $derived(WHAT[file]);
</script>

<div class="missing">
  <h2>{detail?.what ?? `${label} has no configuration file.`}</h2>
  <p>{detail?.why ?? ""}</p>

  {#if file === "ddraw.ini"}
    <button
      disabled={isPreview || store.busy !== null}
      title={isPreview ? PREVIEW_REASON : null}
      onclick={() => void store.installSfall()}
    >
      {store.busy === "Installing sfall" ? "Installing..." : "Install the latest sfall"}
    </button>
  {:else if file === "f2_res.ini"}
    <button disabled={isPreview} title={isPreview ? PREVIEW_REASON : null} onclick={() => void store.open("hires")}>
      Open the download page
    </button>
  {/if}
</div>

<style>
  .missing {
    padding: 22px var(--gutter);
    max-width: 62ch;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 14px;
    font-weight: 600;
  }

  p {
    margin: 0 0 14px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text-dim);
  }

  button {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 4px 14px;
    color: var(--text);
    font-size: 12.5px;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
