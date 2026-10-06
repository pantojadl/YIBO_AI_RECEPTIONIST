/** Optional restrictions/presentation overrides within the existing location document. */
export interface LocationAgentOverrides {
  disabledTools?: Array<"create_appointment" | "cancel_appointment" | "reschedule_appointment">;
  allowPriceDisclosure?: boolean;
  phoneReadback?: "natural_grouped" | "digit_by_digit";
  locale?: string;
}

export function isLocationAgentOverrides(value: unknown): value is LocationAgentOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["disabledTools", "allowPriceDisclosure", "phoneReadback", "locale"].includes(key))) return false;
  if (input.allowPriceDisclosure !== undefined && typeof input.allowPriceDisclosure !== "boolean") return false;
  if (input.phoneReadback !== undefined && (typeof input.phoneReadback !== "string" || !["natural_grouped", "digit_by_digit"].includes(input.phoneReadback))) return false;
  if (input.disabledTools !== undefined && (!Array.isArray(input.disabledTools)
    || new Set(input.disabledTools).size !== input.disabledTools.length
    || input.disabledTools.some(tool => !["create_appointment", "cancel_appointment", "reschedule_appointment"].includes(tool)))) return false;
  if (input.locale !== undefined) {
    if (typeof input.locale !== "string" || !input.locale.trim() || input.locale !== input.locale.trim()) return false;
    try { if (Intl.getCanonicalLocales(input.locale).length !== 1) return false; } catch { return false; }
  }
  return true;
}
