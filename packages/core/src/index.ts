export { IniDocument, type IniNode } from "./ini.js";
export { isApplied, pendingTargets, type Action } from "./action.js";
export { validate, type Validation } from "./validate.js";
export {
  GAME_TYPES,
  SCAN_LOCATIONS,
  addInstall,
  detectGameType,
  removeInstall,
  withWine,
  type GameType,
  type Install,
  type Theme,
  type WineConfig,
  type ZaxSettings,
} from "./install.js";
export {
  KEY_BY_SCANCODE,
  SCANCODE_BY_KEY,
  describeValueTest,
  displayValue,
  matchesQuery,
  matchesValueTest,
  parseScancode,
  sentinelLabel,
  percentToScale,
  scaleToPercent,
  type ChoiceOption,
  type SettingDef,
  type SettingKind,
  type ValueTest,
} from "./catalog.js";
