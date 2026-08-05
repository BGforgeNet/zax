<script lang="ts">
  import { store } from "./store.svelte.js";

  const VERSION = "0.8";

  /*
    Everything here but the theme reaches outside the application - the network for a version check, the cache
    directory for the rest - so none of it can run in the browser preview. Shown disabled with the reason rather
    than hidden, so the column says what the desktop build does instead of quietly omitting it.
  */
  const OFFLINE = "Needs the desktop build - the browser preview has no filesystem or network access";
</script>

<div class="panel">
  <h2 class="section">Version</h2>
  <p class="line">Current <strong>{VERSION}</strong></p>
  <p class="line">Latest <span class="unknown">not checked</span></p>
  <div class="buttons">
    <button disabled title={OFFLINE}>Check</button>
    <button disabled title={OFFLINE}>Download latest</button>
  </div>

  <h2 class="section">Auto scan for games</h2>
  <div class="buttons">
    <button disabled title={OFFLINE}>Scan</button>
  </div>

  <h2 class="section">Backup directory</h2>
  <p class="path">{"<cache>/zax/backup"}</p>
  <div class="buttons">
    <button disabled title={OFFLINE}>Open</button>
    <button disabled title={OFFLINE}>Wipe</button>
  </div>

  <h2 class="section">Debug archive directory</h2>
  <p class="path">{"<cache>/zax/debug"}</p>
  <div class="buttons">
    <button disabled title={OFFLINE}>Open</button>
    <button disabled title={OFFLINE}>Wipe</button>
  </div>

  <h2 class="section">Log file</h2>
  <p class="path">{"<cache>/zax/zax.log"}</p>
  <div class="buttons">
    <button disabled title={OFFLINE}>View</button>
  </div>

  <!-- The only one that needs nothing outside the page, so the only one that works. -->
  <h2 class="section">Theme</h2>
  <label class="field">
    <select
      aria-label="Theme"
      value={store.theme}
      onchange={(e) => (store.theme = e.currentTarget.value as typeof store.theme)}
    >
      <option value="system">Match the system</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
  <!-- The previous implementation needed a restart to change theme; this one does not, so it says so. -->
  <p class="note">Applies straight away.</p>
</div>

<style>
  .panel {
    padding: 10px;
  }

  .section {
    margin: 14px 0 5px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .section:first-child {
    margin-top: 2px;
  }

  .line {
    margin: 0 0 2px;
    font-size: 12.5px;
    color: var(--text-dim);
  }

  .unknown {
    color: var(--text-faint);
    font-style: italic;
  }

  .path {
    margin: 0 0 6px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    overflow-wrap: anywhere;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 5px;
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

  .field select {
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 3px 7px;
    font-size: 12px;
  }

  .note {
    margin: 4px 0 0;
    font-size: 11.5px;
    color: var(--text-faint);
  }
</style>
