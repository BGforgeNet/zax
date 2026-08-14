<script lang="ts">
  import { COMMON_RESOLUTIONS } from "@zax/fallout2";
  import { store } from "./store.svelte.js";

  const WIDTH = "hires.MAIN.SCR_WIDTH";
  const HEIGHT = "hires.MAIN.SCR_HEIGHT";

  // The previous interface offered a shorter list once 2x scaling was on, because scaling doubles the rendered
  // size and the smaller modes no longer fit.
  const scaled = $derived(store.valueOf("hires.MAIN.SCALE_2X") === "1");
  const options = $derived(COMMON_RESOLUTIONS.filter((r) => !scaled || (r.width >= 1280 && r.height >= 960)));

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
    <!-- This writes two f2_res.ini keys, so it follows the same rule as the rows: no file, no editing. -->
    <select
      value=""
      aria-label="Common resolutions"
      disabled={store.install !== undefined && !store.hasFile("f2_res.ini")}
      onchange={(e) => choose(e.currentTarget.value)}
    >
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
