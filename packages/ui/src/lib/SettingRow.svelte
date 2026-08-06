<script lang="ts">
  import { displayValue, sentinelLabel, validate, type SettingDef } from "@zax/core";
  import Control from "./Control.svelte";
  import { store } from "./store.svelte.js";

  // `where` is set only by the search results, where a row has been lifted out of the tab that located it.
  // `onGo` makes that address the way back, rather than a second control competing for the same space.
  let {
    def,
    nested = false,
    where = "",
    onGo,
    control,
  }: { def: SettingDef; nested?: boolean; where?: string; onGo?: () => void; control?: string } = $props();

  const modified = $derived(store.isModified(def.id));
  const baseline = $derived(store.baselineOf(def.id));
  const value = $derived(store.valueOf(def.id));
  const validation = $derived(validate(def, value));
  const sentinel = $derived(sentinelLabel(def, value));
  const absent = $derived(store.isAbsent(def.id) && !store.isModified(def.id));
  const gate = $derived(store.gateOf(def));
  const conflict = $derived(store.conflictOf(def));
  const managed = $derived(def.managed);
  const inert = $derived(gate !== null && !gate.active);
  const origin = $derived(`${def.file} [${def.section}] ${def.key}`);

  // The component this setting belongs to is not installed. Editing would write its config file into the game
  // folder, which is not a thing to do on the user's behalf, so the row reads but does not take input.
  const unavailable = $derived(store.install !== undefined && !store.hasFile(def.file));
</script>

<div class="row" class:modified class:inert class:nested>
  <div class="label">
    <!-- The tab already names the file, so only the hover still spells out which key this writes. -->
    <span class="name" title={origin}>{def.label}</span>
    {#if where && onGo}
      <button class="badge go" title="Go to {where}" onclick={onGo}>{where}</button>
    {:else if where}
      <span class="badge" title={origin}>{where}</span>
    {/if}
    {#if modified}
      <span class="was">was {baseline === undefined ? "unset" : displayValue(def, baseline)}</span>
      <button class="revert" onclick={() => store.revert(def.id)}>revert</button>
    {/if}
  </div>

  <div class="control">
    {#if managed}
      <span class="pinned">{displayValue(def, managed.value)}</span>
    {:else}
      <!-- A fieldset so one attribute disables whichever control this row draws. -->
      <fieldset class="controls" disabled={unavailable}>
        <Control {def} {control} />
      </fieldset>
    {/if}
  </div>

  <div class="notes">
    {#if def.help}<span class="help">{def.help}</span>{/if}
    {#if managed}<span class="note">{managed.reason}</span>{/if}
    {#if inert && gate && !nested}
      <span class="gate">needs {gate.controller.label} = {gate.wants}</span>
    {:else if inert && gate}
      <span class="gate">needs {gate.wants} above</span>
    {/if}
    {#if conflict}
      <span class="clash" role="alert">clashes with {conflict.other.label}: {conflict.note}</span>
    {/if}
    {#if absent}
      <span class="absent" title="Setting it here adds the key to the file">
        not in your config - the game uses its default
      </span>
    {/if}
    {#if sentinel}<span class="sentinel">{sentinel}</span>{/if}
    {#if !validation.ok}<span class="invalid" role="alert">{validation.reason}</span>{/if}
  </div>
</div>

<style>
  /* Carries no appearance of its own: it is here to disable, not to draw a box. */
  .controls {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }

  .controls:disabled {
    opacity: 0.55;
  }

  .go {
    border: 1px solid transparent;
    cursor: pointer;
  }

  .go:hover {
    border-color: var(--accent);
  }

  .pinned {
    color: var(--text-faint);
    font-style: italic;
  }
</style>
