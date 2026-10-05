import type { ToolExecutor, ToolExecutionContext, AgentToolCall } from "./contracts.js";
export type PhoneReadbackStyle = "natural_grouped" | "digit_by_digit";

/** Presentation only; callers retain the original normalized customer value. */
export function formatPhoneReadback(phone: string, style: PhoneReadbackStyle = "natural_grouped"): string {
  const digits = phone.replace(/\D/g, "");
  const prefix = phone.trim().startsWith("+") ? "+ " : "";
  if (style === "digit_by_digit") return prefix + [...digits].join(" ");
  // NANP and Mexican national numbers share a ten-digit grouping. For other
  // lengths use groups of three without guessing a country code or dropping digits.
  if (digits.length === 10) return prefix + [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)].join(", ");
  if ((digits.startsWith("1") && digits.length === 11) || (digits.startsWith("52") && digits.length === 12)) {
    const national = digits.slice(-10);
    return prefix + [digits.slice(0, -10), national.slice(0, 3), national.slice(3, 6), national.slice(6)].join(", ");
  }
  return prefix + (digits.match(/.{1,3}/g) ?? []).join(", ");
}

export class PhoneReadbackToolExecutor implements ToolExecutor {
  constructor(private readonly inner: ToolExecutor, private readonly style: PhoneReadbackStyle) {}
  async execute(context: ToolExecutionContext, call: AgentToolCall) {
    const result = await this.inner.execute(context, call);
    if (!result.ok || call.name !== "update_customer" || !result.data || typeof result.data !== "object") return result;
    const data = result.data as Record<string, unknown>;
    const phone = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>).phone : undefined;
    return data.saved === true && typeof phone === "string"
      ? { ...result, data: { ...data, phoneReadback: formatPhoneReadback(phone, this.style) } }
      : result;
  }
}
