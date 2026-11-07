<script lang="ts">
  import { onMount } from "svelte";
  import bgforgeLogo from "./assets/bgforge.png";
  import EnginesView from "./lib/EnginesView.svelte";
  import { headerLinks } from "./lib/links.js";
  import ModsView from "./lib/ModsView.svelte";
  import NoInstall from "./lib/NoInstall.svelte";
  import SaveBar from "./lib/SaveBar.svelte";
  import SettingsView from "./lib/SettingsView.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import StatusBar from "./lib/StatusBar.svelte";
  import { store } from "./lib/store.svelte.js";

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
  <div class="body">
    <Sidebar />

    <!--
      The second column: which view is open, what the machine is doing, and the two buttons that act on the
      selected install. Its strip belongs to this column the way the sidebar's belongs to that one, so the
      boundary between them runs the whole height rather than starting below a bar that spanned both.
    -->
    <div class="column">
      <div class="tabbar topbar">
        <!--
          Settings are keys in config files, mods are what the engine loads and an engine is what runs them:
          a change of subject rather than another tab of one. All three are always offered - an install with
          no mods folder yet is exactly the one whose owner is about to add one.
        -->
        <div class="tabs" role="tablist">
          <button
            role="tab"
            class="tab"
            aria-selected={store.view === "settings"}
            onclick={() => (store.view = "settings")}
          >
            Settings
            <!-- Held in the markup shown or not: selection must not resize a tab and shift the ones after it. -->
            <span
              class="dot"
              class:unsaved={store.settingsChanged}
              aria-hidden="true"
              title={store.settingsChanged ? "Settings have unsaved changes" : null}
            ></span>
          </button>
          <!--
            Closed while the order file is in another engine's format: everything under it edits that file, and
            an Install or a reorder written against a list the folder does not hold is an edit thrown away. The
            reason rides on the tab, since a control refused without one reads as broken.
          -->
          <button
            role="tab"
            class="tab"
            aria-selected={store.view === "mods"}
            disabled={store.modsClosed !== null}
            title={store.modsClosed}
            onclick={() => (store.view = "mods")}
          >
            Mods
            <span
              class="dot"
              class:unsaved={store.modsViewChanged}
              aria-hidden="true"
              title={store.modsViewChanged ? "Mods have unsaved changes" : null}
            ></span>
          </button>
          <button
            role="tab"
            class="tab"
            aria-selected={store.view === "engines"}
            onclick={() => (store.view = "engines")}
          >
            Engines
          </button>
        </div>

        <!-- The shell hands a web link to the browser rather than following it, so this needs no operation. -->
        <span class="powered">
          <!-- Where to report a bug, ask about one, chat and support the work, then who made it. -->
          {#each headerLinks as link (link.href)}
            <a
              class="mark"
              style:color={link.color}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              title={link.label}
              aria-label={link.label}
            >
              <svg viewBox={link.viewBox} aria-hidden="true" focusable="false"><path d={link.path} /></svg>
            </a>
            <span class="sep" aria-hidden="true">|</span>
          {/each}
          Powered by <a href="https://bgforge.net/" target="_blank" rel="noreferrer">BGforge</a>
          <!-- The logo repeats the named link beside it, so it is a pointer target only, not a second stop. -->
          <a
            class="brand"
            href="https://bgforge.net/"
            target="_blank"
            rel="noreferrer"
            tabindex="-1"
            aria-hidden="true"
          >
            <img class="logo" src={bgforgeLogo} alt="" width="18" height="18" />
          </a>
        </span>
      </div>

      <!--
        The other two act on the selected install, so there is nothing to show until there is one. The Engines
        tab describes the machine - which builds it holds - so it draws either way, and is where a user with no
        game folder yet goes to fetch one.
      -->
      {#if store.view === "engines"}
        <EnginesView />
      {:else if store.loaded && !store.install}
        <NoInstall />
      {:else if store.view === "mods"}
        <ModsView />
      {:else}
        <SettingsView />
      {/if}

      <!--
        Chrome rather than part of a view: Save writes the config files and the mod order together whichever
        tab is open, and Run starts the game from any of them. Left out only on the no-install screen, which
        has nothing for either button to act on - while the state file is still being read the views draw
        their empty shape, so the bar draws with them rather than appearing under the pointer a moment later.
      -->
      {#if !store.loaded || store.install}
        <SaveBar />
      {/if}
    </div>
  </div>

  <!--
    Outcomes of anything that reached the machine - a save, a refusal, a failed version check - land here
    rather than beside the button that started them: several of those buttons live in the sidebar, and a
    message that scrolls away with its panel is a message the user never reads. Below both columns, since
    either can produce one, and below rather than above so that one arriving takes its space off the bottom
    edge instead of pushing every row the user was reading down the window.
  -->
  {#if store.notice}
    <div
      class="notice"
      class:problem={store.notice.kind === "problem"}
      class:note={store.notice.kind === "note"}
      role="status"
    >
      <span>{store.notice.text}</span>
      <button class="dismiss" onclick={() => (store.notice = null)}>Dismiss</button>
    </div>
  {/if}

  <!--
    The floor, under the notice as well as the columns: an outcome that has just arrived is a thing to read,
    while this says what is happening now, and the two read in that order down the window.
  -->
  <StatusBar />
</div>

<style>
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /*
    The second column, and the block the sidebar's border opens. Its own gutter, which the strip above, the
    view inside and the bar below all inset by, so the three share one left edge.
  */
  .column {
    --gutter: 14px;
    flex: 1 1 auto;
    min-width: 430px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /*
    The shared strip plus what sits at the far end of its row. The tabs take the slack rather than a spacer
    doing it, so the credit stays pinned right and the progress text lands beside it without moving the tabs.
  */
  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-right: var(--gutter);
  }

  .topbar .tabs {
    flex: 1 1 auto;
  }

  .topbar > :not(.tabs) {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--modified);
    visibility: hidden;
  }

  .dot.unsaved {
    visibility: visible;
  }

  .notice {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex: 0 0 auto;
    padding: 7px var(--gutter);
    background: var(--accent-soft);
    border-top: 1px solid var(--border);
    font-size: 12.5px;
    color: var(--text);
  }

  .notice.problem {
    background: color-mix(in srgb, var(--invalid) 14%, transparent);
    color: var(--invalid);
  }

  /* Something ZAX did unasked: set apart from a completed action without reading as a fault. */
  .notice.note {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-top-color: var(--accent);
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

  /* Decoration, and hidden from the reading order: a rule between links is not a word anyone needs read out. */
  .powered .sep {
    color: var(--border-strong);
  }

  /* The mark stands for the link, so it takes the underline off and the row's own ink instead. */
  .powered a.mark,
  .powered a.brand {
    display: flex;
    text-decoration: none;
  }

  /*
    One rule for both marks so they cannot drift apart: the BGforge logo is an image sized by its width and
    height attributes, which stay for the layout they reserve while it loads, and the GitHub mark is inline
    SVG with no intrinsic size at all.
  */
  .powered .logo,
  .powered a.mark svg {
    width: 18px;
    height: 18px;
  }

  .powered a.mark svg {
    fill: currentColor;
  }

  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
</style>
