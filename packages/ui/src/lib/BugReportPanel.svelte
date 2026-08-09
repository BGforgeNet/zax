<script lang="ts">
  import { DEBUG_PACKAGE_CONTENTS } from "@zax/fallout2";
  import ActionCard from "./ActionCard.svelte";
  import Dialog from "./Dialog.svelte";
  import { store } from "./store.svelte.js";

  const enableDebug = $derived(store.actionById("debug.enable"));
  const disableDebug = $derived(store.actionById("debug.disable"));
  const debugOn = $derived(enableDebug !== undefined && store.actionApplied(enableDebug));

  /*
    Saves are offered rather than swept in: they are the largest thing in the archive and the one part a user
    may not want to hand over, so the list is read when the step is reached and each slot is opted into.
  */
  let slots = $state<readonly string[]>([]);
  let chosen = $state<string[]>([]);
  let picking = $state(false);
  let filter = $state("");

  // Case-insensitive substring, which is what a slot name is: a label the player typed, not a path to parse.
  const matching = $derived(slots.filter((slot) => slot.toLowerCase().includes(filter.trim().toLowerCase())));

  $effect(() => {
    // Re-read when the selected install changes: another install's slots are not this one's.
    const path = store.install?.path;
    void path;
    void store.saveSlots().then((found) => {
      slots = found;
      chosen = [];
    });
  });

  function toggle(slot: string) {
    chosen = chosen.includes(slot) ? chosen.filter((one) => one !== slot) : [...chosen, slot];
  }
</script>

<div class="list">
  <p class="intro">Everything a useful report needs, in the order it has to happen.</p>

  <ol class="steps">
    <li>
      <div class="step">
        <span>Turn on every log the engine and sfall can write.</span>
        {#if enableDebug}
          <ActionCard action={enableDebug} />
        {/if}
      </div>
    </li>
    <li>
      <div class="step">
        <span>Launch the game, reproduce the problem, then quit.</span>
        <span class="aside">The logs are written next to the game, not here.</span>
      </div>
    </li>
    <li>
      <div class="step">
        <span>Collect the logs and your setup into one archive.</span>
        <!--
          Behind a dialog rather than inline: an install can carry hundreds of slots, and listing them here put
          the button that does the work below the fold behind a wall of checkboxes.
        -->
        <button class="picker" disabled={slots.length === 0} onclick={() => (picking = true)}>
          {#if slots.length === 0}
            No savegames found
          {:else if chosen.length === 0}
            Choose savegames ({slots.length})
          {:else}
            {chosen.length} of {slots.length} savegames
          {/if}
        </button>
        <Dialog open={picking} title="Savegames to attach" dismiss={() => (picking = false)}>
          <input
            class="filter"
            type="text"
            placeholder="Filter by name"
            aria-label="Filter savegames by name"
            bind:value={filter}
          />
          <div class="slots">
            {#each matching as slot (slot)}
              <label>
                <input type="checkbox" checked={chosen.includes(slot)} onchange={() => toggle(slot)} />
                {slot}
              </label>
            {:else}
              <p class="none">Nothing matches "{filter}".</p>
            {/each}
          </div>
          {#snippet footer()}
            <!-- Acts on what the filter is showing, which is what "all" means with a filter in the box. -->
            <button onclick={() => (chosen = [...new Set([...chosen, ...matching])])}>Select all</button>
            <button onclick={() => (chosen = chosen.filter((one) => !matching.includes(one)))}>Select none</button>
            <button onclick={() => (picking = false)}>Done</button>
          {/snippet}
        </Dialog>
        <button
          class="package"
          disabled={!store.install || store.busy !== null}
          onclick={() => void store.createDebugPackage(chosen)}
        >
          {store.busy === "Creating the debug package" ? "Collecting..." : "Create debug package"}
        </button>
        <ul class="contents">
          {#each DEBUG_PACKAGE_CONTENTS as item (item)}
            <li>{item}</li>
          {/each}
        </ul>
      </div>
    </li>
    <li>
      <div class="step">
        <span>File the report and attach the archive.</span>
        <span class="aside">The mod's forum thread or its issue tracker, whichever the mod points you at.</span>
      </div>
    </li>
  </ol>

  {#if debugOn && disableDebug}
    <div class="afterwards">
      <span class="aside">Logging costs performance, so turn it back off once the report is filed.</span>
      <ActionCard action={disableDebug} />
    </div>
  {/if}
</div>

<style>
  .intro {
    padding: 12px var(--gutter) 0;
    color: var(--text-dim);
    font-size: 12.5px;
  }

  .steps {
    margin: 0;
    /* The extra 24px on the left is the room the list markers need outside the text. */
    padding: 4px var(--gutter) 10px calc(var(--gutter) + 24px);
  }

  .steps > li {
    padding: 7px 0;
  }

  .steps > li::marker {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 5px;
    align-items: flex-start;
  }

  /*
    An action card is a full-width row elsewhere; inside a step it sits under its own sentence. The step has
    already been inset by the gutter, so the card drops back to a plain padding rather than insetting again.
  */
  .step :global(article) {
    align-self: stretch;
    border-bottom: none;
    border-radius: 6px;
    padding-inline: 16px;
  }

  .aside {
    color: var(--text-dim);
    font-size: 12.5px;
  }

  .package {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 4px 14px;
    color: var(--text-dim);
  }

  .package:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .picker {
    align-self: flex-start;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 3px 11px;
    color: var(--text-dim);
    font-size: 12px;
  }

  .picker:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .filter {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 8px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 4px 8px;
    color: var(--text);
    font-size: 12.5px;
  }

  /* Columns rather than one per line: slot names are short and uniform, so a wall of rows wastes the width. */
  .slots {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 4px 14px;
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .slots label {
    display: flex;
    align-items: center;
    gap: 5px;
    overflow-wrap: anywhere;
  }

  .none {
    margin: 0;
    color: var(--text-faint);
    font-size: 12.5px;
  }

  .contents {
    margin: 2px 0 0;
    padding-left: 18px;
    color: var(--text-faint);
    font-size: 12px;
    line-height: 1.5;
  }

  .afterwards {
    display: flex;
    flex-direction: column;
    gap: 5px;
    align-items: flex-start;
    /* Aligned with the step text above it, markers included. */
    padding: 0 var(--gutter) 14px calc(var(--gutter) + 24px);
  }

  .afterwards :global(article) {
    align-self: stretch;
    border-bottom: none;
    border-radius: 6px;
    padding-inline: 16px;
  }
</style>
