<script lang="ts">
  import { onMount } from "svelte";
  import bgforgeLogo from "./assets/bgforge.png";
  import EnginesView from "./lib/EnginesView.svelte";
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
          <!--
            Where to report a bug and where to ask about one, then who made it. The mark is the only name the
            GitHub link has, so it carries the label a tooltip would otherwise merely repeat; the forum has no
            mark of its own and is a word.
          -->
          <a
            class="mark"
            href="https://github.com/BGforgeNet/zax"
            target="_blank"
            rel="noreferrer"
            title="Source on GitHub"
            aria-label="Source on GitHub"
          >
            <!-- The GitHub mark, from Primer's octicons (MIT). -->
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"
              ><path
                d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"
              /></svg
            >
          </a>
          <span class="sep" aria-hidden="true">|</span>
          <a href="https://forums.bgforge.net/viewtopic.php?t=365" target="_blank" rel="noreferrer">Forum</a>
          <span class="sep" aria-hidden="true">|</span>
          <a
            class="mark"
            href="https://discord.gg/4Yqfggm"
            target="_blank"
            rel="noreferrer"
            title="Discord"
            aria-label="Discord"
          >
            <!-- The Discord mark, from Simple Icons (CC0). -->
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"
              ><path
                d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"
              /></svg
            >
          </a>
          <span class="sep" aria-hidden="true">|</span>
          Powered by <a href="https://bgforge.net/" target="_blank" rel="noreferrer">BGforge</a>
          <img class="logo" src={bgforgeLogo} alt="" width="18" height="18" />
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
  .powered a.mark {
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
