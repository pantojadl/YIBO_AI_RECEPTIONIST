import { expect, it } from "vitest";
import { displayCurrency, formatDisplayMoney, formatStoredMoney } from "../../dashboard/src/services/money-presentation.js";
it("defaults currency-unspecified presentation to USD", () => {
  expect(displayCurrency()).toBe("USD");
  expect(formatDisplayMoney(12550)).toContain("USD");
});
it.each(["USD", "MXN", "EUR"] as const)("uses configured %s without exchange-rate conversion", currency => {
  const formatted = formatDisplayMoney(12550, { displayCurrency: currency });
  expect(formatted).toContain(currency); expect(formatted).toContain("125.50");
});
it("preserves stored currency regardless of display default", () => {
  const price = { amountMinor: 12550, currency: "MXN" };
  expect(formatStoredMoney(price, { displayCurrency: "EUR" })).toContain("MXN");
  expect(price).toEqual({ amountMinor: 12550, currency: "MXN" });
});
