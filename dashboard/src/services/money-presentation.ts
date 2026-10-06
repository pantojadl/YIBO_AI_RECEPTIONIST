import type { BusinessConfigurationV2, Money } from "../../../src/modules/business/index.js";
import { DEFAULT_DISPLAY_CURRENCY } from "../../../src/modules/business/domain/money.js";
export { DISPLAY_CURRENCIES } from "../../../src/modules/business/domain/money.js";
export const displayCurrency = (configuration?: Pick<BusinessConfigurationV2, "displayCurrency">) => configuration?.displayCurrency ?? DEFAULT_DISPLAY_CURRENCY;
/** Explicit stored denomination always wins; this is formatting, not FX conversion. */
export function formatDisplayMoney(amountMinor: number, configuration?: Pick<BusinessConfigurationV2, "displayCurrency">, currency?: string, locale = "en-US"): string {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency: currency ?? displayCurrency(configuration), currencyDisplay: "code" });
  return formatter.format(amountMinor / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
}
export const formatStoredMoney = (price: Money, configuration?: Pick<BusinessConfigurationV2, "displayCurrency">) => formatDisplayMoney(price.amountMinor, configuration, price.currency);
