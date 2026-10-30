<script lang="ts">
  /*
    One engine's caution, drawn the same wherever it appears - beside the engine in the list, over the mods it
    can actually load, and in front of the launch. Three sites drawing it themselves is three things to keep in
    step, and a warning that looks different in each place reads as three different warnings.
  */
  interface Props {
    text: string;
    /** The heading, where a site needs to say what the caution is about rather than what it is. */
    title?: string;
  }

  let { text, title = "Before you run this" }: Props = $props();
</script>

<!-- The word carries the meaning as well as the colour does, which is what keeps it legible in grayscale and
     to anyone who cannot separate the amber from the body text. -->
<div class="caution">
  <p class="title">{title}</p>
  <p class="body">{text}</p>
</div>

<style>
  /*
    The amber the unsaved marks use rather than the invalid red: nothing is wrong here, and a red block beside an
    engine that installs and runs correctly reads as a fault report. The rule carries it at a glance; the box is
    tinted rather than outlined so it separates from the rows around it without drawing a second border.
  */
  .caution {
    border-left: 3px solid var(--modified);
    border-radius: 4px;
    background: var(--modified-soft);
    padding: 7px 11px;
    margin: 6px 0;
  }

  .title {
    margin: 0 0 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--modified);
  }

  /*
    Body text in the ordinary colour rather than the amber: the sentence has to stay readable, and the tinted
    ground is already under the contrast the dim tones were measured against.
  */
  .body {
    margin: 0;
    max-width: 68ch;
    font-size: 12.5px;
    color: var(--text);
  }
</style>
