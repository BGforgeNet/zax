<script lang="ts">
  import { displayValue, sentinelLabel, validate, valueLabel, type SettingDef } from "@zax/core";
  import Control from "./Control.svelte";
  import { store } from "./store.svelte.js";

  // `where` is set only by the search results, where a row has been lifted out of the tab that located it.
  // `onGo` makes that address the way back, rather than a second control competing for the same space.
  let {
    def,
    nested = false,
    where = "",
    onGo,
    control,
    group,
  }: {
    def: SettingDef;
    nested?: boolean;
    where?: string;
    onGo?: () => void;
    control?: string;
    /** The group of tabs this row is drawn under, which picks the address of a setting that has several. */
    group?: string | undefined;
  } = $props();

  // The address this row edits. A linked setting has more than one, and which of them a row shows follows the
  // tab it sits on: the same setting is a different key, under a different gate, on each component's tab.
  const address = $derived(store.targetFor(def, group));
  // A controller in another file carries its address inline - the one exemption from the same-tab rule.
  const elsewhere = (other: SettingDef) => {
    const file = store.targetFor(other, group).file;
    return file === address.file ? "" : ` (${file})`;
  };

  // The whole tab is refused: the engine is installed but has not written its settings yet.
  const refused = $derived(group !== undefined && store.groupRefusal(group) !== null);
  const modified = $derived(store.isModified(def.id));
  // Where the value came from, when it was not typed here. A row that is marked changed with nothing on
  // screen saying why reads as ZAX having edited the install on its own.
  const carriedFrom = $derived(store.propagated[def.id]);
  const value = $derived(store.valueOf(def.id));
  const validation = $derived(validate(def, value));
  const sentinel = $derived(sentinelLabel(def, value));
  // Not while the whole tab is refused: nothing there is in the file yet, so the note is true of every row
  // at once and the banner above them already says it. Repeated down the column it is noise, and it crowds
  // out the notes that do differ per row.
  const absent = $derived(store.isAbsent(def.id) && !store.isModified(def.id) && !refused);
  const gate = $derived(store.gateOf(def, group));
  // Null where the chain cannot be written from here - a pinned value, a missing file, a gate naming no one
  // value. The note then stands alone and the user sets the controller themselves, as they did before.
  const requirements = $derived(store.requirementsFor(def, group));
  // Where the note pins one value, "set it" says enough. Where it names a range - "DX9 fullscreen or DX9
  // windowed or ..." - the link says which of them the click writes, rather than leaving the user to find out.
  /**
   * Everything the row waits on, listed flat and each phrased the same way. A controller that is itself gated
   * blocks this row just as much, and which of them waits on which is not something the reader has to work
   * out - what matters is that all of them have to be set, which is what the button does.
   */
  const needs = $derived.by(() => {
    if (!gate) return "";
    // Only the first link is known when the chain cannot be walked to the end.
    const links = requirements ?? [{ def: gate.controller, wants: gate.wants }];
    return links
      .map((link, at) =>
        nested && at === 0 ? `${link.wants} above` : `${link.def.label}${elsewhere(link.def)} = ${link.wants}`,
      )
      .join(", ");
  });

  const fixWord = $derived.by(() => {
    const first = requirements?.[0];
    if (!requirements || !first || !gate) return "";
    if (requirements.length === 2) return "set both";
    if (requirements.length > 2) return `set all ${requirements.length}`;
    const pinned = "is" in gate.test && gate.test.is.length === 1;
    return pinned ? "set it" : `set ${valueLabel(first.def, first.value)}`;
  });
  const conflict = $derived(store.conflictOf(def));
  const managed = $derived(def.managed);
  const inert = $derived(gate !== null && !gate.active);
  const origin = $derived(`${address.file} [${address.section}] ${address.key}`);
  // What the same value is written to elsewhere. Named in full - file, section and key - because that is what
  // makes the claim checkable against the file itself, which is the point of showing it at all.
  const linked = $derived(store.linkedTo(def, group));
  const linkNote = $derived.by(() => {
    if (linked.length === 0) return "";
    const say = (one: { at: { file: string; section: string; key: string }; live: boolean }) =>
      `${one.at.file} [${one.at.section}] ${one.at.key}${one.live ? "" : " (not until that engine has run)"}`;
    return `The same value is written to ${linked.map(say).join(", ")}`;
  });

  // The component this setting belongs to is not installed, or an engine installed here has not yet written
  // its settings. Editing would write a config file for it, which is not a thing to do on the user's behalf,
  // so the row reads but does not take input.
  const unavailable = $derived(store.install !== undefined && (!store.hasFile(address.file) || refused));
