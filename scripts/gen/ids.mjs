/**
 * The id that joins the catalog, the layout, the actions and search - minted in one place so the generators
 * cannot drift apart in deriving it. gen-layout's check against the generated catalog catches a rename, but
 * two copies of the derivation could disagree without renaming anything the check would notice.
 */

const slugPrefix = { "fallout2.cfg": "game", "f2_res.ini": "hires", "ddraw.ini": "sfall" };

// The section and key ride into the id verbatim - the same rule mod manifests use, so an id is always the
// prefix plus the address as the file spells it, with no transform to remember. The characters an id may
// carry are therefore bounded here, and a name outside the bound fails generation rather than minting an id
// other consumers cannot address.
const piece = (s) => {
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new Error(`"${s}" cannot become an id piece`);
  return s;
};

export const idFor = (file, section, key) => `${slugPrefix[file]}.${piece(section)}.${piece(key)}`;
