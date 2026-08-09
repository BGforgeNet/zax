<script lang="ts">
  import { onMount } from "svelte";
  import bgforgeLogo from "./assets/bgforge.png";
  import zaxMark from "./assets/zax.svg";
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
    <!-- Decorative: the word beside it is the name, so a second one read out would only be a stutter. -->
    <div class="brand">
      <img class="mark" src={zaxMark} alt="" width="18" height="18" />
      ZAX <span class="version">{BUILD}</span>
    </div>

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

    <!-- The shell hands a web link to the browser rather than following it, so this needs no operation of its own. -->
    <span class="powered">
      Powered by <a href="https://bgforge.net/" target="_blank" rel="noreferrer">BGforge</a>
      <img class="logo" src={bgforgeLogo} alt="" width="18" height="18" />
    </span>
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
    /*
      Indented past the gutter by the column's own border and the inset its tab strip adds, which puts the mark
      here on the same left edge as the Games tab below it. Both ends, so the bar stays evenly padded.
    */
    padding: 9px calc(var(--gutter) + 1px + var(--tab-inset));
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
    display: flex;
    align-items: center;
    gap: 7px;
    font-weight: 650;
    letter-spacing: 0.02em;
  }

  /* Both marks sit on the text's own line rather than on the bar's, so neither drags the row taller. */
  .mark,
  .logo {
    display: block;
    flex: 0 0 auto;
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

  /*
    Dimmer than the brand but not the faint the version uses: that tone is under 4.5:1 on both palettes, which
    the half of this someone is meant to click should not be.
  */
  .powered {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--text-dim);
    font-size: 12px;
  }

  /* Underlined rather than colour alone, so the link half is the visible one before anyone hovers it. */
  .powered a {
    color: inherit;
    text-underline-offset: 2px;
  }

  .powered a:hover {
    color: var(--accent);
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

  /* The gutter is the same one the header and the notice inset by, so all three share one left edge. */
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
    padding-inline: var(--gutter);
  }
</style>
