<script lang="ts">
  import { store } from "./store.svelte.js";

  const current = $derived(store.install);
</script>

<!-- Rendered inside the Settings list, as the previous interface's fourth settings tab. -->
{#if current}
  <div class="row">
    <div class="label"><span class="name">WINEPREFIX</span></div>
    <div class="control">
      <input
        type="text"
        value={current.wine?.prefix ?? ""}
        placeholder="default prefix"
        aria-label="WINEPREFIX"
        oninput={(e) =>
          store.setWine(current.path, { prefix: e.currentTarget.value, debug: current.wine?.debug ?? "" })}
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
        placeholder="unset"
        aria-label="WINEDEBUG"
        oninput={(e) =>
          store.setWine(current.path, { prefix: current.wine?.prefix ?? "", debug: e.currentTarget.value })}
      />
    </div>
    <div class="notes">
      <span class="help">Wine's own logging channels, such as <code>-all</code> to silence them.</span>
    </div>
  </div>
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
</style>
