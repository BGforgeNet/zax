<script lang="ts">
  import { MODS_ORDER_PATH } from "@zax/fallout2";
  import SaveBar from "./SaveBar.svelte";
  import { store } from "./store.svelte.js";

  const KIND_LABEL = { dat: "dat", folder: "folder", file: "file", missing: "missing" } as const;
</script>

<!-- One shape for both directions: the down button rotates it, so the two arrows cannot drift apart. -->
{#snippet chevron()}
  <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 7.75 6 4.25l3.5 3.5" /></svg>
{/snippet}

<div class="pane">
  <div class="heading">
    <h1>Mods</h1>
    <!--
      Which end wins is the one thing about this file nobody can see by looking at it, and getting it backwards
      is how two mods that both work end up cancelling each other out.
    -->
    <p>
      What sfall loads out of <code>mods</code>, in the order it loads them - a mod further down overrides one above it.
      Saved to <code>{MODS_ORDER_PATH}</code>.
    </p>
  </div>

  <main>
    <div class="list">
      {#each store.mods as mod, i (mod.name)}
        <div class="mod" class:off={!mod.enabled} class:gone={mod.kind === "missing"}>
          <!-- The name is the label, so the whole of it is a target for the checkbox rather than the box alone. -->
          <label class="pick">
            <input
              type="checkbox"
              checked={mod.enabled}
              disabled={mod.kind === "missing"}
              onchange={() => store.toggleMod(mod.name)}
            />
            <span class="name">{mod.name}</span>
          </label>
          <span class="badge" class:missing={mod.kind === "missing"}>{KIND_LABEL[mod.kind]}</span>

          <div class="actions">
            {#if mod.kind === "missing"}
              <!-- The only thing here that deletes a line. Everything present would come back from the folder. -->
              <button class="link" onclick={() => store.forgetMod(mod.name)}>Forget</button>
            {/if}
            <!-- Tighter to each other than to anything else in the row: the two arrows are one control. -->
            <div class="reorder">
              <button
                class="move"
                disabled={i === 0}
                aria-label="Move {mod.name} up"
                title="Move up"
                onclick={() => store.moveMod(mod.name, -1)}>{@render chevron()}</button
              >
              <button
                class="move down"
                disabled={i === store.mods.length - 1}
                aria-label="Move {mod.name} down"
                title="Move down"
                onclick={() => store.moveMod(mod.name, 1)}>{@render chevron()}</button
              >
            </div>
          </div>
        </div>
      {:else}
        <p class="empty">
          Nothing in this install's <code>mods</code> folder. A mod is a <code>.dat</code> archive or a folder put there;
          it will be listed here once it is.
        </p>
      {/each}
    </div>

    <SaveBar />
  </main>
</div>

<style>
  /*
    Fixed tracks rather than a flex row, for the reason the settings rows have them: with the badge following
    the name it sat at a different place on every row, and a column of badges that never lines up reads as
    ragged rather than as a column. The name track is wide enough for the longest a mods folder holds.
  */
  .mod {
    display: grid;
    grid-template-columns: minmax(0, 22rem) auto 1fr;
    align-items: center;
    column-gap: 12px;
    padding: 7px var(--gutter);
    border-bottom: 1px solid var(--border);
    /* The same left rule the settings rows carry, so an edited row reads the same in both views. */
    border-left: 2px solid transparent;
  }

  /* Zebra and hover as the settings list has them: the two are the same kind of list and read alike. */
  .mod:nth-of-type(even) {
    background: color-mix(in srgb, var(--band) 40%, transparent);
  }

  .mod:hover {
    background: var(--panel-alt);
  }

  .pick {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .name {
    font-family: var(--mono);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }

  /* Dimmed rather than hidden: a mod that is off is still part of the order, and still has its place in it. */
  .off .name {
    color: var(--text-dim);
  }

  /*
    Struck through rather than faded away: the faint tone is under 4.5:1 on both palettes, and an entry the
    engine cannot load is exactly the row that has to stay readable. The rule and the badge carry the state.
  */
  .gone .name {
    text-decoration: line-through;
    color: var(--text-dim);
  }

  .badge {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 10.5px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 3px;
    padding: 0 4px;
  }

  /* An entry pointing at nothing is the one state here that is wrong rather than merely off. */
  .badge.missing {
    background: color-mix(in srgb, var(--invalid) 14%, transparent);
    color: var(--invalid);
  }

  /* At the row's right edge, where the settings rows put theirs, whatever the name and badge before it are. */
  .actions {
    display: flex;
    align-items: center;
    justify-self: end;
    gap: 10px;
  }

  .reorder {
    display: flex;
    gap: 4px;
  }

  /* Square, so the pair reads as one two-part control rather than as two buttons of different widths. */
  .move {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 22px;
    background: var(--panel-alt);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 0;
    color: var(--text);
  }

  .move svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .move.down svg {
    transform: rotate(180deg);
  }

  /* At the ends of the list rather than hidden, so the row keeps its shape wherever a mod sits in the order. */
  .move:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .link {
    background: none;
    border: none;
    padding: 0;
    font-size: 12.5px;
    color: var(--accent);
    text-decoration: underline;
  }

  .empty code,
  .heading code {
    font-family: var(--mono);
    font-size: 0.92em;
  }
</style>
