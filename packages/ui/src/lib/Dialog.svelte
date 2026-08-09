<script lang="ts">
  /*
    The one modal in the interface, so a confirmation and a picker cannot drift into two different shapes.

    Built on the native `dialog`: the browser supplies the top layer, the focus trap, the backdrop and the
    Escape key, all of which a div would have to reimplement and would get subtly wrong.
  */
  import type { Snippet } from "svelte";

  interface Props {
    open: boolean;
    title: string;
    /** Called for every way out - Escape, the backdrop, the close button - so the caller clears its own flag. */
    dismiss: () => void;
    children: Snippet;
    footer?: Snippet;
  }

  let { open, title, dismiss, children, footer }: Props = $props();

  let element = $state<HTMLDialogElement | null>(null);

  // The element owns the open state as far as the browser is concerned, so the prop is pushed onto it rather
  // than mirrored: calling showModal on an already-open dialog throws.
  $effect(() => {
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  });
</script>

<dialog
  bind:this={element}
  oncancel={(event) => {
    // Escape closes the element directly; cancelling lets the caller's flag stay the single source of truth.
    event.preventDefault();
    dismiss();
  }}
  onclick={(event) => {
    // A click that lands on the dialog itself rather than its contents is a click on the backdrop.
    if (event.target === element) dismiss();
  }}
>
  <div class="frame">
    <div class="head">
      <h2>{title}</h2>
      <button class="close" aria-label="Close" onclick={dismiss}>&times;</button>
    </div>
    <div class="body">
      {@render children()}
    </div>
    {#if footer}
      <div class="foot">
        {@render footer()}
      </div>
    {/if}
  </div>
</dialog>

<style>
  dialog {
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--panel);
    color: var(--text);
    max-width: min(560px, 92vw);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 45%);
  }

  .frame {
    display: flex;
    flex-direction: column;
    /* Bounded here rather than on the body, so a long list scrolls inside the dialog and the footer stays put. */
    max-height: min(70vh, 560px);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .close {
    background: none;
    border: none;
    padding: 0 4px;
    font-size: 18px;
    line-height: 1;
    color: var(--text-faint);
  }

  .body {
    overflow-y: auto;
    padding: 12px;
  }

  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
  }
</style>
