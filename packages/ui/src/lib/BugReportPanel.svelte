<script lang="ts">
  import { DEBUG_PACKAGE_CONTENTS } from "@zax/fallout2";
  import ActionCard from "./ActionCard.svelte";
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
        {#if slots.length > 0}
          <fieldset class="saves">
            <legend>Savegames to attach</legend>
            {#each slots as slot (slot)}
              <label>
                <input type="checkbox" checked={chosen.includes(slot)} onchange={() => toggle(slot)} />
                {slot}
              </label>
            {/each}
          </fieldset>
        {/if}
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

  .saves {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 12px 8px;
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .saves legend {
    padding: 0 4px;
    font-size: 11px;
    color: var(--text-faint);
  }

  .saves label {
    display: flex;
    align-items: center;
    gap: 5px;
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
