import { describe, it, expect, vi } from "vitest";
import { formatPhoneReadback, PhoneReadbackToolExecutor } from "../../src/modules/agents/application/phone-readback.js";
import { AgentDefinitionService, AgentConfigurationService, InMemoryAgentConfigurationSource } from "../../src/modules/agents/index.js";
import { BusinessDirectoryService, InMemoryBusinessRepository } from "../../src/modules/business/index.js";
import { DEVELOPMENT_BUSINESS } from "../../src/app/development-fixtures.js";

describe("phone presentation", () => {
  it.each([
    ["9155551234", "915, 555, 1234", "9 1 5 5 5 5 1 2 3 4"],
    ["+19155551234", "+ 1, 915, 555, 1234", "+ 1 9 1 5 5 5 5 1 2 3 4"],
    ["+529991234567", "+ 52, 999, 123, 4567", "+ 5 2 9 9 9 1 2 3 4 5 6 7"],
  ])("formats %s without losing country codes or digits", (phone, grouped, digits) => {
    expect(formatPhoneReadback(phone)).toBe(grouped);
    expect(formatPhoneReadback(phone, "digit_by_digit")).toBe(digits);
  });
  it.each(["natural_grouped", "digit_by_digit"] as const)("prepared call consumes %s through instructions and tool output", async style => {
    const repository = new InMemoryAgentConfigurationSource([]);
    const service = new AgentConfigurationService(repository);
    const tenantId = DEVELOPMENT_BUSINESS.tenantId;
    const configuration = service.recommended("en-US", "Test", "gpt-realtime-2.1");
    configuration.behavior.phoneReadback = style;
    await service.update(tenantId, configuration);
    const inner = { execute: vi.fn(async () => ({ toolCallId: "t", ok: true as const, data: { saved: true } })) };
    const factory = new AgentDefinitionService(repository, inner, new BusinessDirectoryService(new InMemoryBusinessRepository([DEVELOPMENT_BUSINESS])));
    const prepared = await factory.prepare({ tenantId, locationId: "default", callId: "call" });
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    expect(prepared.value.instructions).toContain(style);
    const context = { tenantId, locationId: "default", callId: "call", turnSequence: 1 };
    const result = await prepared.value.toolExecutor.execute(context, { toolCallId: "t", name: "update_customer", arguments: { name: "Test Caller", phone: "+19155551234" } });
    expect(result).toMatchObject({ ok: true, data: { saved: true, phoneReadback: formatPhoneReadback("+19155551234", style) } });
    expect(inner.execute).toHaveBeenCalledWith(context, expect.anything());
  });
  it("defaults legacy configuration and rejects unknown styles", async () => {
    const service = new AgentConfigurationService(new InMemoryAgentConfigurationSource([]));
    const config = service.recommended("en-US", "Test", "gpt-realtime-2.1");
    delete config.behavior.phoneReadback;
    expect((await service.update("tenant", config)).behavior.phoneReadback).toBe("natural_grouped");
    (config.behavior as any).phoneReadback = "unsupported";
    await expect(service.update("tenant", config)).rejects.toThrow();
    expect(await service.get("other-tenant")).toBeNull();
  });
  it("preserves failed tool results without presenting unsaved contact information", async () => {
    const failed = { toolCallId: "t", ok: false as const, error: { code: "VALIDATION_ERROR", messageForAgent: "Invalid", retryable: false } };
    const wrapper = new PhoneReadbackToolExecutor({ execute: async () => failed }, "digit_by_digit");
    expect(await wrapper.execute({ tenantId: "t", locationId: "l", callId: "c", turnSequence: 1 }, { toolCallId: "t", name: "update_customer", arguments: {} })).toBe(failed);
  });
});
