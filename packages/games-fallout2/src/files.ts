/** Config files ZAX manages, in the order they are presented. */
export const CONFIG_FILES = ["fallout2.cfg", "f2_res.ini", "ddraw.ini"] as const;

export type ConfigFile = (typeof CONFIG_FILES)[number];

/**
 * Config files an alternative engine keeps, which the catalog's linked settings already address. Kept apart
 * from CONFIG_FILES because reaching one needs the engine installed and, for the content config, the
 * `master_patches` setting resolved: until then a target in one of them is simply never written.
 *
 * fallout2.cfg is absent on purpose - fallout2-ce writes its own sections into the game's own config file,
 * which ZAX already manages.
 */
export const ENGINE_CONFIG_FILES = ["fission.cfg", "game#patch.cfg"] as const;
