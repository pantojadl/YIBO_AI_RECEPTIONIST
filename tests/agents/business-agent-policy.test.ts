import { describe, expect, it, vi } from "vitest";
import { DEVELOPMENT_BUSINESS } from "../../src/app/development-fixtures.js";
import { AgentConfigurationService, AgentDefinitionService, InMemoryAgentConfigurationSource, type ToolExecutor } from "../../src/modules/agents/index.js";
import { BusinessDirectoryService, InMemoryBusinessRepository, resolvedAiCapabilities, type LocationAiCapabilities } from "../../src/modules/business/index.js";
import type { LocationAgentOverrides } from "../../src/modules/business/domain/location-agent-overrides.js";
import { PriceDisclosureToolExecutor } from "../../src/modules/agents/application/business-agent-policy.js";

const actions = ["create_appointment", "cancel_appointment", "reschedule_appointment"] as const;
const context = { tenantId: DEVELOPMENT_BUSINESS.tenantId, locationId: "default", callId: "call", turnSequence: 1 };

async function fixture(overrides?: LocationAgentOverrides, capabilities?: Partial<LocationAiCapabilities>) {
  const business = structuredClone(DEVELOPMENT_BUSINESS);
  business.locations[0]!.agentOverrides = overrides;
  if (capabilities) business.locations[0]!.aiCapabilities = { ...resolvedAiCapabilities(business.locations[0]!), ...capabilities };
  business.locations.push({ ...structuredClone(DEVELOPMENT_BUSINESS.locations[0]!), id: "other", calledNumbers: ["+529991000098"] });
  const source = new InMemoryAgentConfigurationSource([]);
  const configService = new AgentConfigurationService(source);
  const configuration = configService.recommended("en-US", "Test", "gpt-realtime-2.1");
  await configService.update(context.tenantId, configuration);
  const inner = { execute: vi.fn(async () => ({ toolCallId: "t", ok: true as const, data: { saved: true } })) };
  const factory = new AgentDefinitionService(source, inner, new BusinessDirectoryService(new InMemoryBusinessRepository([business])));
  async function prepare(developerTestModeAuthorized?: true, locationId = "default") {
    const result = await factory.prepare({ ...context, locationId, ...(developerTestModeAuthorized ? { developerTestModeAuthorized } : {}) });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }
  return { configuration, configService, source, factory, inner, prepare };
}

