import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createApiServer } from "../../src/api/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";
import { createAppointmentEditor, appointmentTime } from "../../dashboard/src/services/appointment-editor.js";
import { api } from "../../dashboard/src/services/api.js";

let server: FastifyInstance | undefined;
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await server?.close(); server = undefined; });
async function fixture() {
  const app = buildApplication({ clock: { now: () => new Date("2026-08-01T00:00:00Z") } });
  const config = await app.business.getBusinessConfiguration(app.tenantId);
  if (!config.ok) throw new Error("Missing configuration");
  const south = structuredClone(config.value.configuration.locations[0]!);
  south.id = "south"; south.name = "South"; south.calledNumbers = ["+12025550123"];
  config.value.configuration.locations.push(south);
  await app.business.updateBusinessConfiguration(app.tenantId, config.value.configuration, config.value.version);
  const customer = await app.customers.findOrCreateByPhone({ tenantId: app.tenantId, phone: "+12025550199", name: "Test Customer" });
  if (!customer.ok) throw new Error("Missing customer");
  const slots = await app.scheduling.findAvailableSlots({ tenantId: app.tenantId, locationId: "south", serviceId: "consultation", employeeId: "employee-1", rangeStart: "2026-08-10T00:00:00Z", rangeEnd: "2026-08-11T00:00:00Z", limit: 10 });
  if (!slots.ok || !slots.value[0]) throw new Error("Missing slots");
  const booked = await app.appointments.createAppointment({ tenantId: app.tenantId, locationId: "south", customerId: customer.value.id, serviceId: "consultation", employeeId: "employee-1", startAt: slots.value[0].startAt, idempotencyKey: "test-booking", source: "DASHBOARD" });
  if (!booked.ok) throw new Error("Booking failed");
  server = await createApiServer(app);
  const session = await createAdminTestSession(app, server, ["operator"]);
  const requests: Array<{ method: string; url: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"; requests.push({ method, url });
    const response = await server!.inject({ method: method as "GET" | "POST", url,
      headers: { ...(method === "GET" ? session.readHeaders : session.mutationHeaders), ...Object.fromEntries(new Headers(init?.headers).entries()) },
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(response.body, { status: response.statusCode });
  });
  const editor = createAppointmentEditor(); await editor.load();
  editor.state.locationId = "south"; editor.state.customerId = customer.value.id;
  return { app, editor, booked: booked.value, requests, session };
}

describe("UI-008 appointment administration", () => {
  it("lists customer appointments at the selected location and displays the historical snapshot", async () => {
    const { app, editor, booked } = await fixture();
    const current = await app.business.getBusinessConfiguration(app.tenantId);
    if (!current.ok) throw new Error("Missing configuration");
    current.value.configuration.services[0]!.name = "New catalog name";
    current.value.configuration.locations[1]!.services[0]!.price = { amountMinor: 99999, currency: "USD" };
    await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, current.value.version);
    expect(await editor.list()).toBe(true);
    expect(editor.state.appointments).toHaveLength(1);
    expect(await editor.lookup(booked.id)).toBe(true);
    expect(editor.state.selected).toMatchObject({ serviceNameSnapshot: booked.serviceNameSnapshot, priceAmountMinor: booked.priceAmountMinor, priceCurrency: booked.priceCurrency, locationId: "south" });
    editor.state.locationId = "default";
    await editor.list(); expect(editor.state.appointments).toEqual([]);
    expect(await editor.lookup(booked.id)).toBe(false);
    expect(editor.state.selected).toBeUndefined();
  });

  it("reschedules through available slots, keeps the event identity, then cancels", async () => {
    const { editor, booked, app } = await fixture();
    await editor.lookup(booked.id);
    expect(await editor.availability("2026-08-11")).toBe(true);
    const slot = editor.state.slots[0]!; expect(slot).toBeDefined();
    editor.state.pending = { kind: "reschedule", startAt: slot.startAt };
    expect(await editor.confirm()).toBe(true);
    expect(editor.state.selected).toMatchObject({ startAt: slot.startAt, externalCalendarEventId: booked.externalCalendarEventId, priceAmountMinor: booked.priceAmountMinor });
    expect(editor.state.message).toBe("Appointment rescheduled.");
    expect(editor.state.pending).toBeUndefined();
    editor.state.pending = { kind: "cancel" };
    expect(await editor.confirm()).toBe(true);
    expect(editor.state.selected!.status).toBe("CANCELLED");
    expect(await app.adminAudit.listByTenant(app.tenantId)).toHaveLength(2);
    await editor.list(); expect(editor.state.appointments).toEqual([]);
  });

  it("enforces current cancellation and reschedule policies without claiming success", async () => {
    const { app, editor, booked } = await fixture();
    const current = await app.business.getBusinessConfiguration(app.tenantId);
    if (!current.ok) throw new Error("Missing configuration");
    current.value.configuration.locations[1]!.policies.minimumCancellationNoticeMinutes = 30000;
    current.value.configuration.locations[1]!.policies.minimumRescheduleNoticeMinutes = 30000;
    expect((await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, current.value.version)).ok).toBe(true);
    await editor.lookup(booked.id);
    editor.state.pending = { kind: "cancel" };
    expect(await editor.confirm()).toBe(false); expect(editor.state.error).toContain("minimum notice");
    editor.state.pending = { kind: "reschedule", startAt: "2026-08-11T16:00:00Z" };
    expect(await editor.confirm()).toBe(false); expect(editor.state.error).toContain("minimum notice");
    expect(editor.state.message).toBe(""); expect(editor.state.selected!.startAt).toBe(booked.startAt);
  });

  it("handles calendar failures without retrying or reporting a successful cancellation", async () => {
    const { app, editor, booked, requests } = await fixture();
    vi.spyOn(app.appointments, "cancelAppointment").mockResolvedValue({ ok: false, error: { code: "CALENDAR_SYNC_FAILED", retryable: true } });
    await editor.lookup(booked.id); editor.state.pending = { kind: "cancel" };
    expect(await editor.confirm()).toBe(false); expect(editor.state.pending).toBeUndefined();
    expect(editor.state.error).toContain("before retrying"); expect(editor.state.message).toBe("");
    expect(editor.state.selected!.status).toBe("CONFIRMED");
    await editor.confirm(); expect(requests.filter(r => r.url.endsWith("/cancel"))).toHaveLength(1);
  });

  it("revalidates a lost slot on reschedule", async () => {
    const { editor, booked, app } = await fixture();
    await editor.lookup(booked.id); await editor.availability("2026-08-11");
    const slot = editor.state.slots[0]!;
    const competing = await app.appointments.createAppointment({ tenantId: app.tenantId, locationId: "south", customerId: booked.customerId, serviceId: booked.serviceId, employeeId: booked.employeeId, startAt: slot.startAt, idempotencyKey: "competing", source: "DASHBOARD" });
    expect(competing.ok).toBe(true);
    editor.state.pending = { kind: "reschedule", startAt: slot.startAt };
    expect(await editor.confirm()).toBe(false); expect(editor.state.error).toContain("no longer available");
    expect(editor.state.slots).toEqual([]);
  });

  it("requires authentication, same-origin mutations and rejects tenant or mutation field overrides", async () => {
    const { booked, session } = await fixture();
    const url = `/api/locations/south/appointments/${booked.id}/cancel`;
    expect((await server!.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);
    expect((await server!.inject({ method: "POST", url, headers: session.readHeaders, payload: {} })).statusCode).toBe(403);
    for (const body of [{ tenantId: "other" }, { locationId: "default" }, { employeeId: "other" }]) {
      expect((await server!.inject({ method: "POST", url, headers: session.mutationHeaders, payload: body })).statusCode).toBe(400);
    }
    expect((await server!.inject({ method: "GET", url: "/api/locations/south/appointments?customerId=a&customerId=b", headers: session.readHeaders })).statusCode).toBe(400);
    expect((await server!.inject({ method: "GET", url: "/api/availability?locationId=a&locationId=b&serviceId=consultation&rangeStart=2026-08-10&rangeEnd=2026-08-11", headers: session.readHeaders })).statusCode).toBe(400);
    await expect(api.locationAppointment("default", booked.id)).rejects.toMatchObject({ status: 404 });
    expect((await server!.inject({ method: "POST", url: `/api/locations/default/appointments/${booked.id}/cancel`, headers: session.mutationHeaders, payload: {} })).statusCode).toBe(404);
  });

  it("clears details and pending actions when changing location", async () => {
    const { editor, booked } = await fixture();
    await editor.lookup(booked.id); editor.state.pending = { kind: "cancel" };
    editor.state.locationId = "default"; editor.clear();
    expect(editor.state.selected).toBeUndefined(); expect(editor.state.pending).toBeUndefined(); expect(editor.state.slots).toEqual([]);
  });

  it("renders the appointment instant in the selected location timezone", () => {
    expect(appointmentTime("2026-08-10T16:30:00Z", "America/Denver")).toContain("10:30");
    expect(appointmentTime("2026-08-10T16:30:00Z", "America/New_York")).toContain("12:30");
  });
});

