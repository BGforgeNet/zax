<script lang="ts">
  import { compareVersions } from "@zax/core";
  import { isPreview } from "./host.js";
  import { store } from "./store.svelte.js";
  import { VERSION } from "./version.js";

  /*
    Version checks and opening a directory in the desktop's file manager both leave the page, which the browser
    preview cannot do. Shown disabled with the reason rather than hidden, so the column says what the desktop
    build does instead of quietly omitting it. Wiping is a filesystem write, so it runs either way.
  */
  const OUTSIDE = "The browser preview has no machine to reach - this needs the desktop build";
  const outdated = $derived(store.zaxLatest !== null && compareVersions(VERSION, store.zaxLatest) < 0);
</script>

<div class="panel">
  <h2 class="section">Version</h2>
  <p class="line">Current <strong>{VERSION}</strong></p>
  <p class="line">
    Latest
    {#if store.zaxLatest}<strong>{store.zaxLatest}</strong>{:else}<span class="unknown">not checked</span>{/if}
  </p>
  <div class="buttons">
    <button disabled={isPreview || store.busy !== null} title={isPreview ? OUTSIDE : null} onclick={() => void store.checkZaxVersion()}>
      Check
    </button>
    <!-- ZAX does not replace its own running binary; the release page is where the new one comes from. -->
    <button
      disabled={!outdated || isPreview}
      title={outdated ? "Open the release page" : "Nothing newer has been found"}
      onclick={() => void store.open("releases")}
    >
      Download latest
    </button>
  </div>

  <h2 class="section">Auto scan for games</h2>
  <div class="buttons">
    <button disabled={store.busy !== null} onclick={() => void store.scan()}>Scan</button>
  </div>

  <h2 class="section">Backup directory</h2>
  <p class="path">{store.paths.backup}</p>
  <div class="buttons">
    <button disabled={isPreview} title={isPreview ? OUTSIDE : null} onclick={() => void store.open("backup")}>
      Open
    </button>
    <button disabled={store.busy !== null} onclick={() => void store.wipe("backup")}>Wipe</button>
  </div>

  <h2 class="section">sfall packages</h2>
  <p class="path">{store.paths.packages}</p>
  <div class="buttons">
    <button disabled={isPreview} title={isPreview ? OUTSIDE : null} onclick={() => void store.open("packages")}>
      Open
    </button>
    <!-- Emptying costs nothing but a download next time, which is what makes this a cache rather than state. -->
    <button disabled={store.busy !== null} onclick={() => void store.wipe("packages")}>Wipe</button>
  </div>

  <h2 class="section">Debug archive directory</h2>
  <p class="path">{store.paths.debug}</p>
  <div class="buttons">
    <button disabled={isPreview} title={isPreview ? OUTSIDE : null} onclick={() => void store.open("debug")}>
      Open
    </button>
    <button disabled={store.busy !== null} onclick={() => void store.wipe("debug")}>Wipe</button>
  </div>

  <h2 class="section">Log file</h2>
  <p class="path">{store.paths.log}</p>
  <div class="buttons">
    <button disabled={isPreview} title={isPreview ? OUTSIDE : null} onclick={() => void store.open("log")}>
      View
    </button>
  </div>

  <!-- The only one that needs nothing outside the page, so the only one that works. -->
  <h2 class="section">Theme</h2>
  <label class="field">
    <select
      aria-label="Theme"
      value={store.theme}
      onchange={(e) => void store.setTheme(e.currentTarget.value as typeof store.theme)}
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
