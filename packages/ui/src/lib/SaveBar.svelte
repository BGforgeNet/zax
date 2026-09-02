<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import EngineCaution from "./EngineCaution.svelte";
  import { isPreview } from "./host.js";
  import { store } from "./store.svelte.js";

  const OUTSIDE = "The browser preview cannot start a program - this needs the desktop build";

  /** Which engine's chooser is open, by id. One at a time: they sit side by side on one bar. */
  let choosing = $state<string | null>(null);

  /**
   * The box on the caution dialog. Reset as the dialog opens rather than as it closes: a ticked box left behind
   * by a cancelled launch would silence the next one without the user having agreed to anything.
   */
  let understood = $state(false);

  /** What each format is called to a user, who knows the engines by name and has never heard of a slot. */
  const FORMAT_NAME = { sfall: "sfall", fission: "Fission" } as const;

  /** Titled after the action, which is what the user just asked for, whichever of the two things held it. */
  const launchTitle = (): string => {
    const held = store.pendingLaunch;
    if (!held) return "";
    return held.engine ? `Run in ${held.engine.short}` : "Run the game";
  };

  const day = (instant: string) => {
    const at = Date.parse(instant);
    return Number.isNaN(at) ? instant : new Date(at).toLocaleDateString();
  };

  /** The tag where a project publishes versions, the date where it republishes one - as the Engines tab names it. */
  const mark = (releases: string, build: { release: string; published: string }) =>
    releases === "tagged" ? build.release : day(build.published);

  function run(engineId: string, published: string | null): void {
    choosing = null;
    understood = false;
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
  <button
    disabled={!store.install || isPreview || store.busy !== null}
    title={isPreview ? OUTSIDE : store.busyReason}
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
        title={isPreview ? OUTSIDE : store.busyReason}
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
          title={store.busyReason}
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
            title={isPreview ? OUTSIDE : store.busyReason}
            onclick={() => run(engine.id, null)}
          >
            Latest
          </button>
          {#each engine.versions as version (version.published)}
            <button
              role="menuitem"
              class:on={deployed?.pinned === true && deployed.published === version.published}
              disabled={!store.install || isPreview || store.busy !== null}
              title={isPreview ? OUTSIDE : store.busyReason}
              onclick={() => run(engine.id, version.published)}
            >
              {mark(engine.releases, version)}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  <!-- Status rather than an action, so it sits away from the run buttons at the other end of the bar. -->
  <div class="spacer"></div>
  {#if store.autosave}
    <!-- One standing chip rather than a count: every edit is written within the debounce, so a count and a
       Revert all would appear and vanish on each change instead of reporting anything. -->
    <span class="chip muted">Saved automatically</span>
  {:else if store.modifiedCount > 0}
    <span class="chip">{store.modifiedCount} unsaved</span>
    <!-- After the count rather than among the buttons: the count is what says there is anything to undo. -->
    <button class="link" onclick={() => void store.revertAll()}>Revert all</button>
  {:else}
    <span class="chip muted">No changes</span>
  {/if}
  <!-- Last, at the end the eye finishes on: it is the bar's one committing action, and the count beside it is
     what says whether there is anything to commit. Disabled rather than hidden under autosave, so the bar's
     end does not shift as the setting is turned on and off. -->
  <button
    class="primary"
    disabled={store.autosave || !store.install || store.modifiedCount === 0 || store.busy !== null}
    title={store.autosave ? "Autosave is on - every change is written as it is made" : store.busyReason}
    onclick={() => void store.save()}
  >
    {store.busy === "Saving" ? "Saving..." : "Save"}
  </button>
</div>

<!--
  Two things can hold a launch, and this draws whichever were given. The caution is the engine's own and stops
  once dismissed; the swap is about this folder and is said every time, because it rewrites a file the user owns
  and changes which mods load. Neither is reported after the fact: the seam's launch resolves once the game is
  up, so afterwards is too late to refuse.
-->
<Dialog open={store.pendingLaunch !== null} title={launchTitle()} dismiss={() => store.dismissLaunch()}>
  {#if store.pendingLaunch}
    {@const held = store.pendingLaunch}
    {#if held.caution}
      <EngineCaution text={held.caution} title="{held.engine?.name ?? 'This engine'} handles mods its own way" />
    {/if}

    {#if held.swap}
      {@const swap = held.swap}
      <!-- The engine names the action and the format names the file: "running sfall" confuses the two, sfall
           being a patch the game loads rather than anything a user runs. -->
      <p class="swap-lead">
        This game was last set up for <strong>{FORMAT_NAME[swap.from]}</strong>. Running
        {held.engine?.short ?? "the game"} swaps the mod order over - ZAX files the {FORMAT_NAME[swap.from]} list beside it
        and puts {FORMAT_NAME[swap.to]}'s back, so neither is lost.
      </p>
      {#if swap.losing.length === 0 && swap.gaining.length === 0}
        <p class="swap-lead">The same mods load either way.</p>
      {:else}
        <!-- One per line and split by direction, so the two answers a user wants - what goes, what arrives -
             are read down rather than picked out of a sentence. -->
        <div class="swap-cols">
          {#if swap.losing.length > 0}
            <div>
              <p class="swap-head">No longer loads</p>
              <ul class="missed-list">
                {#each swap.losing as name (name)}
                  <li><span class="missed-name off">{name}</span></li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if swap.gaining.length > 0}
            <div>
              <p class="swap-head">Starts loading</p>
              <ul class="missed-list">
                {#each swap.gaining as name (name)}
                  <li><span class="missed-name">{name}</span></li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/if}
    {/if}

    <!--
      Named one per line rather than run together in a sentence: this is a list to read down and check against
      what the user believes is installed, and a comma-separated run of eight names is not read at all.
    -->
    {#if held.missed.length > 0}
      <p class="missed-lead">
        {held.missed.length === 1 ? "One entry in" : `${held.missed.length} entries in`}
        the mods folder will not load at all:
      </p>
      <ul class="missed-list">
        {#each held.missed as mod (mod.name)}
          <li>
            <span class="missed-name">{mod.name}</span>
            <span class="missed-kind">{mod.kind}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#snippet footer()}
    <!-- In the footer rather than under the lists: the body scrolls once a folder has more than a few mods, and
         the one control that stops this dialog coming back must not be the part that falls below the fold. -->
    {#if store.pendingLaunch?.caution}
      <label class="understood">
        <input type="checkbox" bind:checked={understood} />
        <span>I understand, do not show again</span>
      </label>
    {/if}
    <button onclick={() => store.dismissLaunch()}>Cancel</button>
    <button class="primary" onclick={() => void store.confirmLaunch(understood)}>Run anyway</button>
  {/snippet}
</Dialog>

<style>
  .swap-lead {
    margin: 10px 0 4px;
    font-size: 12.5px;
  }

  /* Side by side, so what goes and what arrives are one comparison rather than two lists to hold in mind. */
  .swap-cols {
    display: flex;
    gap: 22px;
    margin-top: 6px;
  }

  .swap-head {
    margin: 0 0 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  /* Struck through as the order list draws an entry the engine will not load, and for the same reason: the
     column heading says which side this is, and the rule says it again without relying on position. */
  .missed-name.off {
    text-decoration: line-through;
    color: var(--text-dim);
  }

  .missed-lead {
    margin: 10px 0 4px;
    font-size: 12.5px;
  }

  /* One per line, and scrolling rather than growing without bound: a folder can hold a great many of these. */
  .missed-list {
    margin: 0;
    padding-left: 18px;
    max-height: 11rem;
    overflow-y: auto;
  }

  .missed-list li {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .missed-name {
    font-family: var(--mono);
    font-size: 12.5px;
  }

  .missed-kind {
    font-family: var(--mono);
    font-size: 10.5px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 3px;
    padding: 0 4px;
  }

  /*
    The whole line is the target, as the mod rows make their name part of the checkbox's label. It takes the
    footer's free space so the two buttons stay at the edge they sit at in every other dialog.
  */
  .understood {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-right: auto;
    font-size: 12.5px;
  }

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

  /* Floored at the width of "Saving...", the wider of the two labels: unfloored the button grew by 31px the
     moment a save began and pulled the chip beside it left, which is the shift the button is placed to avoid. */
  /* The committing action's clothes, worn by the bar's Save and by the caution dialog's Run alike - the same
     kind of action reads the same in both, as it does in the mods view. */
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 550;
  }

  /* Only the bar's: the width is what stops the chip beside it moving when the label becomes "Saving...". */
  .footer .primary {
    min-width: 104px;
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
