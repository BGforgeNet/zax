<script lang="ts">
  import { isPreview } from "./host.js";
  import { store } from "./store.svelte.js";

  const OUTSIDE = "The browser preview has no machine to reach - this needs the desktop build";

  /** The publication date is the version for a project that publishes none, so it is what is shown. */
  const day = (instant: string) => {
    const at = Date.parse(instant);
    return Number.isNaN(at) ? instant : new Date(at).toLocaleDateString();
  };
</script>

<div class="panel">
  {#each store.engines as engine (engine.id)}
    {@const latest = store.engineLatest[engine.id]}
    <section class="engine">
      <h2 class="section">{engine.name}</h2>
      <p class="line">
        <a href={engine.page} target="_blank" rel="noreferrer">{engine.page}</a>
      </p>

      {#if engine.build}
        <p class="line">This machine gets <strong>{engine.build.asset}</strong></p>
      {:else}
        <p class="line problem">{engine.why}</p>
      {/if}

      <p class="line">
        Installed
        {#if engine.installed}
          <strong>{day(engine.installed.published)}</strong>
          {#if !engine.installed.complete}<span class="problem">- that install did not finish</span>{/if}
        {:else}
          <span class="unknown">not installed</span>
        {/if}
      </p>
      <p class="line">
        Latest
        {#if latest}
          <strong>{day(latest.published)}</strong>
        {:else}
          <span class="unknown">not checked</span>
        {/if}
      </p>

      <div class="buttons">
        <button
          disabled={isPreview || store.busy !== null || !engine.build}
          title={isPreview ? OUTSIDE : null}
          onclick={() => void store.checkEngine(engine.id)}
        >
          Check
        </button>
        <button
          disabled={isPreview || store.busy !== null || !engine.build || !store.install}
          title={isPreview ? OUTSIDE : null}
          onclick={() => void store.installEngine(engine.id)}
        >
          {engine.installed ? "Update" : "Install"}
        </button>
        <button disabled={store.busy !== null || !engine.installed} onclick={() => void store.removeEngine(engine.id)}>
          Remove
        </button>
      </div>

      {#if store.engineOutdated(engine.id)}
        <p class="note">A newer build has been published.</p>
      {/if}
      <!-- Said where it is relevant rather than done silently: it is the widest rename in the application. -->
      <p class="note">
        A native run on a case-sensitive filesystem wants a lowercased game folder. Quit the game before installing -
        this writes into its directory.
      </p>
    </section>
  {/each}
</div>

<style>
  .panel {
    padding: 10px;
  }

  .section {
    margin: 14px 0 5px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .engine:first-child .section {
    margin-top: 2px;
  }

  .engine + .engine {
    border-top: 1px solid var(--border);
    margin-top: 10px;
  }

  .line {
    margin: 0 0 2px;
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .unknown {
    color: var(--text-faint);
    font-style: italic;
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
