/**
 * The id that joins the catalog, the layout, the actions and search - minted in one place so the generators
 * cannot drift apart in deriving it. gen-layout's check against the generated catalog catches a rename, but
 * two copies of the derivation could disagree without renaming anything the check would notice.
 */

// One per file a setting can be minted from. fallout2-ce writes its own keys into the game's config file, so
// they take that file's prefix like any other key in it; only Fission keeps a file of its own.
const slugPrefix = { "fallout2.cfg": "game", "f2_res.ini": "hires", "ddraw.ini": "sfall", "fission.cfg": "fission" };

// The section and key ride into the id verbatim - the same rule mod manifests use, so an id is always the
// prefix plus the address as the file spells it, with no transform to remember. The characters an id may
// carry are therefore bounded here, and a name outside the bound fails generation rather than minting an id
// other consumers cannot address.
const piece = (s) => {
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new Error(`"${s}" cannot become an id piece`);
  return s;
};

export const idFor = (file, section, key) => {
  const prefix = slugPrefix[file];
  // Without this a file nothing has a prefix for mints "undefined.Section.Key", which addresses nothing and
  // looks like a setting until something tries to find it.
  if (prefix === undefined) throw new Error(`no id prefix for "${file}"`);
  return `${prefix}.${piece(section)}.${piece(key)}`;
};
