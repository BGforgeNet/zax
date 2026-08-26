<script lang="ts">
  import { isPreview } from "./host.js";
  import { store } from "./store.svelte.js";

  const OUTSIDE = "The browser preview cannot start a program - this needs the desktop build";

  /** Which engine's chooser is open, by id. One at a time: they sit side by side on one bar. */
  let choosing = $state<string | null>(null);

  const day = (instant: string) => {
    const at = Date.parse(instant);
    return Number.isNaN(at) ? instant : new Date(at).toLocaleDateString();
  };

  /** The tag where a project publishes versions, the date where it republishes one - as the Engines tab names it. */
  const mark = (releases: string, build: { release: string; published: string }) =>
    releases === "tagged" ? build.release : day(build.published);

  function run(engineId: string, published: string | null): void {
    choosing = null;
    void store.play(engineId, published);
  }

  /**
   * Anywhere outside the open chooser closes it, which is what every menu does and the only way to dismiss it
   * without picking. On pointerdown rather than click so it fires before a button underneath acts.
   */
  function dismiss(event: PointerEvent): void {
    if (choosing === null) return;
    if (!(event.target instanceof Element) || !event.target.closest(".split")) choosing = null;
  }
</script>

<svelte:window onpointerdown={dismiss} />

<!--
  Both sat under the settings tabs in the previous interface, not in the window chrome. One bar shared by every
  view rather than one per view: Save writes the config files and the mod order together, and a second button
  that wrote only half of that would be a different Save wearing the same word.
-->
<div class="footer">
  <!-- Disabled rather than hidden under autosave: a button that vanished would move Run under the pointer. -->
  <button
    class="primary"
    disabled={store.autosave || !store.install || store.modifiedCount === 0 || store.busy !== null}
    title={store.autosave ? "Autosave is on - every change is written as it is made" : null}
    onclick={() => void store.save()}
  >
    {store.busy === "Saving" ? "Saving..." : "Save"}
  </button>
  <button
    disabled={!store.install || isPreview || store.busy !== null}
    title={isPreview ? "The browser preview cannot start a program - this needs the desktop build" : null}
    onclick={() => void store.play()}
  >
    Run
  </button>
  <!--
    Whatever the machine holds a build of: one download serves every game folder, so an engine ZAX already has
    is one this folder can run - the first run unpacks it in place. Offering it only where it was already
    deployed made the user fetch the same archive once per game.
  -->
  {#each store.engines.filter((engine) => engine.versions.length > 0) as engine (engine.id)}
    {@const deployed = store.engineDeployed[engine.id]}
    <div class="split">
      <button
        disabled={!store.install || isPreview || store.busy !== null}
        title={isPreview ? OUTSIDE : null}
        onclick={() => run(engine.id, null)}
      >
        Run in {engine.short}
      </button>
      <!--
        One build is no choice, and a chevron over it would open a menu with a single row. Opening the list is
        not starting a program, so this stays live in the browser preview - the refusal sits on the rows, which
        are what would launch, shown disabled with the reason the way the Engines tab shows its own.
      -->
      {#if engine.versions.length > 1}
        <button
          class="chevron"
          aria-label="Choose a {engine.short} build"
          aria-expanded={choosing === engine.id}
          disabled={store.busy !== null}
          onclick={() => (choosing = choosing === engine.id ? null : engine.id)}
        >
          <span class="arrow" aria-hidden="true"></span>
        </button>
      {/if}
      {#if choosing === engine.id}
        <div class="menu" role="menu">
          <!-- First, and what an unpinned folder follows: fetching a newer build moves it forward. -->
          <button
            role="menuitem"
            class:on={deployed?.pinned !== true}
            disabled={!store.install || isPreview || store.busy !== null}
            title={isPreview ? OUTSIDE : null}
            onclick={() => run(engine.id, null)}
          >
            Latest
          </button>
          {#each engine.versions as version (version.published)}
            <button
              role="menuitem"
              class:on={deployed?.pinned === true && deployed.published === version.published}
              disabled={!store.install || isPreview || store.busy !== null}
              title={isPreview ? OUTSIDE : null}
              onclick={() => run(engine.id, version.published)}
            >
              {mark(engine.releases, version)}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  <!-- Status rather than an action, so it sits away from the buttons at the far end of their own bar. -->
  <div class="spacer"></div>
  {#if store.modifiedCount > 0}
    <span class="chip">{store.modifiedCount} unsaved</span>
    <!-- After the count rather than among the buttons: the count is what says there is anything to undo. -->
    <button class="link" onclick={() => void store.revertAll()}>Revert all</button>
  {:else}
    <span class="chip muted">No changes</span>
  {/if}
</div>

<style>
  .footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px var(--gutter);
    border-top: 1px solid var(--border);
    background: var(--panel);
    flex: 0 0 auto;
  }

  .footer button {
    background: var(--panel-alt);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 4px 16px;
    color: var(--text);
  }

  .footer .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 550;
  }

  .footer button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  /* Scoped like `.primary` above it, and for the same reason: `.footer button` is the more specific of the
     two otherwise, and this one would draw as the bordered button it is meant not to be. */
  .footer .link {
    background: none;
    border: none;
    padding: 0;
    font-size: 12.5px;
    color: var(--accent);
    text-decoration: underline;
  }

  /* Positioned so the menu hangs off this pair rather than off the bar, which scrolls nothing. */
  .split {
    position: relative;
    display: flex;
  }

  .split button:first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .footer .chevron {
    border-left: none;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    padding: 4px 9px;
  }

  /* Drawn rather than typed: the glyphs that read as a chevron are all outside ASCII. */
  .arrow {
    display: block;
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid currentColor;
  }

  /* Above the bar: the bar is the last thing in the window, so a menu below it would be off-screen. */
  .menu {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    min-width: 100%;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--panel-alt);
    overflow: hidden;
  }

  .footer .menu button {
    border: none;
    border-radius: 0;
    text-align: left;
    white-space: nowrap;
    font-size: 12.5px;
  }

  .footer .menu button.on {
    color: var(--accent);
    font-weight: 550;
  }

  .spacer {
    flex: 1;
  }

  .chip {
    border: 1px solid var(--modified);
    color: var(--modified);
    background: var(--modified-soft);
    border-radius: 999px;
    padding: 3px 11px;
    font-size: 12.5px;
    white-space: nowrap;
  }

  .chip.muted {
    border-color: var(--border);
    color: var(--text-faint);
    background: none;
  }
</style>
