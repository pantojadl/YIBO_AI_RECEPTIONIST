/**
 * Normalizes the called number presented by the PBX before tenant lookup.
 * US 10-digit and 11-digit NANP values become +1 E.164. Other regions are
 * left unchanged so an existing international number is not rewritten.
 */
export function canonicalizeCalledNumber(value: string, region?: string): string {
  const compact = value.trim().replace(/[\s().-]/g, "");
  if ((region ?? "").trim().toUpperCase() !== "US") return compact;
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  if (/^1[2-9]\d{9}$/.test(compact)) return `+${compact}`;
  if (/^[2-9]\d{9}$/.test(compact)) return `+1${compact}`;
  return compact;
}
