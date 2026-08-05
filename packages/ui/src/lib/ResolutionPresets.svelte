<script lang="ts">
  import { COMMON_RESOLUTIONS } from "@zax/fallout2";
  import { store } from "./store.svelte.js";

  const WIDTH = "hires.main.scr-width";
  const HEIGHT = "hires.main.scr-height";

  // The previous interface offered a shorter list once 2x scaling was on, because scaling doubles the rendered
  // size and the smaller modes no longer fit.
  const scaled = $derived(store.valueOf("hires.main.scale-2x") === "1");
  const options = $derived(
    COMMON_RESOLUTIONS.filter((r) => !scaled || (r.width >= 1280 && r.height >= 960)),
  );

  function choose(value: string) {
    if (value === "") return;
    const [w, h] = value.split("x");
    if (w && h) {
      store.set(WIDTH, w);
      store.set(HEIGHT, h);
    }
  }
</script>

<div class="row">
  <div class="label"><span class="name">Select from common options</span></div>
  <div class="control">
    <select value="" aria-label="Common resolutions" onchange={(e) => choose(e.currentTarget.value)}>
      <option value="">...</option>
      {#each options as r (`${r.width}x${r.height}`)}
        <option value={`${r.width}x${r.height}`}>{r.width} x {r.height}</option>
      {/each}
    </select>
  </div>
  <div class="notes">
    <span class="help">Fills the two boxes below; any size in range is accepted.</span>
    {#if scaled}
      <span class="note">Smaller modes are omitted while 2x scaling is on.</span>
    {/if}
  </div>
</div>

<style>
  select {
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 3px 7px;
  }
</style>
