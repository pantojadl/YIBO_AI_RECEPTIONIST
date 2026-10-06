import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createApiServer } from "../../src/api/index.js";
import { DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS } from "../../src/app/development-fixtures.js";
import type { AgentToolName } from "../../src/modules/agents/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";
import { api, type AgentConfiguration as DashboardAgentConfiguration } from "../../dashboard/src/services/api.js";
import { createLocationEditor } from "../../dashboard/src/services/location-editor.js";
import { appointmentRules, setLocationActionBlocked, setLocationAgentOverride } from "../../dashboard/src/services/business-agent-controls.js";
import { setToolEnabled } from "../../dashboard/src/services/agent-policy-controls.js";

let server: FastifyInstance | undefined;
afterEach(async () => { vi.unstubAllGlobals(); await server?.close(); });

async function fixture(roles: Array<"tenant_admin" | "operator"> = ["tenant_admin"]) {
  const business = structuredClone(DEVELOPMENT_BUSINESS);
  business.locations[0]!.services[0]!.price.amountMinor = 12500;
  business.locations.push({ ...structuredClone(business.locations[0]!), id: "other", calledNumbers: ["+529991000098"] });
  const app = buildApplication({ businesses: [business, DEVELOPMENT_US_BUSINESS], clock: { now: () => new Date("2026-08-01T00:00:00Z") } });
  server = await createApiServer(app);
  const session = await createAdminTestSession(app, server, roles);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = { ...(method === "GET" ? session.readHeaders : session.mutationHeaders), ...Object.fromEntries(new Headers(init?.headers).entries()) };
    const response = await server!.inject({ method: method as "GET" | "PUT", url, headers, ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode });
  });
  const editor = createLocationEditor(); await editor.load();
  async function prepare(locationId = "default") {
    const result = await app.agents.prepare({ tenantId: app.tenantId, locationId, callId: "test-call" });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }
  return { app, editor, prepare };
}

