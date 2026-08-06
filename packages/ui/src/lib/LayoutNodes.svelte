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

<!-- The frame's own styles are global, in `app.css`, so the install tab can group its rows the same way. -->
