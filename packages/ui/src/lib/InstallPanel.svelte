<script lang="ts">
  import { GAME_TYPES } from "@zax/core";
  import { store } from "./store.svelte.js";

  // Written on commit rather than per keystroke: each write is a rewrite of the state file on disk.
  const current = $derived(store.install);

  let alias = $state<HTMLInputElement | null>(null);

  // The entry points that ask for this field - a row's context menu, F2 - are in another component, so they
  // raise a request on the store rather than hold a reference to an input that may not be mounted yet.
  $effect(() => {
    if (store.aliasRequest === 0) return;
    alias?.focus();
    alias?.select();
  });
</script>

<!-- Rendered inside the Settings list, as its own tab: these fields belong to the install, not to a config file. -->
{#if current}
  <div class="row">
    <div class="label"><span class="name">Alias</span></div>
    <div class="control">
      <input
        bind:this={alias}
        class="prose"
        type="text"
        value={current.alias ?? ""}
        placeholder={GAME_TYPES[current.type].name}
        aria-label="Alias"
        onchange={(e) => void store.setAlias(current.path, e.currentTarget.value)}
      />
    </div>
    <div class="notes">
      <span class="help">What to call this install in the list. Empty uses what it is.</span>
    </div>
  </div>

  <div class="row">
    <div class="label"><span class="name">Folder</span></div>
    <div class="control"><span class="static">{current.path}</span></div>
    <div class="notes"><span class="help">{GAME_TYPES[current.type].label}.</span></div>
  </div>

  <!-- Wine only exists off Windows, matching the previous interface, which hid its whole tab there. -->
  {#if store.wineAvailable}
    <div class="frame" data-depth="0">
      <h2 class="frame-title">Wine</h2>

      <div class="row">
        <div class="label"><span class="name">WINEPREFIX</span></div>
        <div class="control">
          <input
            type="text"
            value={current.wine?.prefix ?? ""}
            placeholder="default prefix"
            aria-label="WINEPREFIX"
            onchange={(e) =>
              void store.setWine(current.path, { prefix: e.currentTarget.value, debug: current.wine?.debug ?? "" })}
          />
        </div>
        <div class="notes">
          <span class="help">The Wine prefix this install runs under.</span>
        </div>
      </div>

      <div class="row">
        <div class="label"><span class="name">WINEDEBUG</span></div>
        <div class="control">
          <input
            type="text"
            value={current.wine?.debug ?? ""}
            placeholder="-all"
            aria-label="WINEDEBUG"
            onchange={(e) =>
              void store.setWine(current.path, { prefix: current.wine?.prefix ?? "", debug: e.currentTarget.value })}
          />
        </div>
        <div class="notes">
          <span class="help">Wine's own logging channels. Left empty they are silenced with <code>-all</code>.</span>
        </div>
      </div>
    </div>
  {/if}
{:else}
  <p class="empty">Select an install to configure how it launches.</p>
{/if}

<style>
  input[type="text"] {
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 3px 7px;
    color: var(--text);
  }

  /* The Wine fields hold machine values; an alias is prose, and reads in the interface's own font. */
  input.prose {
    font-family: inherit;
  }

  /* The folder is shown, not edited: an install's path is what identifies it, so changing it would be a
     different install rather than an edit to this one. */
  .static {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }
</style>
