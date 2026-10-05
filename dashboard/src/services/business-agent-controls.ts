import type { LocationDefinition } from "../../../src/modules/business/domain/multi-location-business.js";
import type { LocationAgentOverrides } from "../../../src/modules/business/domain/location-agent-overrides.js";

export const appointmentRules = [
  { tool: "create_appointment", label: "Book appointments" },
  { tool: "cancel_appointment", label: "Cancel appointments" },
  { tool: "reschedule_appointment", label: "Reschedule appointments" },
] as const;

export function setLocationAgentOverride<K extends keyof LocationAgentOverrides>(
  location: LocationDefinition, key: K, value: LocationAgentOverrides[K],
): void {
  const overrides = { ...location.agentOverrides };
  if (value === undefined) delete overrides[key];
  else overrides[key] = value;
  if (Object.keys(overrides).length === 0) delete location.agentOverrides;
  else location.agentOverrides = overrides;
}

export function setLocationActionBlocked(location: LocationDefinition, tool: typeof appointmentRules[number]["tool"], blocked: boolean): void {
  const disabled = new Set(location.agentOverrides?.disabledTools ?? []);
  if (blocked) disabled.add(tool); else disabled.delete(tool);
  setLocationAgentOverride(location, "disabledTools", disabled.size ? [...disabled] : undefined);
}
