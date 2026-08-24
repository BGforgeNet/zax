import type { GameType } from "@zax/core";

import bgforge from "../assets/bgforge.png";
import fallout2 from "../assets/fallout2.png";
import fallout2ce from "../assets/fallout2ce.png";
import fallout2rpu from "../assets/fallout2rpu.png";
import fallout2upu from "../assets/fallout2upu.png";
import ettu from "../assets/ettu.png";
import fo1in2 from "../assets/fo1in2.png";

/*
  The previous interface's own icons, carried over from its `zax/icons/`: one disc per game, with a coloured
  letter over it for the mod. It had none for killap's two patches, which each share the icon of the fork that
  descends from it. Fallout et tu is the one entry whose disc is a different game rather than the same one
  modded, so it carries Fallout 1's own art, and its letter is the engine it runs on.
*/
export const GAME_ICON: Record<GameType, string> = {
  fallout2,
  fallout2up: fallout2upu,
  fallout2rp: fallout2rpu,
  fallout2upu,
  fallout2rpu,
  fo1in2,
};

/**
 * By feed id, so a row shows what it would install, and each project's own mark where it publishes one. The
 * two RPU lines are one project and share its icon; Fallout et tu takes the banner from its readme, which is
 * why the slot is wider than one disc; FO2tweaks has no mark of its own and takes BGforge's, which is whose
 * it is. A feed absent here renders no icon rather than a placeholder - a new feed should not have to ship
 * art before it can be offered.
 */
export const MOD_ICON: Record<string, string> = {
  upu: fallout2upu,
  rpu23: fallout2rpu,
  rpu24: fallout2rpu,
  fo1in2: ettu,
  fo2tweaks: bgforge,
};

/** By engine id. The project's own mark, from the organisation that publishes it. */
export const ENGINE_ICON: Record<string, string> = {
  "fallout2-ce": fallout2ce,
};
