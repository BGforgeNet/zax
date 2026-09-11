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
 * No document names an installer asset. Both BGforge assets carry the version in their names, and the release
 * is what knows it: the Windows route resolves to the release's sole `.exe` and the other to its sole archive.
 * That also survives an upstream rename, where a name spelled here would go on missing until ZAX shipped again.
 *
 * None of them describes what its installer offers, and that is the point: a copy of upstream's component tree
 * kept here would be a second home for a table `extra/inno/inno.iss` already owns, going stale against the next
 * release with nothing to notice. The wizard reads it out of the executable the user downloaded instead
 * (`innoArguments` in `mod-base.ts` carries the argument).
 */

export interface VendoredManifest {
  /** The id the document declares, which is what its feed row follows. */
  id: string;
  /** The document, which states no version and names no asset - the release supplies both. */
  text: string;
}

const rpu = (id: string, name: string): string => `spec: 1
id: ${id}
name: ${name}
game: fallout2
type: base
becomes: fallout2rpu
installer:
  windows:
    built-with: inno
  other:
    run: rpu-install.sh
`;

const upu = `spec: 1
id: upu
name: Unofficial Patch Updated
game: fallout2
type: base
becomes: fallout2upu
installer:
  windows:
    built-with: inno
  other:
    run: upu-install.sh
`;

/**
 * Fallout et tu, whose asset name carries no version and whose facts are slice 5's, read off the shipped
 * `v1.16.3771`: one top-level `Fallout1in2/` in the payload, `undat_files.txt` inside it, and Fallout 1's
 * `master.dat` the file the folder it asks for must hold.
 */
const fo1in2 = `spec: 1
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
