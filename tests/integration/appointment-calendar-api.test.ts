import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createApiServer } from "../../src/api/index.js";
import { InMemoryAppointmentRepository, type Appointment, type AppointmentCalendarPort } from "../../src/modules/appointments/index.js";
import type { CalendarPort } from "../../src/modules/scheduling/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";
import { api } from "../../dashboard/src/services/api.js";
import { createAppointmentCalendar } from "../../dashboard/src/services/appointment-calendar.js";
import { createAvailabilitySearch } from "../../dashboard/src/services/availability-search.js";
import { createAppointmentEditor } from "../../dashboard/src/services/appointment-editor.js";
import { createBookingCustomer } from "../../dashboard/src/services/booking-customer.js";
import { InMemoryCalendarAdapter } from "../../src/modules/integrations/index.js";

let server: FastifyInstance | undefined;
const disposers: Array<() => void> = [];
afterEach(async () => { disposers.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks(); await server?.close(); server = undefined; });
const range = { rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z" };
const endpoint = (location = "default", query = new URLSearchParams(range).toString()) => `/api/locations/${location}/appointment-calendar?${query}`;

async function fixture() {
  const repository = new InMemoryAppointmentRepository();
  const provider: AppointmentCalendarPort & CalendarPort = new InMemoryCalendarAdapter();
  const app = buildApplication({ appointmentRepository: repository, calendar: provider, clock: { now: () => new Date("2026-08-01T00:00:00Z") } });
  const config = await app.business.getBusinessConfiguration(app.tenantId);
  if (!config.ok) throw new Error("Missing config");
  const south = structuredClone(config.value.configuration.locations[0]!);
  south.id = "south"; south.name = "South"; south.timezone = "America/New_York"; south.calledNumbers = ["+15550000130"];
  const archived = structuredClone(south); archived.id = "archived"; archived.active = false; archived.calledNumbers = [];
  config.value.configuration.locations.push(south, archived);
  expect((await app.business.updateBusinessConfiguration(app.tenantId, config.value.configuration, config.value.version)).ok).toBe(true);
  const customer = await app.customers.findOrCreateByPhone({ tenantId: app.tenantId, phone: "+15550000001", name: "Taylor Example" });
  const second = await app.customers.findOrCreateByPhone({ tenantId: app.tenantId, phone: "+15550000002", name: "Morgan Example" });
  if (!customer.ok || !second.ok) throw new Error("Missing customer");
  const customerId = customer.value.id;
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
  async function seed(id: string, changes: Partial<Appointment> = {}) {
    const appointment: Appointment = { id, tenantId: app.tenantId, locationId: "default", customerId,
      serviceId: "consultation", employeeId: "employee-1", serviceNameSnapshot: "Original consultation",
      priceAmountMinor: 12550, priceCurrency: "USD", startAt: "2026-08-10T16:00:00.000Z", endAt: "2026-08-10T16:30:00.000Z",
      status: "CONFIRMED", idempotencyKey: id, source: "DASHBOARD", ...changes };
    await repository.save(appointment); return appointment;
  }
  return { app, repository, provider, customer: customer.value, second: second.value, session, requests, seed };
}

describe("operator appointment calendar read model", () => {
  it("lists every customer and status with existing customer/staff labels and original price/service snapshots", async () => {
    const { second, seed, app } = await fixture();
    await seed("b", { customerId: second.id, employeeId: "employee-2" }); await seed("a");
    await seed("cancelled", { status: "CANCELLED" }); await seed("pending", { status: "PENDING_CONFIRMATION" }); await seed("failed", { status: "FAILED" });
    const current = await app.business.getBusinessConfiguration(app.tenantId);
    if (!current.ok) throw new Error("Missing config");
    current.value.configuration.services[0]!.name = "Renamed catalog";
    expect((await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, current.value.version)).ok).toBe(true);
    const result = await api.appointmentCalendar("default", range);
    expect(result.appointments.map(item => item.id)).toEqual(["a", "b", "cancelled", "failed", "pending"]);
    expect(result.appointments[0]).toMatchObject({ customerName: "Taylor Example", customerPhone: "+15550000001",
      professionalName: "Dra. Ana", serviceNameSnapshot: "Original consultation", priceAmountMinor: 12550, priceCurrency: "USD" });
    expect(result.appointments[1]).toMatchObject({ customerName: "Morgan Example", professionalName: "Dr. Carlos" });
    expect(await app.adminAudit.listByTenant(app.tenantId)).toEqual([]);
  });
  it("isolates tenant and location and keeps inactive-location history accessible", async () => {
    const { seed, app } = await fixture();
    await seed("own"); await seed("other-tenant", { tenantId: "another-tenant" });
    await seed("south", { locationId: "south" }); await seed("archived", { locationId: "archived", status: "CANCELLED" });
    expect((await api.appointmentCalendar("default", range)).appointments.map(item => item.id)).toEqual(["own"]);
    expect((await api.appointmentCalendar("south", range)).appointments.map(item => item.id)).toEqual(["south"]);
    expect((await api.appointmentCalendar("archived", range)).appointments.map(item => item.id)).toEqual(["archived"]);
    expect(await app.appointments.listCalendarAppointments({ tenantId: "missing-tenant", locationId: "default", ...range })).toMatchObject({ ok: false });
    await expect(api.appointmentCalendar("missing-location", range)).rejects.toMatchObject({ status: 400 });
  });
  it("includes historical and overnight appointments using half-open overlap boundaries", async () => {
    const { seed } = await fixture();
    await seed("overnight", { startAt: "2026-08-09T23:30:00.000Z", endAt: "2026-08-10T00:30:00.000Z" });
    await seed("ends-at-start", { startAt: "2026-08-09T23:30:00.000Z", endAt: range.rangeStart });
    await seed("starts-at-end", { startAt: range.rangeEnd, endAt: "2026-08-11T00:30:00.000Z" });
    await seed("historical", { startAt: "2026-07-10T16:00:00.000Z", endAt: "2026-07-10T16:30:00.000Z" });
    expect((await api.appointmentCalendar("default", range)).appointments.map(item => item.id)).toEqual(["overnight"]);
    expect((await api.appointmentCalendar("default", { rangeStart: "2026-07-10T00:00:00Z", rangeEnd: "2026-07-11T00:00:00Z" })).appointments.map(item => item.id)).toEqual(["historical"]);
  });
  it("does not silently truncate a busy office's calendar to the availability result limit", async () => {
    const { seed } = await fixture();
    for (let i = 0; i < 121; i++) await seed(`entry-${String(i).padStart(3, "0")}`);
    expect((await api.appointmentCalendar("default", range)).appointments).toHaveLength(121);
  });
  it("retains bookings when a customer or historical professional is no longer readable", async () => {
    const { seed } = await fixture(); await seed("legacy", { customerId: "missing", employeeId: "former-provider" });
    expect((await api.appointmentCalendar("default", range)).appointments[0]).toMatchObject({ id: "legacy", professionalName: "Unlisted professional" });
    expect((await api.appointmentCalendar("default", range)).appointments[0]?.customerPhone).toBeUndefined();
  });
  it("requires a session, bounded explicit timestamps, and rejects query/tenant overrides", async () => {
    const { session } = await fixture();
    expect((await server!.inject({ url: endpoint() })).statusCode).toBe(401);
    const invalidQueries = [
      "", new URLSearchParams({ ...range, rangeEnd: range.rangeStart }).toString(),
      new URLSearchParams({ ...range, rangeEnd: "2026-10-01T00:00:00Z" }).toString(),
      new URLSearchParams({ ...range, rangeStart: "2026-08-10" }).toString(),
      new URLSearchParams({ ...range, rangeStart: "bad" }).toString(),
      new URLSearchParams({ ...range, rangeStart: "2026-02-30T00:00:00Z", rangeEnd: "2026-03-04T00:00:00Z" }).toString(),
      `${new URLSearchParams(range)}&rangeStart=${encodeURIComponent(range.rangeStart)}`,
      `${new URLSearchParams(range)}&tenantId=other`,
      `${new URLSearchParams(range)}&customerId=other`,
    ];
    for (const query of invalidQueries) expect((await server!.inject({ url: endpoint("default", query), headers: session.readHeaders })).statusCode).toBe(400);
    expect((await server!.inject({ url: endpoint(), headers: session.readHeaders })).statusCode).toBe(200);
  });
  it("normalizes timezone offsets before querying stored UTC timestamps", async () => {
    const { seed } = await fixture(); await seed("noon");
    expect((await api.appointmentCalendar("default", { rangeStart: "2026-08-10T11:00:00-04:00", rangeEnd: "2026-08-10T13:00:00-04:00" })).appointments.map(item => item.id)).toEqual(["noon"]);
  });
});

