<script lang="ts">
  import { COMMON_RESOLUTIONS, type ResolutionPair } from "@zax/fallout2";
  import { store } from "./store.svelte.js";

  let { pair }: { pair: ResolutionPair } = $props();

  // Width and height are one decision, not two - but the engine accepts any size in range, so both are free
  // inputs and the preset list is only a shortcut for filling them.
  const width = $derived(store.valueOf(pair.width) ?? "");
  const height = $derived(store.valueOf(pair.height) ?? "");
  const isNative = $derived(pair.nativeValue !== undefined && width === pair.nativeValue);
  const modified = $derived(store.isModified(pair.width) || store.isModified(pair.height));

  const scaleDef = $derived(pair.scaleToggle ? store.defOf(pair.scaleToggle) : undefined);
  const scaleOn = $derived(
    scaleDef !== undefined && store.valueOf(scaleDef.id) === (scaleDef.kind.type === "bool" ? scaleDef.kind.onValue : "1"),
  );

  const widthDef = $derived(store.defOf(pair.width));
  const heightDef = $derived(store.defOf(pair.height));

  // The merged keys carry the gate individually, so the pair has to render it or the whole control looks live
  // while neither key does anything. Both carry the same one; the width speaks for the pair.
  const gate = $derived(widthDef ? store.gateOf(widthDef) : null);
  const inert = $derived(gate !== null && !gate.active);

  /** A companion setting can raise the floor - 2x scaling renders at double size and cannot go below 1280x960. */
  const raised = $derived.by(() => {
    const rule = pair.minimumWhen;
    if (!rule) return null;
    const current = store.valueOf(rule.id);
    return current !== undefined && rule.values.includes(current) ? rule : null;
  });

  const minWidth = $derived(Math.max(raised?.width ?? 0, widthDef?.kind.type === "int" ? (widthDef.kind.min ?? 0) : 0));
  const minHeight = $derived(
    Math.max(raised?.height ?? 0, heightDef?.kind.type === "int" ? (heightDef.kind.min ?? 0) : 0),
  );

  const tooSmall = $derived(
    !isNative && width !== "" && height !== "" && (Number(width) < minWidth || Number(height) < minHeight),
  );

  function setPair(w: string, h: string) {
    store.set(pair.width, w);
    store.set(pair.height, h);
  }

  function choosePreset(value: string) {
    if (value === "") return;
    if (value === "native" && pair.nativeValue !== undefined) {
      setPair(pair.nativeValue, pair.nativeValue);
      return;
    }
    const [w, h] = value.split("x");
    if (w && h) setPair(w, h);
  }
</script>

<div class="row" class:modified class:inert>
  <div class="label">
    <span class="name">{pair.label}</span>
    <span class="badge" title={`${pair.width} + ${pair.height}`}>pair</span>
    {#if modified}
      <button
        class="revert"
        onclick={() => {
          store.revert(pair.width);
          store.revert(pair.height);
        }}>revert</button>
    {/if}
  </div>

  <div class="control">
    <input
      type="number"
      value={width}
      min={minWidth}
      max={widthDef?.kind.type === "int" ? widthDef.kind.max : undefined}
      aria-label={`${pair.label} width`}
      oninput={(e) => store.set(pair.width, e.currentTarget.value)}
    />
    <span class="x">x</span>
    <input
      type="number"
      value={height}
      min={minHeight}
      max={heightDef?.kind.type === "int" ? heightDef.kind.max : undefined}
      aria-label={`${pair.label} height`}
      oninput={(e) => store.set(pair.height, e.currentTarget.value)}
    />
  </div>

  <div class="notes">
    <div class="extras">
      {#if scaleDef}
        {@const kind = scaleDef.kind}
        <label class="scale">
          <input
            type="checkbox"
            checked={scaleOn}
            onchange={(e) =>
              store.set(scaleDef.id, kind.type === "bool" ? (e.currentTarget.checked ? kind.onValue : kind.offValue) : "0")}
          />
          {scaleDef.label}
        </label>
      {/if}
      <select value="" aria-label={`${pair.label} presets`} onchange={(e) => choosePreset(e.currentTarget.value)}>
        <option value="">Presets...</option>
        {#if pair.nativeValue !== undefined}
          <option value="native">Native</option>
        {/if}
        {#each COMMON_RESOLUTIONS as r (`${r.width}x${r.height}`)}
          {#if r.width >= minWidth && r.height >= minHeight}
            <option value={`${r.width}x${r.height}`}>
              {r.width} x {r.height}{r.note ? ` - ${r.note}` : ""}
            </option>
          {/if}
        {/each}
      </select>
    </div>
    <span class="help">{pair.help}</span>
    {#if inert && gate}
      <span class="gate">needs {gate.controller.label} = {gate.wants}</span>
    {/if}
    {#if isNative}
      <span class="sentinel">{pair.nativeValue} x {pair.nativeValue} means unscaled - pick a preset to override</span>
    {/if}
    {#if raised}
      <span class="note">minimum {raised.width} x {raised.height} while 2x scaling is on</span>
    {/if}
    {#if tooSmall}
      <span class="invalid" role="alert">Too small: needs at least {minWidth} x {minHeight}</span>
    {/if}
  </div>
</div>

<style>
  .control {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  input[type="number"] {
    width: 84px;
    text-align: right;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 3px 7px;
  }

  .x {
    color: var(--text-faint);
  }

  /* Scaling and the preset shortcut modify the same decision, so they sit with it rather than in a row of
     their own - but they are secondary to the two numbers, hence the notes column. */
  .extras {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 3px;
  }

  /* These edit the same gated keys as the two inputs, so they dim with them rather than staying bright. */
  .row.inert .extras {
    opacity: 0.55;
  }

  select {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 3px 7px;
  }

  .scale {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-dim);
    white-space: nowrap;
  }
</style>
