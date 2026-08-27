<script lang="ts">
  import {
    KEY_BY_SCANCODE,
    SCANCODE_BY_DOM_CODE,
    parseScancode,
    percentToScale,
    scaleToPercent,
    type SettingDef,
  } from "@zax/core";
  import { store } from "./store.svelte.js";

  // Which control the previous interface drew. A bounded float was a slider there, and the catalog kind alone
  // would make it a number box - the range is the point of the setting, not the digits.
  let { def, control }: { def: SettingDef; control?: string | undefined } = $props();

  const value = $derived(store.valueOf(def.id) ?? "");

  // On `code` rather than `key`: the file stores a physical scancode, and `key` is what the layout makes of
  // the keypress - it also names modifiers and function keys in a way no scancode answers to.
  function onKeyCapture(event: KeyboardEvent) {
    const code = SCANCODE_BY_DOM_CODE[event.code];
    if (code) {
      event.preventDefault();
      store.set(def.id, code);
    }
  }

  /** Floats are written back at the precision the game's own files use. */
  const format = (n: number, type: string) => (type === "float" ? n.toFixed(6) : String(Math.round(n)));
  const round = (n: number, type: string) => (type === "float" ? n.toFixed(2) : String(Math.round(n)));
</script>

{#if def.kind.type === "bool"}
  {@const on = value === def.kind.onValue}
  {@const kind = def.kind}
  <button
    type="button"
    class="toggle"
    class:on
    role="switch"
    aria-checked={on}
    aria-label={def.label}
    onclick={() => store.set(def.id, on ? kind.offValue : kind.onValue)}
  >
    <span class="knob"></span>
  </button>
{:else if control === "radio" && def.kind.type === "choice"}
  {@const kind = def.kind}
  <!-- A short, fixed set the previous interface laid out in the open rather than behind a dropdown. -->
  <div class="radios" role="radiogroup" aria-label={def.label}>
    {#each kind.options as option (option.value)}
      <label class="radio" title={option.help ?? ""}>
        <input
          type="radio"
          name={def.id}
          value={option.value}
          checked={value === option.value}
          onchange={() => store.set(def.id, option.value)}
        />
        {option.label}
      </label>
    {/each}
  </div>
{:else if def.kind.type === "choice"}
  <select {value} onchange={(e) => store.set(def.id, e.currentTarget.value)} aria-label={def.label}>
    {#if !def.kind.options.some((o) => o.value === value)}
      <option {value}>{value === "" ? "(unset)" : value}</option>
    {/if}
    {#each def.kind.options as option (option.value)}
      <option value={option.value} title={option.help ?? ""}>{option.label}</option>
    {/each}
  </select>
{:else if control === "slider" && (def.kind.type === "float" || def.kind.type === "int")}
  {@const kind = def.kind}
  {@const lo = kind.min ?? 0}
  {@const hi = kind.max ?? 100}
  {@const step = kind.type === "float" ? (hi - lo) / 100 : 1}
  {@const now = Number(value === "" ? lo : value)}
  <div class="slider">
    <input
      type="range"
      min={lo}
      max={hi}
      {step}
      value={Number.isFinite(now) ? now : lo}
      aria-label={def.label}
      oninput={(e) => store.set(def.id, format(Number(e.currentTarget.value), kind.type))}
    />
    <!-- Rounded for reading; the file keeps whatever precision it already had until the slider is moved. -->
    <span class="readout">{Number.isFinite(now) ? round(now, kind.type) : value}{kind.unit ? ` ${kind.unit}` : ""}</span
    >
  </div>
{:else if def.kind.type === "scale"}
  {@const max = def.kind.max}
  {@const percent = scaleToPercent(value, max)}
  <!-- The engine stores 0..max; a raw 22281 means nothing to a user, so the control speaks percent. -->
  <div class="slider">
    <input
      type="range"
      min="0"
      max="100"
      value={percent}
      aria-label={def.label}
      oninput={(e) => store.set(def.id, percentToScale(Number(e.currentTarget.value), max))}
    />
    <span class="readout">{percent}%</span>
  </div>
{:else if def.kind.type === "int" || def.kind.type === "float"}
  {@const kind = def.kind}
  <div class="withunit">
    <input
      type="number"
      class="num"
      {value}
      min={kind.min}
      max={kind.max}
      placeholder="default"
      aria-label={def.label}
      oninput={(e) => store.set(def.id, e.currentTarget.value)}
    />
    {#if kind.unit}<span class="unit">{kind.unit}</span>{/if}
  </div>
{:else if def.kind.type === "key"}
  <input
    type="text"
    class="keycap"
    readonly
    value={KEY_BY_SCANCODE[parseScancode(value)] ?? value}
    aria-label={`${def.label} (press a key)`}
    placeholder="press a key"
    onkeydown={onKeyCapture}
  />
{:else}
  <input
    type="text"
    class="text"
    class:path={def.kind.type === "text" && def.kind.path}
    {value}
    placeholder="default"
    aria-label={def.label}
    oninput={(e) => store.set(def.id, e.currentTarget.value)}
  />
{/if}

<style>
  .radios {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }

  .radio {
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    cursor: pointer;
  }

  select,
  input {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 3px 7px;
  }

  /* Selects and free text fill the control track so their edges line up down the list; a select sized to its
     own longest option instead left every row a different width. */
  select,
  .text {
    width: 100%;
  }

  .num {
    /* Wide enough for the widest value the files hold, a six-decimal float such as 1.000000. */
    width: 108px;
    text-align: right;
  }

  .withunit {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .unit {
    color: var(--text-faint);
    font-size: 12px;
    min-width: 26px;
  }

  .slider {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .slider input {
    width: 150px;
    padding: 0;
    border: none;
    background: none;
    accent-color: var(--accent);
  }

  .readout {
    width: 38px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }

  .text.path {
    font-family: var(--mono);
    font-size: 12.5px;
  }

  input::placeholder {
    color: var(--text-faint);
    font-style: italic;
  }

  .keycap {
    width: 110px;
    text-align: center;
    font-family: var(--mono);
    cursor: pointer;
  }

  .toggle {
    width: 36px;
    height: 20px;
    padding: 2px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--panel-alt);
    display: inline-flex;
    transition: background 120ms ease;
  }

  .toggle.on {
    background: var(--accent);
    border-color: var(--accent);
  }

  .knob {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    transition: transform 120ms ease;
  }

  /* Slid, not re-laid-out: as `justify-content: flex-end` the knob crossed in a single frame, no transition
     being able to interpolate it. The 16px track is the toggle's 30px content box less the knob. */
  .toggle.on .knob {
    transform: translateX(16px);
    border-color: transparent;
  }
</style>