describe("front-desk workflow through real authenticated application APIs", () => {
  it("selects a customer, books, finds the right appointment among others, reschedules twice and cancels using the original event", async () => {
    const { customer, provider, requests } = await fixture();
    const create = vi.spyOn(provider, "createEvent"), move = vi.spyOn(provider, "rescheduleEvent"), cancel = vi.spyOn(provider, "cancelEvent");
    const chooser = createBookingCustomer(); chooser.state.phone = "+1 (555) 000-0001"; chooser.state.name = "Do not overwrite";
    expect((await chooser.choose())?.id).toBe(customer.id); expect(chooser.state.selected?.name).toBe("Taylor Example");
    const search = createAvailabilitySearch(); disposers.push(search.dispose);
    await search.load({ locationId: "south", day: "2026-08-10", employeeId: "employee-1" });
    await search.search(); search.select(search.state.slots[0]!);
    const selectedSlot = search.state.selected!;
    const booked = await search.book(customer.id); expect(booked).toMatchObject({ locationId: "south", employeeId: "employee-1", startAt: selectedSlot.startAt, status: "CONFIRMED" });
    expect(await search.book(customer.id)).toBeUndefined();
    search.state.filters.day = "2026-08-14"; await search.search(); search.select(search.state.slots[0]!);
    const neighbor = (await search.book(customer.id))!;
    const calendar = createAppointmentCalendar(); disposers.push(calendar.dispose);
    calendar.state.locationId = "south"; calendar.state.day = "2026-08-10"; await calendar.load();
    expect(calendar.state.appointments).toHaveLength(2);
    const editor = createAppointmentEditor(); await editor.load(); editor.state.locationId = "south";
    await editor.lookup(calendar.state.appointments.find(item => item.id === booked!.id)!.id);
    for (const day of ["2026-08-11", "2026-08-12"]) {
      await editor.availability(day); const slot = editor.state.slots[0]!;
      editor.state.pending = { kind: "reschedule", startAt: slot.startAt };
      expect(await editor.confirm()).toBe(true);
      expect(editor.state.selected).toMatchObject({ startAt: slot.startAt, externalCalendarEventId: booked!.externalCalendarEventId });
      await calendar.refresh(); expect(calendar.state.appointments).toHaveLength(2);
    }
    editor.state.pending = { kind: "cancel" }; expect(await editor.confirm()).toBe(true);
    await calendar.refresh(); expect(calendar.visible.value.map(item => item.id)).toEqual([neighbor.id]);
    calendar.state.showCancelled = true; expect(calendar.visible.value).toHaveLength(2);
    expect(await api.locationAppointment("south", neighbor.id)).toEqual(neighbor);
    expect(create).toHaveBeenCalledTimes(2); expect(move).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(1);
    for (const [command] of [...move.mock.calls, ...cancel.mock.calls]) expect(command).toMatchObject({
      appointmentId: booked!.id, externalEventId: booked!.externalCalendarEventId, locationId: "south", employeeId: "employee-1",
    });
    expect(requests.filter(item => item.method === "POST" && item.url === "/api/appointments")).toHaveLength(2);
  });
  it("rejects simultaneous UI bookings for a professional or shared location capacity", async () => {
    const { customer, second } = await fixture();
    const search = createAvailabilitySearch(); disposers.push(search.dispose);
    await search.load({ locationId: "south", day: "2026-08-10" }); await search.search();
    const slot = search.state.slots[0]!;
    const input = { locationId: "south", customerId: customer.id, serviceId: "consultation", employeeId: slot.employeeId, startAt: slot.startAt };
    const outcomes = await Promise.allSettled([api.createAppointment(input), api.createAppointment({ ...input, employeeId: "employee-2", customerId: second.id })]);
    expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "SLOT_NO_LONGER_AVAILABLE" } });
    expect((await api.appointmentCalendar("south", range)).appointments).toHaveLength(1);
  });
  it("shows an unconfirmed failure in the calendar without a success message or automatic retry", async () => {
    const { provider, customer } = await fixture();
    vi.spyOn(provider, "createEvent").mockResolvedValueOnce({ ok: false, error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
    const search = createAvailabilitySearch(); disposers.push(search.dispose);
    await search.load({ locationId: "south", day: "2026-08-10" }); await search.search(); search.select(search.state.slots[0]!);
    expect(await search.book(customer.id)).toBeUndefined(); expect(search.state.error).toContain("could not be verified");
    expect((await api.appointmentCalendar("south", range)).appointments[0]?.status).toBe("FAILED");
    expect(await search.book(customer.id)).toBeUndefined(); expect(provider.createEvent).toHaveBeenCalledTimes(1);
  });
});
