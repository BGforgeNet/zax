/**
 * The id that joins the catalog, the layout, the actions and search - minted in one place so the generators
 * cannot drift apart in deriving it. gen-layout's check against the generated catalog catches a rename, but
 * two copies of the slugging could disagree without renaming anything the check would notice.
 */

const slugPrefix = { "fallout2.cfg": "game", "f2_res.ini": "hires", "ddraw.ini": "sfall" };

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const idFor = (file, section, key) => `${slugPrefix[file]}.${norm(section)}.${norm(key)}`;