describe("business rules in the prepared runtime agent", () => {
  it("intersects Operations capabilities with Product UX business/channel rules and location overrides", async () => {
    const { prepare, inner, configuration, configService } = await fixture(
      { allowPriceDisclosure: true, disabledTools: ["cancel_appointment"] },
      { quotePrices: false, bookAppointments: false, collectEmail: true, offerAlternatives: false, offerEarliest: false },
    );
    configuration.toolPolicies.channels.phone.enabledTools = configuration.toolPolicies.channels.phone.enabledTools.filter(name => name !== "reschedule_appointment");
    await configService.update(context.tenantId, configuration);
    const definition = await prepare();
    expect(definition.behavior).toMatchObject({ allowPriceDisclosure: false, slotOffering: { maximumOptions: 1, strategy: "match_requested_time" } });
    expect(definition.instructions).toContain("Email may be collected");
    expect(definition.instructions).toContain("do not offer outside-range alternatives");
    expect(definition.instructions).not.toContain("offer the returned alternatives as well");
    for (const name of actions) expect(await definition.toolExecutor.execute(context, { toolCallId: name, name, arguments: {} }))
      .toMatchObject({ ok: false, error: { code: "TOOL_DISABLED" } });
    expect(inner.execute).not.toHaveBeenCalled();
    expect((await prepare(undefined, "other")).behavior.allowPriceDisclosure).toBe(true);
  });

  it("retains business price denial even when Operations allows it", async () => {
    const { prepare, configuration, configService, inner } = await fixture(undefined, { quotePrices: true });
    configuration.behavior.allowPriceDisclosure = false;
    await configService.update(context.tenantId, configuration);
    inner.execute.mockResolvedValueOnce({ toolCallId: "t", ok: true, data: { saved: true, price: { amountMinor: 100 } } } as never);
    const definition = await prepare();
    expect(definition.behavior.allowPriceDisclosure).toBe(false);
    expect(await definition.toolExecutor.execute(context, { toolCallId: "t", name: "get_service_information", arguments: {} }))
      .toMatchObject({ ok: true, data: { saved: true } });
  });

  it("keeps legacy behavior and does not implicitly replace the agent language with the location locale", async () => {
    const { prepare, configuration, configService } = await fixture();
    delete configuration.behavior.allowPriceDisclosure;
    expect((await configService.update(context.tenantId, configuration)).behavior.allowPriceDisclosure).toBe(true);
    const definition = await prepare();
    expect(definition.locale).toBe("en-US"); // Location date/currency locale is es-MX.
    expect(definition.behavior).toMatchObject({ allowPriceDisclosure: true, phoneReadback: "natural_grouped" });
    expect(definition.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([...actions]));
  });

  it.each([false, true])("blocks all three location actions before execution or confirmation (Voice Lab = %s)", async lab => {
    const { configuration, configService, prepare, inner } = await fixture({ disabledTools: [...actions] });
    configuration.toolPolicies.confirmations.requiredFor = [...actions];
    await configService.update(context.tenantId, configuration);
    const definition = await prepare(lab ? true : undefined);
    for (const name of actions) {
      expect(definition.tools.map(tool => tool.name)).not.toContain(name);
      expect(definition.instructions).toContain(`${name} is not enabled`);
      expect(await definition.toolExecutor.execute(context, { toolCallId: name, name, arguments: {} }))
        .toMatchObject({ ok: false, error: { code: "TOOL_DISABLED" } });
    }
    expect(inner.execute).not.toHaveBeenCalled();
    expect(definition.instructions).not.toContain("Backend confirmation is required for:");
  });

  it("keeps another location's actions available and rejects an unknown tenant/location", async () => {
    const { prepare, factory, inner } = await fixture({ disabledTools: [...actions] });
    const other = await prepare(undefined, "other");
    expect(other.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([...actions]));
    await other.toolExecutor.execute({ ...context, locationId: "other" }, { toolCallId: "t", name: "create_appointment", arguments: {} });
    expect(inner.execute).toHaveBeenCalledOnce();
    expect(await factory.prepare({ ...context, tenantId: "unknown" })).toMatchObject({ ok: false });
    expect(await factory.prepare({ ...context, locationId: "unknown" })).toMatchObject({ ok: false });
  });

  it("cannot override tenant price denial or tenant/channel tool permissions", async () => {
    const { prepare, configService, configuration, inner } = await fixture({ allowPriceDisclosure: true, disabledTools: [] });
    configuration.behavior.allowPriceDisclosure = false;
    configuration.enabledTools = configuration.enabledTools.filter(name => name !== "create_appointment");
    for (const channel of Object.values(configuration.toolPolicies.channels)) channel.enabledTools = channel.enabledTools.filter(name => name !== "create_appointment");
    configuration.toolPolicies.channels.phone.enabledTools = ["get_service_information"];
    await configService.update(context.tenantId, configuration);
    const definition = await prepare();
    expect(definition.behavior.allowPriceDisclosure).toBe(false);
    for (const name of actions) expect(await definition.toolExecutor.execute(context, { toolCallId: name, name, arguments: {} }))
      .toMatchObject({ ok: false, error: { code: "TOOL_DISABLED" } });
    expect(inner.execute).not.toHaveBeenCalled();
    expect((await prepare(true)).tools.map(tool => tool.name)).not.toContain("create_appointment");
  });

  it("does not require an impossible tool call when the location blocks the channel's last tool", async () => {
    const { prepare, configService, configuration } = await fixture({ disabledTools: ["create_appointment"] });
    configuration.toolPolicies.channels.phone = { enabledTools: ["create_appointment"], toolChoice: "required", parallelToolCalls: false };
    await configService.update(context.tenantId, configuration);
    const definition = await prepare();
    expect(definition.tools).toEqual([]);
    expect(definition.toolChoice).toBe("auto");
  });

  it.each([false, true])("consumes location language and phone readback in instructions and tool output (Voice Lab = %s)", async lab => {
    const { prepare, configService } = await fixture({ locale: "es-US", phoneReadback: "digit_by_digit" });
    const definition = await prepare(lab ? true : undefined);
    expect(definition.locale).toBe("es-US");
    expect(definition.instructions).toContain('respond using locale "es-US"');
    expect(definition.instructions).toContain("Speak every digit separately");
    const result = await definition.toolExecutor.execute(context, { toolCallId: "t", name: "update_customer", arguments: { name: "Test", phone: "+19155550123" } });
    expect(result).toMatchObject({ ok: true, data: { phoneReadback: "+ 1 9 1 5 5 5 5 0 1 2 3" } });
    expect((await configService.get(context.tenantId))?.behavior.phoneReadback).toBe("natural_grouped");
    expect((await prepare(undefined, "other")).locale).toBe("en-US");
  });

  it("applies changed rules to the next conversation without mutating an existing definition", async () => {
    const { prepare, configService, configuration } = await fixture();
    const before = await prepare();
    configuration.behavior.allowPriceDisclosure = false;
    configuration.identity.locale = "pt-BR";
    await configService.update(context.tenantId, configuration);
    const after = await prepare();
    expect(before.behavior.allowPriceDisclosure).toBe(true); expect(before.locale).toBe("en-US");
    expect(after.behavior.allowPriceDisclosure).toBe(false); expect(after.locale).toBe("pt-BR");
    expect(after.instructions).toContain("Never quote, estimate, confirm, or repeat a price");
    expect(after.instructions).not.toContain("historical price as authoritative");
  });

  it("redacts nested prices from all successful outputs without changing stored snapshots or confirmation/time", async () => {
    const data = { confirmed: true, startAt: "2026-10-01T10:00:00Z", price: { amountMinor: 12500, currency: "USD" },
      services: [{ description: "Consultation", locations: [{ name: "North", price: { display: "$125.00" } }] }] };
    const snapshot = structuredClone(data);
    const inner: ToolExecutor = { execute: async () => ({ toolCallId: "t", ok: true, data }) };
    const hidden = await new PriceDisclosureToolExecutor(inner, false).execute(context, { toolCallId: "t", name: "create_appointment", arguments: {} });
    expect(hidden).toEqual({ toolCallId: "t", ok: true, data: { confirmed: true, startAt: data.startAt, services: [{ description: "Consultation", locations: [{ name: "North" }] }] } });
    expect(data).toEqual(snapshot);
    expect(await new PriceDisclosureToolExecutor(inner, true).execute(context, { toolCallId: "t", name: "create_appointment", arguments: {} })).toMatchObject({ data });
  });

  it("preserves failure semantics while price disclosure is disabled", async () => {
    const failure = { toolCallId: "t", ok: false as const, error: { code: "CALENDAR_FAILURE", messageForAgent: "Not booked", retryable: false } };
    const executor = new PriceDisclosureToolExecutor({ execute: async () => failure }, false);
    expect(await executor.execute(context, { toolCallId: "t", name: "create_appointment", arguments: {} })).toBe(failure);
  });
});
