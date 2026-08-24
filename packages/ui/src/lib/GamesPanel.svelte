<script lang="ts">
  import { GAME_TYPES, displayName } from "@zax/core";
  import { isPreview, PREVIEW_REASON } from "./host.js";
  import { GAME_ICON } from "./icons.js";
  import { store } from "./store.svelte.js";

  const current = $derived(store.install);

  let adding = $state(false);
  let candidate = $state("");

  function submit() {
    void store.addInstall(candidate).then(() => {
      candidate = "";
      adding = false;
    });
  }

  /** Renaming a row means selecting it first, so the field that opens belongs to the row you asked about. */
  function rename(path: string) {
    void store.selectInstall(path).then(() => store.renameSelected());
  }
</script>

<div class="panel">
  <ul class="installs">
    {#each store.installs as install (install.path)}
      {@const type = GAME_TYPES[install.type]}
      <li>
        <!--
          Right-click renames, which is what a list of named things is expected to do; F2 is handled for the
          window, so it works without the row holding focus. Neither is discoverable, so the tooltip says so.
        -->
        <button
          class="install"
          class:selected={install.path === store.selectedInstall}
          aria-pressed={install.path === store.selectedInstall}
          title="{type.label} at {install.path}&#10;Right-click or press F2 to rename"
          onclick={() => void store.selectInstall(install.path)}
          oncontextmenu={(event) => {
            event.preventDefault();
            rename(install.path);
          }}
        >
          <img class="icon" src={GAME_ICON[install.type]} alt={type.label} width="32" height="32" />
          <span class="text">
            <span class="top">
              <!-- The path below is what tells two installs of one type apart; the name says what the game is. -->
              <span class="name">{displayName(install)}</span>
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

  {#if isPreview}
    <!-- Says which install the preview is actually editing, rather than letting one entry imply a real scan. -->
    <p class="note">The bundled fixture, edited in memory. Nothing here reaches a real game folder.</p>
  {/if}

  {#if adding}
    <!-- Typing stays alongside the picker: a browser has no picker, and a path can be pasted from elsewhere. -->
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input aria-label="Path to the game folder" placeholder="Path to the game folder" bind:value={candidate} />
      <div class="buttons">
        <button type="submit" disabled={candidate.trim() === ""}>Add</button>
        <!-- The picker belongs to the desktop shell; typing a path is what a browser is left with. -->
        <button
          type="button"
          disabled={isPreview}
          title={isPreview ? PREVIEW_REASON : null}
          onclick={() => void store.browseForInstall().then(() => (adding = false))}
        >
          Browse...
        </button>
        <button type="button" onclick={() => (adding = false)}>Cancel</button>
      </div>
    </form>
  {:else}
    <div class="buttons">
      <button onclick={() => (adding = true)}>Add game</button>
      <button class="remove" disabled={!current} onclick={() => current && void store.removeInstall(current.path)}>
        Remove from list
      </button>
    </div>
  {/if}
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
    /* Takes the rest of the row so the badge has an edge to sit against, and the path has the full width. */
    flex: 1;
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
    /* Against the far edge rather than beside the name, which read as part of it however long the name was. */
    margin-left: auto;
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

  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 6px;
  }

  /* Monospaced because the only field here holds a path. */
  .form input {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 3px 7px;
    font-family: var(--mono);
    font-size: 11.5px;
    min-width: 0;
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
