<script lang="ts">
  import type { EngineListing } from "./bindings/EngineListing";
  import Dialog from "./Dialog.svelte";
  import EngineCaution from "./EngineCaution.svelte";
  import { isPreview } from "./invoke.js";
  import { ENGINE_ICON } from "./icons.js";
  import { store } from "./store.svelte.js";

  const OUTSIDE = "The browser preview has no machine to reach - this needs the desktop build";

  const day = (instant: string) => {
    const at = Date.parse(instant);
    return Number.isNaN(at) ? instant : new Date(at).toLocaleDateString();
  };

  /**
   * What names a build to the user: the tag where the project publishes versions, and the publication date
   * where it republishes one tag and the date is the only thing that separates two builds.
   */
  const mark = (engine: EngineListing, build: { release: string; published: string }) =>
    engine.releases === "tagged" ? build.release : day(build.published);

  /**
   * A rolling project republishes one tag, so the date and this are the only things that tell two builds
   * apart. Shortened the way git does: seven characters identify the commit and a full sha reads as noise.
   */
  const sha = (commit: string) => commit.slice(0, 7);
</script>

<!-- The same shell the other two tabs are built from, so the column is bounded where theirs are. -->
<div class="pane">
  <main>
    <div class="panel list">
      {#each store.engines as engine (engine.id)}
        {@const latest = store.engineLatest[engine.id]}
        {@const icon = ENGINE_ICON[engine.id]}
        {@const here = store.install ? store.engineDeployed[engine.id] : undefined}
        {@const newest = engine.versions[0]}
        <section class="engine">
          <!-- The icon spans the name and the link together, which is the pair that identifies the project. -->
          <div class="head">
            {#if icon}
              <img class="engine-icon" src={icon} alt="" width="34" height="34" />
            {/if}
            <div>
              <h2 class="section">{engine.name}</h2>
              <p class="line">
                <a href={engine.page} target="_blank" rel="noreferrer">{engine.page}</a>
              </p>
            </div>
          </div>

          {#if engine.caution}
            <EngineCaution text={engine.caution} />
          {/if}

          {#if engine.build}
            <p class="line">This machine gets <strong>{engine.build.asset}</strong></p>
          {:else}
            <p class="line problem">{engine.why}</p>
          {/if}

          <p class="line">
            Latest
            {#if latest}
              <strong>{mark(engine, latest)}</strong>
              {#if latest.commit}<code class="sha">{sha(latest.commit)}</code>{/if}
            {:else}
              <span class="unknown">not checked</span>
            {/if}
          </p>

          <!--
            What this machine holds. Labelled, or the dated rows read as a continuation of the Latest line
            above them rather than as a list of something else. A game folder gets one of these the first time
            it runs the engine, or when one is picked for it below.
          -->
          <p class="line">
            On this machine
            {#if engine.versions.length === 0}<span class="unknown">no build yet</span>{/if}
          </p>
          {#each engine.versions as version (version.published)}
            {@const usedHere = here?.published === version.published}
            <p class="line held">
              <strong>{mark(engine, version)}</strong>
              {#if version.commit}<code class="sha">{sha(version.commit)}</code>{/if}
              <!-- A slot drawn whether or not the tag is in it, so picking a build moves no link on the row. -->
              {#if store.install}
                <span class="slot">
                  {#if usedHere}<span class="tag">used here</span>{/if}
                </span>
              {/if}
              <button
                class="drop"
                disabled={store.busy !== null}
                title={store.busyReason}
                onclick={() => void store.forgetEngine(engine.id, version.published)}
              >
                Remove
              </button>
              <!--
                After Remove, so the one link that comes and goes is the last on the row. Absent where it would
                change nothing - this build, already pinned here - and named for what it does on the build the game
                already runs, which is pin it.
              -->
              {#if store.install && !(usedHere && here?.pinned)}
                <button
                  class="use"
                  disabled={store.busy !== null}
                  title={store.busyReason}
                  onclick={() =>
                    void store.useEngineBuild(engine.id, { pick: "published", published: version.published })}
                >
                  {usedHere ? "Pin here" : "Use here"}
                </button>
              {/if}
            </p>
          {/each}

          <div class="buttons">
            <button
              disabled={isPreview || store.busy !== null || !engine.build}
              title={isPreview ? OUTSIDE : store.busyReason}
              onclick={() => void store.checkEngine(engine.id)}
            >
              Check
            </button>
            <button
              disabled={isPreview || store.busy !== null || !engine.build}
              title={isPreview ? OUTSIDE : store.busyReason}
              onclick={() => void store.fetchEngine(engine.id)}
            >
              Fetch latest
            </button>
          </div>

          <!--
            The one part of the card about the selected game rather than the machine, under its own label so a
            change of game reads as this line changing and nothing above it.
          -->
          {#if store.install}
            <p class="line this-game">
              This game
              {#if here}
                <strong>{mark(engine, here)}</strong>
                {#if here.commit}<code class="sha">{sha(here.commit)}</code>{/if}
                <span class="unknown">{here.pinned ? "pinned" : "follows the newest build"}</span>
              {:else}
                <span class="unknown">none yet</span>
              {/if}
              <!-- Hidden only where the game already follows the newest build and holds it. -->
              {#if newest && !(here && !here.pinned && here.published === newest.published)}
                <button
                  class="use"
                  disabled={store.busy !== null}
                  title={store.busyReason}
                  onclick={() => void store.useEngineBuild(engine.id, { pick: "latest" })}
                >
                  Follow latest
                </button>
              {/if}
            </p>
            {#if store.engineOutdated(engine.id)}
              <p class="note">This game runs an older build than the latest published.</p>
            {/if}
          {/if}
        </section>
      {/each}

      <!--
        Said where it is relevant rather than done silently: it is the widest rename in the application. Once
        below the list rather than under each engine - it is true of running any native build, so per-engine it
        was the same two lines repeated, and one more repeat for every engine added.
      -->
      {#if store.engines.length > 0}
        <p class="note">
          A native run on a case-sensitive filesystem wants a lowercased game folder. Quit the game before running or
          picking a different build - either one writes into the game's directory.
        </p>
      {/if}
    </div>
  </main>
</div>

<!--
  Said once, before this engine's first build is on the machine at all. Only the first fetch raises it: holding
  a build is what makes the next one not the first, so nothing has to be remembered and nothing dismissed. The
  gate before a launch is the one that repeats, because a launch is where what this describes actually happens.
-->
<Dialog
  open={store.pendingFetch !== null}
  title="Fetch {store.pendingFetch?.engine.name ?? ''}"
  dismiss={() => store.dismissFetch()}
>
  {#if store.pendingFetch}
    <EngineCaution
      text={store.pendingFetch.engine.caution ?? ""}
      title="{store.pendingFetch.engine.name} handles mods its own way"
    />
  {/if}
  {#snippet footer()}
    <button onclick={() => store.dismissFetch()}>Cancel</button>
    <button class="primary" onclick={() => void store.confirmFetch()}>Fetch anyway</button>
  {/snippet}
</Dialog>

<style>
  /* The committing action's clothes, as the save bar and the mods view dress theirs. */
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 550;
  }

  .panel {
    padding: 10px var(--gutter);
  }

  /*
    The icon hangs in a gutter rather than indenting the heading alone, so the name, the link and every line
    under them share one left edge. Kept whether or not the engine has an icon, for the same reason the mod
    rows keep their column: two blocks should not step in and out with whichever project ships art.
  */
  .engine {
    padding-left: 44px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .engine-icon {
    flex: 0 0 auto;
    margin-left: -44px;
    border-radius: 4px;
  }

  /* The head carries the block's spacing so the icon centres on both lines rather than on the heading alone. */
  .head .section {
    margin-top: 0;
  }

  .head .line {
    margin-bottom: 0;
  }

  .section {
    margin: 14px 0 5px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .engine .head {
    margin: 14px 0 5px;
  }

  .engine:first-child .head {
    margin-top: 2px;
  }

  .engine + .engine {
    border-top: 1px solid var(--border);
    margin-top: 10px;
  }

  /* The list's own note, separated from the last engine the way the engines are from each other. Without the
     rule it sits flush under that engine's buttons and reads as a line of it rather than of the list. */
  .engine + .note {
    border-top: 1px solid var(--border);
    margin-top: 10px;
    padding-top: 8px;
  }

  .line {
    margin: 0 0 2px;
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .sha {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px;
    color: var(--text-faint);
  }

  .unknown {
    color: var(--text-faint);
    font-style: italic;
  }

  .held {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* On its own row rather than in the button bar below: each acts on one build, not on the engine. */
  .drop,
  .use {
    background: none;
    border: none;
    padding: 0;
    font-size: 11.5px;
    color: var(--accent);
    text-decoration: underline;
  }

  /* Set off from the machine's lines above it, which the label alone did not do at a glance. */
  .this-game {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px dashed var(--border);
  }

  /* A floor rather than a width: a date fits, and a longer tag grows its own row rather than being cut. */
  .held strong {
    min-width: 6.5em;
  }

  /* Wide enough for the tag at its own size, which is the only thing it ever holds. */
  .slot {
    width: 6.5em;
    font-size: 10.5px;
  }

  .tag {
    font-size: 10.5px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 3px;
    padding: 0 4px;
  }

  .drop:disabled,
  .use:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .problem {
    color: var(--invalid);
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 5px;
  }

  .buttons button {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 3px 10px;
    color: var(--text-dim);
    font-size: 12px;
  }

  .buttons button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .note {
    margin: 4px 0 0;
    font-size: 11.5px;
    color: var(--text-faint);
  }
</style>
