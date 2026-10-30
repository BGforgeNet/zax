<script lang="ts">
  import { store } from "./store.svelte.js";

  // The getter builds its object per read, and the bar reads it several times.
  const progress = $derived(store.progressParts);
</script>

<!--
  The window's floor: what is running, and the one control that stops it. Its own strip rather than a corner of
  the bar above, because what it holds is the length of a mod's name and the bar above holds buttons whose
  positions should not depend on that.

  Present whether or not anything is running. An operation starting is the moment the user is watching this
  place, and a strip that appeared then would move the whole window up as it did.
-->
<div class="statusbar" role="status">
  {#if store.busy}
    <span class="busy-dot" aria-hidden="true"></span>
    <!--
      The step names a mod, so its length is not ours to bound and it is what gives way; the proportion beside
      it is a dozen characters and is the half being watched, so it stays whole.
    -->
    <span class="step" title={progress?.step ?? store.busy}>{progress?.step ?? store.busy}</span>
    {#if progress?.amount}
      <span class="amount">{progress.amount}</span>
    {/if}
    <!--
      Offered only where it would be honoured. Only the transfer takes notice of a cancel, so once the bytes
      are in hand and the install is writing them the button goes rather than staying to be pressed for
      nothing - see `cancellable` on the store.
    -->
    {#if store.cancellable}
      <button class="stop" onclick={() => void store.cancel()}>Cancel</button>
    {:else if store.cancelling}
      <span class="stopping">Stopping...</span>
    {/if}
  {/if}
</div>

<style>
  /*
    Floored at the tallest it ever gets - the row carrying the Cancel button - rather than at the height of its
    text, so the strip stands the same empty, running and stopping. Floored at the text instead, it grew by six
    pixels as the button appeared and shrank again as it was replaced, moving the whole window twice during the
    one operation the user was watching.
  */
  .statusbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px var(--gutter);
    min-height: 28px;
    border-top: 1px solid var(--border);
    background: var(--panel-alt);
    color: var(--text-dim);
    font-size: 12px;
    flex: 0 0 auto;
  }

  /*
    Named apart from the tab strip's marker dot and from the mod rows' own `.status` lines. Svelte scopes these
    styles, so nothing here draws over them - but a bare `.status` matches a mod row first in a query over the
    whole window, which is how a check of this strip ends up measuring a paragraph in the tab above it.
  */
  .busy-dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }

  /* The only thing on the strip allowed to shrink, and the only one whose length nothing here decides. */
  .step {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /*
    The strip's own ink rather than the fainter tone secondary text takes: this is the number being watched, and
    at faint it measured 3.91:1 on the dark palette - under the 4.5:1 floor, and dimmest exactly where attention
    is. Tabular, or every tick of the percentage shifts what follows it.
  */
  .amount {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }

  .stop {
    flex: 0 0 auto;
    margin-left: auto;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 1px 10px;
    color: var(--text);
    font-size: 11.5px;
  }

  .stop:hover {
    border-color: var(--invalid);
    color: var(--invalid);
  }

  /* Where the button was, so the strip's end does not jump as the one replaces the other. */
  .stopping {
    flex: 0 0 auto;
    margin-left: auto;
    color: var(--text-faint);
    font-size: 11.5px;
  }
</style>
