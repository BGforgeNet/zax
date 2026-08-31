<script lang="ts">
  import type { EngineListing } from "@zax/fallout2";
  import { isPreview } from "./host.js";
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
            it runs the engine.
          -->
          <p class="line">
            On this machine
            {#if engine.versions.length === 0}<span class="unknown">no build yet</span>{/if}
          </p>
          {#each engine.versions as version (version.published)}
            <p class="line held">
              <strong>{mark(engine, version)}</strong>
              {#if version.commit}<code class="sha">{sha(version.commit)}</code>{/if}
              <button
                class="drop"
                disabled={store.busy !== null}
                title={store.busyReason}
                onclick={() => void store.forgetEngine(engine.id, version.published)}
              >
                Remove
              </button>
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

          {#if store.engineOutdated(engine.id)}
            <p class="note">A newer build has been published.</p>
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
          A native run on a case-sensitive filesystem wants a lowercased game folder. Quit the game before running a
          different build - the first run of one writes into the game's directory.
        </p>
      {/if}
    </div>
  </main>
</div>

<style>
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

  /* On its own row rather than in the button bar below: it acts on one build, not on the engine. */
  .drop {
    background: none;
    border: none;
    padding: 0;
    font-size: 11.5px;
    color: var(--accent);
    text-decoration: underline;
  }

  .drop:disabled {
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
