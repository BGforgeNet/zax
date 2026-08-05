/** Config files ZAX manages, in the order they are presented. */
export const CONFIG_FILES = ["fallout2.cfg", "f2_res.ini", "ddraw.ini"] as const;

export type ConfigFile = (typeof CONFIG_FILES)[number];
