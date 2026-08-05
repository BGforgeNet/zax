<script lang="ts">
  import { GAME_TYPES, type GameType } from "@zax/core";
  import { store } from "./store.svelte.js";
  import fallout2 from "../assets/fallout2.png";
  import fallout2rpu from "../assets/fallout2rpu.png";
  import fallout2upu from "../assets/fallout2upu.png";

  // The previous interface's own icons, one per install type, carried over from its `zax/icons/`.
  const ICON: Record<GameType, string> = { fallout2, fallout2upu, fallout2rpu };

  const current = $derived(store.install);
</script>

<div class="panel">
  <ul class="installs">
    {#each store.installs as install (install.path)}
      {@const type = GAME_TYPES[install.type]}
      <li>
        <button
          class="install"
          class:selected={install.path === store.selectedInstall}
          aria-pressed={install.path === store.selectedInstall}
          title="{type.label} at {install.path}"
          onclick={() => store.selectInstall(install.path)}
        >
          <img class="icon" src={ICON[install.type]} alt={type.label} width="32" height="32" />
          <span class="text">
            <span class="top">
              <!-- The folder is what tells two installs apart; the mod is the badge and the icon. -->
              <span class="name">{install.path.split("/").filter(Boolean).pop() ?? install.path}</span>
              <span class="badge">{type.badge}</span>
            </span>
            <span class="path">{install.path}</span>
          </span>
        </button>
      </li>
    {:else}
      <li class="empty">No installs yet.</li>
    {/each}
  </ul>

  <!-- Says which install the preview is actually editing, rather than letting one entry imply a real scan. -->
  <p class="note">The bundled fixture, until the desktop build can scan for real installs.</p>

  <div class="buttons">
    <!--
      Adding has to read a directory to decide whether it holds a game at all, so it can do nothing until the
      platform layer exists. Shown disabled rather than hidden, so the column is not silently missing it.
    -->
    <button disabled title="Needs the desktop build - the browser preview cannot read directories">
      Add game
    </button>
    <button class="remove" disabled={!current} onclick={() => current && store.removeInstall(current.path)}>
      Remove from list
    </button>
  </div>
</div>

<style>
  .panel {
    padding: 10px;
  }

  .installs {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .install {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 6px 8px;
  }

  .icon {
    flex: 0 0 auto;
    border-radius: 4px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .install:hover {
    background: var(--panel-alt);
  }

  .install.selected {
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  .install .top {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .name {
    font-weight: 550;
    font-size: 12.5px;
  }

  .badge {
    font-family: var(--mono);
    font-size: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    color: var(--text-dim);
  }

  /*
    Wrapped rather than truncated. Ellipsis from the left would hide the part that distinguishes two installs,
    and `direction: rtl` - which does keep the tail - reorders the leading slash to the end, so the path renders
    as something the user does not have.
  */
  .path {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0 0 8px;
    font-size: 11px;
    color: var(--text-faint);
    line-height: 1.4;
  }

  .empty {
    color: var(--text-faint);
    font-size: 12.5px;
    padding: 6px 8px;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .buttons button {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 3px 10px;
    color: var(--text-dim);
    font-size: 12px;
  }

  .buttons button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
