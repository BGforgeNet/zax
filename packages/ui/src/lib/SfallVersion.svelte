<script lang="ts">
  /*
    The previous interface showed the installed sfall version beside the latest release, with a check and an
    update button. Both reads need the platform - the installed version comes from ddraw.dll, the latest from
    the network - so they are shown with the reason rather than omitted.
  */
  const OFFLINE = "Needs the desktop build - the browser preview cannot read ddraw.dll or reach the network";
</script>

<div class="row">
  <div class="label"><span class="name">sfall version</span></div>
  <div class="control">
    <span class="unknown">not detected</span>
  </div>
  <div class="notes">
    <span class="help">Latest release: <span class="unknown">not checked</span></span>
    <span class="buttons">
      <button disabled title={OFFLINE}>Check</button>
      <button disabled title={OFFLINE}>Update</button>
    </span>
    <span class="unavailable">{OFFLINE}</span>
  </div>
</div>

<style>
  .unknown {
    color: var(--text-faint);
    font-style: italic;
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }

  .buttons button {
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 2px 11px;
    color: var(--text-dim);
    font-size: 12px;
  }

  .buttons button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .unavailable {
    color: var(--modified);
  }
</style>
