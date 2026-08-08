<script lang="ts">
  /*
    Which High Resolution Patch the install has, read from f2_res.dll rather than from f2_res.ini: the config
    file survives an uninstall, so it does not say whether anything is reading it.

    Read-only, unlike the sfall block this mirrors. The patch is distributed from a forum thread rather than a
    release feed, so there is nothing to check a version against or to install from.
  */
  import { store } from "./store.svelte.js";
</script>

<div class="frame" data-depth="0">
  <h2 class="frame-title">Patch</h2>
  <div class="row">
    <div class="label"><span class="name">Version</span></div>
    <div class="control">
      {#if store.hiresInstalled}
        <strong>{store.hiresInstalled}</strong>
      {:else}
        <span class="unknown">not installed</span>
      {/if}
    </div>
    <div class="notes">
      <span class="help">
        {#if store.hiresInstalled}
          From f2_res.dll. ZAX does not install or update the patch.
        {:else}
          These settings are here because f2_res.ini is, but nothing reads them without f2_res.dll.
        {/if}
      </span>
    </div>
  </div>
</div>

<style>
  .unknown {
    color: var(--text-faint);
    font-style: italic;
  }
</style>
