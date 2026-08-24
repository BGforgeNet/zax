/**
 * The manifests ZAX carries for mods that publish none.
 *
 * Every base mod the design names describes itself nowhere: no release of RPU, UPU or Fallout et tu ships an
 * `f2mod.yml`, by either route, so without this the mods tab has nothing to offer on any install. A vendored
 * manifest is the same document upstream would commit, held here and parsed by `parseManifest` with no
 * separate route behind it - the same argument as the grants in `mod-grants.ts`, the load order in
 * `recommended-order.ts` and the tool pin in `dat-tool.ts`: a judgement ZAX makes on the user's behalf,
 * reviewable in the source, changing only with a ZAX release. Keyed by id alone, as `grantsFor` is.
 *
 * Anything the author publishes wins over the copy here, by either route, so adopting the format costs them no
 * coordination: it takes effect on their next release and the entry below is then deleted. A tag ZAX has
 * already found nothing at is not asked again, so the switch is a new release rather than a new commit.
 *
 * The ids are minted here from upstream's own naming (`#define basename "rpu"`, the `Fo1in2` repository), which
 * is what an author adopting the format would most likely pick anyway - with the release line appended where a
 * repository publishes two, since one id per line is what makes them two mods rather than one with a branch. If one picks differently, their feed row
 * stops matching and the mod reads as unfollowed until a ZAX release corrects the row - the whole cost, because
 * these three name no setting and put nothing in `mods/` (see `mod-grants.ts`). A fallback id on the row, and a
 * record migration, were both considered and are not built: they buy a seamless handover for a case that costs
 * an already-installed user nothing but updates, and only until the next release.
 *
 * Each document is a function of the release's version because both BGforge assets carry the version in their
 * names. Interpolating rather than substituting a placeholder keeps a misspelling a compile error instead of
 * an asset name that reaches a user matching nothing.
 *
 * RPU's and UPU's component trees are upstream's own, read from `extra/inno/inno.iss` and its includes in each
 * repository. The fragments below are shared by both documents because upstream shares them: the same
 * `components_translations.iss` and `components_ammo.iss` sit in both repositories, and both installers are
 * built from the same script. A tree that diverges takes a copy of its fragment rather than editing it here.
 */

export interface VendoredManifest {
  /** The id the document declares, which is what its feed row follows. */
  id: string;
  /** The document, for a release at this version. */
  text: (version: string) => string;
}

/** What the installer always selects. Inno marks it `fixed`; `required` is what passes it to `/COMPONENTS`. */
const CORE = `      - label: The mod itself
        pick: any
        options:
          - id: core
            label: Core files
            required: true
            help: Everything the mod is - its data, the sfall and hi-res patch builds it ships, and the config
              they need.`;

/**
 * The ten languages both BGforge installers offer. English installs no file and writes no `language` key -
 * it is the game left as it is - and is offered rather than left implicit so that picking it and picking
 * nothing are the same install, both deliberate.
 */
const LANGUAGES = `      - label: Language
        pick: one
        options:
          - id: translation\\english
            label: English
            help: What the mod ships. No translation file is installed.
          - id: translation\\czech
            label: Czech
          - id: translation\\french
            label: French
          - id: translation\\german
            label: German
          - id: translation\\hungarian
            label: Hungarian
          - id: translation\\italian
            label: Italian
          - id: translation\\polish
            label: Polish
          - id: translation\\portuguese
            label: Portuguese
          - id: translation\\russian
            label: Russian
          - id: translation\\spanish
            label: Spanish`;

/** The formulas sfall's `DamageFormula` selects, which is the setting each of these writes. */
const AMMO = `      - label: Ammo damage formula
        pick: one
        options:
          - id: ammo\\default
            label: Default
            help: Fallout 2's own formula (sfall DamageFormula 0).
          - id: ammo\\glovz
            label: Glovz's
            help: sfall DamageFormula 1.
          - id: ammo\\yaam
            label: YAAM
            help: sfall DamageFormula 5.`;

