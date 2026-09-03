# Parts

A release that publishes several payloads and asks which of them to install - HQ music's four packages,
Cassidy's head and its three voices - declares them as groups of options.

```yaml
parts:
  - label: Head
    pick: any
    options:
      - id: head
        label: Cassidy's new head
        archive: cassidy_head.dat
        entries: [cassidy_head.dat]
  - label: Voice
    pick: one
    options:
      - id: voice-joey
        label: Joey Bracken
        help: The voice from the original release.
        archive: cassidy_voice_joey_bracken_hq.dat
        entries: [cassidy_voice_joey_bracken_hq.dat]
        needs: head
```

`pick: one` takes at most one of the group - a group may end with nothing chosen - and `pick: any` makes each
option independently on or off. Every part names its own release asset, an archive or a single file as
[Fields](fields.md) has it, and its own `entries`; a manifest with `parts` states no top-level `archive`. A part
may name one other part it `needs`, in any group, and is not offered while that one is unselected. Groups and
options are shown in the order the manifest declares them.

**A part id is as permanent as the mod's.** The install records which parts were chosen, and the next release is
matched against that record by id: a renamed part reads as one part removed and another added, so the user loses
the choice they made. A part the release stops offering is dropped, with the upgrade saying so; a part newly
offered starts off; a `one` group whose choice is gone puts the question back to the user.

A group asking for something ZAX does not implement - any `pick` beyond these two - refuses as needing a newer
ZAX. Unlike a settings entry, what a group picks decides what lands on disk, so there is nothing safe to assume
about one that cannot be read.
