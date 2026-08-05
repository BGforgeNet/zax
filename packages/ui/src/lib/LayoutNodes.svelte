<script lang="ts">
  import type { LayoutNode } from "@zax/fallout2";
  import LayoutNodes from "./LayoutNodes.svelte";
  import ResolutionPresets from "./ResolutionPresets.svelte";
  import SettingRow from "./SettingRow.svelte";
  import SfallVersion from "./SfallVersion.svelte";
  import { store } from "./store.svelte.js";

  // Recursive, because the previous layout nested frames - Resolution and Fullscreen both sit inside Graphics.
  // The depth is carried so a nested group can rank below its parent while still outranking its own rows.
  let { items, depth = 0 }: { items: readonly LayoutNode[]; depth?: number } = $props();
</script>

{#each items as node, i (node.kind === "frame" ? `f${i}${node.title}` : node.kind === "setting" ? node.id : `w${i}`)}
  {#if node.kind === "frame"}
    <div class="frame" data-depth={depth}>
      <h2 class="frame-title">{node.title}</h2>
      <LayoutNodes items={node.items} depth={depth + 1} />
    </div>
  {:else if node.kind === "widget"}
    {#if node.id === "f2_res.ini-resolution"}
      <ResolutionPresets />
    {:else if node.id === "btn_sfall_check"}
      <!-- One block in place of the four separate widgets the previous interface used for it. -->
      <SfallVersion />
    {/if}
  {:else}
    {@const def = store.defOf(node.id)}
    <!--
      Controls the previous interface hid, plus any whose value the engine ignores. Kept hidden, except where
      ZAX pins the value: a pinned setting counts as a pending change, so hiding it would leave the user an
      unsaved count they can neither find nor revert.
    -->
    {#if def && (!node.hidden || def.managed)}<SettingRow {def} control={node.control} />{/if}
  {/if}
{/each}

<style>
  /*
    The previous interface drew a frame as a separator, a title, then a bordered box. Only nested frames carry
    the rule: on a top-level one it ran the whole tab and marked nothing.
  */
  .frame[data-depth="1"],
  .frame[data-depth="2"] {
    border-left: 2px solid var(--border);
  }

  /*
    A group title has to outrank the rows it contains. At faint grey and 11.5px it sat below a 14px label in
    both size and contrast, so each title read as a caption belonging to the row beneath it rather than as the
    heading of the block below.
  */
  .frame-title {
    margin: 0;
    /* The bar is drawn with a border rather than a pseudo-element so it survives the band's own inset gutter. */
    padding: 9px var(--gutter);
    border-left: 3px solid var(--accent);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text);
    background: var(--band);
    border-top: 1px solid var(--border-strong);
    border-bottom: 1px solid var(--border-strong);
  }

  /* Rows of a group sit in from its heading, so the block reads as belonging to it. Applied to the label
     alone: indenting the row would carry its control and notes tracks out of line with every ungrouped row. */
  .frame[data-depth="0"] {
    --row-indent: 16px;
  }

  .frame[data-depth="1"] {
    --row-indent: 32px;
  }

  .frame[data-depth="2"] {
    --row-indent: 48px;
  }

  /*
    A nested group ranks below its parent by size and indent rather than by contrast: dimming it is what made
    the titles read as captions in the first place, and its own rows would outrank it again.
  */
  .frame[data-depth="1"] > .frame-title,
  .frame[data-depth="2"] > .frame-title {
    padding-left: calc(var(--gutter) + 16px);
    font-size: 12px;
    letter-spacing: 0.06em;
    background: color-mix(in srgb, var(--band) 60%, var(--bg));
    border-left-color: color-mix(in srgb, var(--accent) 45%, transparent);
    border-top-color: var(--border);
    border-bottom-color: var(--border);
  }
</style>
