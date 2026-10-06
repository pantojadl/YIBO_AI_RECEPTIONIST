import type { LocationDefinition } from "../../business/index.js";
import type { AgentConfiguration } from "../ports/agent-dependencies.js";
import type { AgentToolCall, ToolExecutionContext, ToolExecutor } from "./contracts.js";

/** Resolve only from server-selected tenant/location data, once per conversation. */
export function resolveBusinessAgentPolicy(configuration: AgentConfiguration, location: LocationDefinition) {
  const overrides = location.agentOverrides;
  return {
    locale: overrides?.locale ?? configuration.identity.locale,
    disabledTools: overrides?.disabledTools ?? [],
    behavior: {
      ...structuredClone(configuration.behavior),
      allowPriceDisclosure: (configuration.behavior.allowPriceDisclosure ?? true) && (overrides?.allowPriceDisclosure ?? true),
      phoneReadback: overrides?.phoneReadback ?? configuration.behavior.phoneReadback ?? "natural_grouped",
    },
  };
}

/** Remove structured prices before the model sees successful tool results; never alter stored data. */
export class PriceDisclosureToolExecutor implements ToolExecutor {
  constructor(private readonly inner: ToolExecutor, private readonly allowed: boolean) {}

  async execute(context: ToolExecutionContext, call: AgentToolCall) {
    const result = await this.inner.execute(context, call);
    return this.allowed || !result.ok ? result : { ...result, data: withoutPrices(result.data) };
  }
}

function withoutPrices(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrices);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "price")
    .map(([key, item]) => [key, withoutPrices(item)]));
}