describe("Model Configuration Pipeline through the dashboard API", () => {
  it("saves and reloads location controls, consumes them at runtime, and restores inheritance without changing other settings", async () => {
    const { app, editor, prepare } = await fixture();
    const before = JSON.parse(JSON.stringify(editor.state.draft));
    const location = editor.state.draft!.locations[0]!;
    setLocationAgentOverride(location, "allowPriceDisclosure", false);
    setLocationAgentOverride(location, "locale", "en-GB");
    setLocationAgentOverride(location, "phoneReadback", "digit_by_digit");
    for (const rule of appointmentRules) setLocationActionBlocked(location, rule.tool, true);
    expect(editor.dirty.value).toBe(true); expect(await editor.save()).toBe(true); await editor.load();
    expect(editor.state.draft!.locations[0]!.agentOverrides).toEqual(location.agentOverrides);
    const definition = await prepare();
    expect(definition.locale).toBe("en-GB");
    expect(definition.behavior).toMatchObject({ allowPriceDisclosure: false, phoneReadback: "digit_by_digit" });
    const context = { tenantId: app.tenantId, locationId: "default", callId: "test-call", turnSequence: 1 };
    const result = await definition.toolExecutor.execute(context, { toolCallId: "info", name: "get_service_information", arguments: {} });
    expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain('"price"');
    for (const rule of appointmentRules) expect(await definition.toolExecutor.execute(context, { toolCallId: rule.tool, name: rule.tool, arguments: {} }))
      .toMatchObject({ ok: false, error: { code: "TOOL_DISABLED" } });
    const other = await prepare("other");
    const visible = await other.toolExecutor.execute({ ...context, locationId: "other" }, { toolCallId: "info", name: "get_service_information", arguments: {} });
    expect(JSON.stringify(visible)).toContain('"amountMinor":12500');
    expect(other.behavior.allowPriceDisclosure).toBe(true);
    const otherTenant = await app.agents.prepare({ ...context, tenantId: DEVELOPMENT_US_BUSINESS.tenantId });
    expect(otherTenant.ok && otherTenant.value.behavior.allowPriceDisclosure).toBe(true);

    const restored = editor.state.draft!.locations[0]!;
    for (const rule of appointmentRules) setLocationActionBlocked(restored, rule.tool, false);
    setLocationAgentOverride(restored, "allowPriceDisclosure", undefined);
    setLocationAgentOverride(restored, "phoneReadback", undefined);
    setLocationAgentOverride(restored, "locale", undefined);
    expect(restored.agentOverrides).toBeUndefined();
    expect(await editor.save()).toBe(true);
    expect(editor.state.draft).toEqual(before);
    expect((await prepare()).behavior.allowPriceDisclosure).toBe(true);
  });

  it("persists business action/price settings and retains revision conflicts", async () => {
    const { app, prepare } = await fixture();
    const document = await api.agentConfiguration();
    const configuration = document.current!;
    configuration.behavior.allowPriceDisclosure = false;
    for (const rule of appointmentRules) setToolEnabled(configuration, rule.tool, "mutate", false);
    const saved = await api.updateAgentConfiguration(configuration, document.revision);
    const reloaded = await api.agentConfiguration();
    expect(reloaded.current).toEqual(saved.configuration);
    expect(reloaded.revision).not.toBe(document.revision);
    await expect(api.updateAgentConfiguration({ ...configuration, behavior: { ...configuration.behavior, allowPriceDisclosure: true } }, document.revision))
      .rejects.toMatchObject({ status: 409, code: "CONFIGURATION_VERSION_CONFLICT" });
    const definition = await prepare();
    for (const rule of appointmentRules) expect(definition.tools.map(tool => tool.name)).not.toContain(rule.tool);
    expect(definition.behavior.allowPriceDisclosure).toBe(false);
    expect((await app.agentConfiguration.get(DEVELOPMENT_US_BUSINESS.tenantId))?.behavior.allowPriceDisclosure).toBe(true);
  });

  it("keeps booking, list, reschedule and cancellation operational while withholding prices from the AI", async () => {
    const { app, editor } = await fixture();
    setLocationAgentOverride(editor.state.draft!.locations[0]!, "allowPriceDisclosure", false);
    expect(await editor.save()).toBe(true);
    const customer = await app.customers.findOrCreateByPhone({ tenantId: app.tenantId, phone: "+19155550123" });
    if (!customer.ok) throw new Error("synthetic customer failed");
    const context = { tenantId: app.tenantId, locationId: "default", callId: "booking-call", customerId: customer.value.id, turnSequence: 1 };
    const prepared = await app.agents.prepare(context); if (!prepared.ok) throw new Error(prepared.error.code);
    const executor = prepared.value.toolExecutor;
    let sequence = 0;
    async function execute(name: AgentToolName, args: object = {}) {
      const result = await executor.execute(context, { toolCallId: `tool-${++sequence}`, name, arguments: args });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.code);
      expect(JSON.stringify(result.data)).not.toContain('"price"');
      return result.data as any;
    }
    const available = await execute("check_availability", { rangeStart: "2026-08-10T09:00:00", rangeEnd: "2026-08-10T12:00:00", service: "Consulta" });
    const slot = available.availableSlots[0]; expect(slot).toBeDefined();
    // Operations requires the same-call contact save before a real booking.
    await execute("update_customer", { name: "Synthetic Caller", phone: "+19155550123" });
    const booked = await execute("create_appointment", { service: "Consulta", employeeId: slot.employeeId, startAt: slot.startAt });
    expect(booked).toMatchObject({ confirmed: true, startAt: slot.startAt, timezone: "America/Merida" });
    const listed = await execute("list_customer_appointments");
    const reference = listed.appointments[0].reference;
    const stored = (await app.appointments.listUpcomingAppointments(context))[0]!;
    expect(stored.priceAmountMinor).toBe(12500);
    const replacement = await execute("check_availability", { rangeStart: "2026-08-11T09:00:00", rangeEnd: "2026-08-11T12:00:00", service: "Consulta" });
    expect(await execute("reschedule_appointment", { appointmentReference: reference, startAt: replacement.availableSlots[0].startAt }))
      .toMatchObject({ rescheduled: true, startAt: replacement.availableSlots[0].startAt });
    expect(await execute("cancel_appointment", { appointmentReference: reference })).toMatchObject({ cancelled: true });
    const final = await app.appointments.getAppointment({ ...context, appointmentId: stored.id });
    expect(final).toMatchObject({ ok: true, value: { status: "CANCELLED", priceAmountMinor: 12500, externalCalendarEventId: stored.externalCalendarEventId } });
    expect(await app.appointments.listUpcomingAppointments(context)).toEqual([]);
  });

  it("retains a stale location draft without overwriting a newer rule", async () => {
    const { editor } = await fixture();
    const other = createLocationEditor(); await other.load();
    setLocationAgentOverride(other.state.draft!.locations[0]!, "allowPriceDisclosure", false);
    expect(await other.save()).toBe(true);
    setLocationAgentOverride(editor.state.draft!.locations[0]!, "locale", "pt-BR");
    expect(await editor.save()).toBe(false); expect(editor.state.conflict).toBe(true);
    expect(editor.state.draft!.locations[0]!.agentOverrides).toEqual({ locale: "pt-BR" });
    await editor.load(); expect(editor.state.draft!.locations[0]!.agentOverrides).toEqual({ allowPriceDisclosure: false });
  });

  it.each([null, { allowPriceDisclosure: "false" }, { phoneReadback: ["digit_by_digit"] }, { locale: "not_a_locale" },
    { disabledTools: ["update_customer"] }, { disabledTools: ["create_appointment", "create_appointment"] }, { tenantId: "other" }])
    ("rejects invalid location overrides without persisting them: %j", async overrides => {
      const { editor, app } = await fixture();
      (editor.state.draft!.locations[0] as any).agentOverrides = overrides;
      expect(await editor.save()).toBe(false);
      expect(await app.business.getBusinessConfiguration(app.tenantId)).toMatchObject({ ok: true, value: { version: 1 } });
    });

  it.each([null, "false", 0])("rejects invalid business price disclosure %j without changing settings", async value => {
    await fixture();
    const before = await api.agentConfiguration();
    const edited = structuredClone(before.current!); (edited.behavior as any).allowPriceDisclosure = value;
    await expect(api.updateAgentConfiguration(edited, before.revision)).rejects.toMatchObject({ status: 400 });
    expect((await api.agentConfiguration()).current).toEqual(before.current);
  });

  it("denies operators access to business and location AI rules", async () => {
    const { app, editor } = await fixture(["operator"]);
    expect(editor.state.draft).toBeUndefined();
    await expect(api.agentConfiguration()).rejects.toMatchObject({ status: 403 });
    const configuration = await app.agentConfiguration.get(app.tenantId);
    await expect(api.updateAgentConfiguration(configuration! as DashboardAgentConfiguration, "a".repeat(64))).rejects.toMatchObject({ status: 403 });
  });
});