const WALK_SPEED = `      - label: Walk speed fix
        pick: one
        options:
          - id: walk_speed\\high_fps
            label: High FPS
          - id: walk_speed\\low_fps
            label: Low FPS`;

const GORIS = `      - label: Faster derobing for Goris
        pick: one
        options:
          - id: goris\\high_fps
            label: High FPS
          - id: goris\\low_fps
            label: Low FPS`;

const QOL = `          - id: qol
            label: Enable sfall QoL features
            help: Turns on a set of sfall options - the action point bar, damage and karma readouts, party
              member details and more.`;

const rpu =
  (id: string, name: string) =>
  (version: string): string => `spec: 1
id: ${id}
name: ${name}
game: fallout2
type: base
becomes: fallout2rpu
installer:
  windows:
    asset: rpu_v${version}.exe
    silent: inno
    components:
${CORE}
${LANGUAGES}
${AMMO}
${WALK_SPEED}
${GORIS}
      - label: Weapon animations
        pick: any
        options:
          - id: wpn_anims\\rifle
            label: New rifle animations
          - id: wpn_anims\\wakizashi
            label: New wakizashi blade animations
          - id: wpn_anims\\ext_flamer
            label: Extended flamer attack animations
      - label: Extras
        pick: any
        options:
${QOL}
          - id: worldmap
            label: Visually enhanced world map
          - id: cassidy_head
            label: Talking head and voice for Cassidy
          - id: imp_stranger
            label: Improved Mysterious Stranger
          - id: alternative_explosions
            label: Alternative explosion animations (from Tactics)
  other:
    asset: rpu_v${version}.zip
    run: rpu-install.sh
`;

const upu = (version: string): string => `spec: 1
id: upu
name: Unofficial Patch Updated
game: fallout2
type: base
becomes: fallout2upu
installer:
  windows:
    asset: upu_v${version}.exe
    silent: inno
    components:
${CORE}
${LANGUAGES}
${AMMO}
${WALK_SPEED}
${GORIS}
      - label: Extras
        pick: any
        options:
${QOL}
  other:
    asset: upu_v${version}.zip
    run: upu-install.sh
`;

/**
 * Fallout et tu, whose asset name carries no version and whose facts are slice 5's, read off the shipped
 * `v1.16.3771`: one top-level `Fallout1in2/` in the payload, `undat_files.txt` inside it, and Fallout 1's
 * `master.dat` the file the folder it asks for must hold.
 */
const fo1in2 = (): string => `spec: 1
id: fo1in2
name: Fallout et tu
game: fallout2
type: base
becomes: fo1in2
archive: Fallout1in2.zip
creates:
  directory: Fallout1in2
inputs:
  - id: fallout1
    label: Your Fallout 1 folder
    help: The folder holding Fallout 1's MASTER.DAT. Fallout et tu unpacks the game's art and sound from it.
    holds: master.dat
extract-dat:
  from: fallout1
  list: undat_files.txt
  into: data
`;

export const VENDORED_MANIFESTS: readonly VendoredManifest[] = [
  // One document per release line, differing in nothing but which mod it says it is: the two ship in lockstep
  // from one repository and one installer, and only the tag they are built from tells them apart.
  { id: "rpu23", text: rpu("rpu23", "Restoration Project Updated 2.3") },
  { id: "rpu24", text: rpu("rpu24", "Restoration Project Updated 2.4") },
  { id: "upu", text: upu },
  { id: "fo1in2", text: fo1in2 },
];

/**
 * The document ZAX carries for this mod id, or nothing where it carries none. Returns the document rather than
 * its text because the feed asks both questions - whether a row is one ZAX describes, and what it then says.
 */
export function vendoredManifestFor(id: string): VendoredManifest["text"] | undefined {
  return VENDORED_MANIFESTS.find((entry) => entry.id === id)?.text;
}
