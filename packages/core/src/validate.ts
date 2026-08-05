import type { SettingDef } from "./catalog.js";

/**
 * Value sanitization. The previous implementation's bounds were spinner ranges rather than domains, which let a
 * graphics width of 1 through. A value is valid when it is a named sentinel, or a number inside a real range.
 */

export type Validation = { ok: true } | { ok: false; reason: string };

const OK: Validation = { ok: true };

export function validate(def: SettingDef, raw: string | undefined): Validation {
  if (raw === undefined || raw === "") return OK;
  const kind = def.kind;

  switch (kind.type) {
    case "int":
    case "float": {
      if (kind.sentinels?.[raw]) return OK;
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: "Not a number" };
      if (kind.type === "int" && !Number.isInteger(n)) return { ok: false, reason: "Must be a whole number" };
      if (kind.min !== undefined && n < kind.min) {
        return { ok: false, reason: `Must be at least ${kind.min}${unitSuffix(kind.unit)}` };
      }
      if (kind.max !== undefined && n > kind.max) {
        return { ok: false, reason: `Must be at most ${kind.max}${unitSuffix(kind.unit)}` };
      }
      return OK;
    }
    case "choice":
      return kind.options.some((o) => o.value === raw)
        ? OK
        : { ok: false, reason: `${raw} is not one of the supported values` };
    case "scale": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > kind.max) return { ok: false, reason: "Outside the supported range" };
      return OK;
    }
    default:
      return OK;
  }
}

const unitSuffix = (unit: string | undefined) => (unit ? ` ${unit}` : "");