describe("RISK-001 office edit conflicts", () => {
  it("requires review of fresh details after another operator reschedules; no stale mutation or automatic retry", async () => {
    const { app, editor, booked, requests } = await fixture();
    await editor.lookup(booked.id);
    const moved = await app.appointments.rescheduleAppointment({ tenantId: app.tenantId, locationId: "south", appointmentId: booked.id,
      expectedVersion: booked.version, startAt: "2026-08-11T16:00:00Z" }); expect(moved.ok).toBe(true);
    const cancel = vi.spyOn(app.calendar, "cancelEvent");
    editor.state.pending = { kind: "cancel" };
    expect(await editor.confirm()).toBe(false); expect(editor.state.error).toContain("changed by someone else");
    expect(editor.state.message).toBe(""); expect(editor.state.pending).toBeUndefined(); expect(cancel).not.toHaveBeenCalled();
    await editor.confirm(); expect(requests.filter(item => item.url.endsWith("/cancel"))).toHaveLength(1);
    await editor.lookup(booked.id); expect(editor.state.selected!.startAt).toBe("2026-08-11T16:00:00.000Z");
    editor.state.pending = { kind: "cancel" }; expect(await editor.confirm()).toBe(true);
    expect(editor.state.selected).toMatchObject({ status: "CANCELLED", externalCalendarEventId: booked.externalCalendarEventId });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects invalid revision headers without weakening tenant or location checks", async () => {
    const { booked, session } = await fixture();
    for (const action of ["cancel", "reschedule", "outcome"]) {
      const response = await server!.inject({ method: "POST", url: `/api/locations/south/appointments/${booked.id}/${action}`,
        headers: { ...session.mutationHeaders, "if-match": '"0"' },
        payload: action === "cancel" ? {} : action === "reschedule" ? { startAt: "2026-08-11T16:00:00Z" } : { outcome: "NO_SHOW" } });
      expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe("INVALID_IF_MATCH");
    }
    const wrongLocation = await server!.inject({ method: "POST", url: `/api/locations/default/appointments/${booked.id}/cancel`,
      headers: { ...session.mutationHeaders, "if-match": `"${booked.version}"` }, payload: {} });
    expect(wrongLocation.statusCode).toBe(404);
  });
});
