<script lang="ts">
  import { onMount } from "svelte";
  import NoInstall from "./lib/NoInstall.svelte";
  import SettingsView from "./lib/SettingsView.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import { store } from "./lib/store.svelte.js";
  import { BUILD } from "./lib/version.js";

  // Reading the state file and the selected install's config files is the first thing that happens, and it is
  // a filesystem read, so the interface renders its empty shape until it lands rather than blocking on it.
  onMount(() => {
    void store.start();
  });

  // The palette reads the used color-scheme, so applying a theme is one attribute on the root element.
  // "system" removes it rather than pinning a value, or the choice would stop following the OS.
  $effect(() => {
    const root = document.documentElement;
    if (store.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", store.theme);
  });

  // Ctrl/Cmd-F opens the tab that lists every setting and focuses its filter; the browser's own find would
  // search the rendered tab only. F2 renames the selected install, at the window rather than on the row.
  function onWindowKey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === "f") {
      event.preventDefault();
      store.searchSettings();
    } else if (event.key === "F2") {
      event.preventDefault();
      store.renameSelected();
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="shell">
  <header class="top">
    <div class="brand">ZAX <span class="version">{BUILD}</span></div>

    <!--
      What is running, for every operation rather than only the ones whose own button changes label. An sfall
      update is minutes of work on a poor connection, and the buttons that start it are in a panel the user may
      well have scrolled away from - without this the whole window simply sat there.

      Between the brand and the spacer, so appearing and disappearing does not move the chip on the right.
    -->
    {#if store.busy}
      <span class="working" role="status">
        <span class="dot" aria-hidden="true"></span>
        {store.progressText ?? store.busy}
      </span>
    {/if}

    <div class="spacer"></div>

    {#if store.modifiedCount > 0}
      <span class="chip">{store.modifiedCount} unsaved</span>
    {:else}
      <span class="chip muted">No changes</span>
    {/if}
  </header>

  <!--
    Outcomes of anything that reached the machine - a save, a refusal, a failed version check - land here
    rather than beside the button that started them: several of those buttons live in the sidebar, and a
    message that scrolls away with its panel is a message the user never reads.
  -->
  {#if store.notice}
    <div class="notice" class:problem={store.notice.kind === "problem"} role="status">
      <span>{store.notice.text}</span>
      <button class="dismiss" onclick={() => (store.notice = null)}>Dismiss</button>
    </div>
  {/if}

  <div class="body">
    <Sidebar />
    <!-- Everything here acts on the selected install, so there is nothing to show until there is one. -->
    {#if store.loaded && !store.install}
      <NoInstall />
    {:else}
      <SettingsView />
    {/if}
  </div>
</div>

<style>
  .shell {
    /* The header sits outside the pane, so it needs its own reference for `--gutter`. */
    container-type: inline-size;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 8px 12px;
    padding: 9px var(--gutter);
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }

  /* Nothing in the bar shrinks; the spacer takes the slack. */
  .top > * {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .brand {
    font-weight: 650;
    letter-spacing: 0.02em;
  }

  .notice {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex: 0 0 auto;
    padding: 7px var(--gutter);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
    color: var(--text);
  }

  .notice.problem {
    background: color-mix(in srgb, var(--invalid) 14%, transparent);
    color: var(--invalid);
  }

  .notice span {
    /* The path a save reports is long and has nowhere to be cut, so the banner grows instead of clipping it. */
    overflow-wrap: anywhere;
  }

  .dismiss {
    margin-left: auto;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 11.5px;
    padding: 2px 9px;
  }

  .version {
    color: var(--text-faint);
    font-weight: 400;
    font-size: 12px;
  }

  .spacer {
    flex: 1;
  }

  .working {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    color: var(--text-dim);
  }

  /*
    A pulse rather than a spinner: it says the same thing with no rotation to keep smooth, and it is the one
    part of this that still moves while the main thread is busy laying out a long settings list.
  */
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.1s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }

  /* Motion is decoration here - the text beside it already says what is happening. */
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }

  .chip {
    border: 1px solid var(--modified);
    color: var(--modified);
    background: var(--modified-soft);
    border-radius: 999px;
    padding: 3px 11px;
    font-size: 12.5px;
  }

  .chip.muted {
    border-color: var(--border);
    color: var(--text-faint);
    background: none;
  }

  /* The gutter is the same one the header and the notice inset by, so all three share one left edge. */
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
    padding-inline: var(--gutter);
  }
</style>