</script>

<div class="row" class:modified class:inert class:nested>
  <div class="label">
    <!-- The tab already names the file, so only the hover still spells out which key this writes. -->
    <!--
      A chain rather than a word: the row's own labels are the setting's, and a second one competing with them
      would read as part of the name. The tooltip is its accessible name too, since nothing else on the row
      says the value goes anywhere but here.

      Leading, in a slot every row reserves, rather than after the label: the label column is nearly full at
      its longest, so a trailing marker lands alone on a second line under exactly the rows whose names are
      hardest to read. Leading it cannot orphan, the reserved width keeps every label starting at one x, and
      the shared rows become scannable down the column instead of something to hunt for.
    -->
    <span class="mark" aria-hidden={linkNote ? undefined : "true"}>
      {#if linkNote}
        <span class="linked" role="img" aria-label={linkNote} title={linkNote}>
          <svg viewBox="0 0 12 12" focusable="false">
            <path d="M5 7a2 2 0 0 0 3 0l2-2a2 2 0 0 0-3-3l-.6.6" />
            <path d="M7 5a2 2 0 0 0-3 0L2 7a2 2 0 0 0 3 3l.6-.6" />
          </svg>
        </span>
      {/if}
    </span>
    <span class="name" title={origin}>{def.label}</span>
    {#if where && onGo}
      <button class="badge go" title="Go to {where}" onclick={onGo}>{where}</button>
    {:else if where}
      <span class="badge" title={origin}>{where}</span>
    {/if}
  </div>

  <div class="control">
    {#if managed}
      <span class="pinned">{displayValue(def, managed.value)}</span>
    {:else}
      <!--
        A fieldset so one attribute disables whichever control this row draws. A gated setting is disabled as
        well as dimmed: the game ignores it until its controller is set, so an edit here would write a value
        that does nothing, and the note beside it says which control to reach for instead.
      -->
      <fieldset class="controls" disabled={unavailable || inert}>
        <Control {def} {control} />
      </fieldset>
    {/if}
  </div>

  <div class="notes">
    {#if def.help}<span class="help">{def.help}</span>{/if}
    {#if managed}<span class="note">{managed.reason}</span>{/if}
    {#if inert && gate}
      <span class="gate">
        needs {needs}
        {#if requirements && fixWord}
          <button class="fix" onclick={() => store.satisfyGate(def, group)}>{fixWord}</button>
        {/if}
      </span>
    {/if}
    {#if conflict}
      <span class="clash" role="alert">clashes with {conflict.other.label}: {conflict.note}</span>
    {/if}
    {#if absent}
      <span class="absent" title="Setting it here adds the key to the file">
        not in your config - the game uses its default
      </span>
    {/if}
    {#if carriedFrom}
      <span class="carried">changed in {carriedFrom} - save to keep it, or revert</span>
    {/if}
    {#if sentinel}<span class="sentinel">{sentinel}</span>{/if}
    {#if !validation.ok}<span class="invalid" role="alert">{validation.reason}</span>{/if}
  </div>

  <!-- At the row's end rather than beside the label: the row's colour already says it changed, this undoes it. -->
  {#if modified}
    <button class="revert" onclick={() => store.revert(def.id)}>revert</button>
  {/if}
</div>

<style>
  /* Faint: it qualifies the label rather than competing with it, and every linked row carries one. */
  .linked svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--text-faint);
    vertical-align: -1px;
  }

  /* Carries no appearance of its own: it is here to disable, not to draw a box. */
  .controls {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }

  .controls:disabled {
    opacity: 0.55;
  }

  .go {
    border: 1px solid transparent;
    cursor: pointer;
  }

  .go:hover {
    border-color: var(--accent);
  }

  .pinned {
    color: var(--text-faint);
    font-style: italic;
  }
</style>
