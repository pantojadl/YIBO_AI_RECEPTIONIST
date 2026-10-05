export const DISPLAY_CURRENCIES = ["USD", "MXN", "EUR"] as const;
export type DisplayCurrency = typeof DISPLAY_CURRENCIES[number];
export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = "USD";

export interface Money {
  amountMinor: number;
  currency: string;
}

const ISO_4217_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export const validateMoney = (money: Money): string | null => {
  if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor < 0) {
    return "Amount must be non-negative integer minor units.";
  }
  if (!ISO_4217_CURRENCIES.has(money.currency)) {
    return "Currency must be an uppercase ISO 4217 code.";
  }
  return null;
};
