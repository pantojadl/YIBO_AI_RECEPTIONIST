import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createApiServer } from "../../src/api/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";
import { api, type Appointment, type AvailabilityLocation, type Slot } from "../../dashboard/src/services/api.js";
import { availabilityRange, availabilityTime, createAvailabilitySearch } from "../../dashboard/src/services/availability-search.js";

let server: FastifyInstance | undefined;
const disposers: Array<() => void> = [];
afterEach(async () => { disposers.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks(); await server?.close(); server = undefined; });
const clock = () => new Date("2026-08-01T00:00:00Z");
async function fixture() {
  const app = buildApplication({ clock: { now: clock } });
  const document = await app.business.getBusinessConfiguration(app.tenantId);
  if (!document.ok) throw new Error("Missing configuration");
  const configuration = document.value.configuration;
  const north = structuredClone(configuration.locations[0]!);
  north.id = "north"; north.name = "North clinic"; north.timezone = "America/New_York"; north.calledNumbers = ["+19155550140"];
  north.defaultCalendarId = "private-north@example.invalid";
  north.closures = [{ id: "private-closure", startLocal: "2026-12-25T00:00", endLocal: "2026-12-26T00:00", administrativeReason: "Private closure reason" }];
  north.professionals = [{ professionalId: "north-provider", active: true, serviceIds: ["consultation"], openingHours: [], calendarId: "private-provider@example.invalid" }];
  north.services = north.services.map(offering => ({ ...offering, active: offering.serviceId === "consultation" }));
  north.policies.availabilitySuggestions = { enabled: true, expansionDays: 1, maximumAlternatives: 2 };
  configuration.professionals.push({ id: "north-provider", displayName: "North Provider", active: true });
  const closed = structuredClone(north); closed.id = "closed"; closed.active = false; closed.calledNumbers = [];
  configuration.locations.push(north, closed);
  expect((await app.business.updateBusinessConfiguration(app.tenantId, configuration, document.value.version)).ok).toBe(true);
  const customer = await app.customers.findOrCreateByPhone({ tenantId: app.tenantId, phone: "+19155550199", name: "Test Caller" });
  if (!customer.ok) throw new Error("Missing customer");
  server = await createApiServer(app);
  const session = await createAdminTestSession(app, server, ["operator"]);
  const requests: Array<{ method: string; url: string; body?: any; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({
      method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const response = await server!.inject({ method: method as "GET" | "POST", url,
      headers: { ...(method === "GET" ? session.readHeaders : session.mutationHeaders), ...Object.fromEntries(new Headers(init?.headers).entries()) },
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(response.body, { status: response.statusCode });
  });
  const search = createAvailabilitySearch(api, clock); disposers.push(search.dispose);
  await search.load(); search.state.filters.locationId = "north"; search.state.filters.day = "2026-08-10";
  return { app, search, requests, customer: customer.value, session };
}

describe("Checkpoint C availability through the authenticated API", () => {
  it("uses operator-safe location catalogs and assignments without leaking administrative configuration", async () => {
    const { search, session } = await fixture();
    expect(search.state.locations.map(item => item.id)).toEqual(["default", "north"]);
    expect(search.location.value!.services.map(item => item.id)).toEqual(["consultation"]);
    expect(search.professionals.value).toEqual([{ id: "north-provider", displayName: "North Provider", name: "North Provider", serviceIds: ["consultation"] }]);
    const metadata = await api.appointmentLocations();
    expect(metadata.locations.find(item => item.id === "closed")!.active).toBe(false);
    const text = JSON.stringify(metadata);
    for (const privateValue of ["private-north", "private-provider", "Private closure reason", "+19155550140", "transferDestination", "calendarId", "openingHours"]) expect(text).not.toContain(privateValue);
    expect((await server!.inject({ url: "/api/appointment-locations" })).statusCode).toBe(401);
    expect((await server!.inject({ url: "/api/appointment-locations?tenantId=other", headers: session.readHeaders })).statusCode).toBe(400);
    expect((await server!.inject({ url: "/api/admin/business-configuration", headers: session.readHeaders })).statusCode).toBe(403);
  });

  it("keeps preferred results first, labels alternatives and sends the selected location's local range", async () => {
    const { search, requests } = await fixture();
    Object.assign(search.state.filters, { startTime: "09:00", endTime: "09:30" });
    expect(await search.search()).toBe(true);
    expect(search.requested.value).toHaveLength(1);
    expect(search.alternatives.value).toHaveLength(2);
    expect(search.requested.value[0]!.startAt).toBe("2026-08-10T13:00:00.000Z");
    expect(search.alternatives.value.every(slot => slot.outsideRequestedRange && slot.employeeId === "north-provider")).toBe(true);
    expect(search.state.selected).toBeUndefined();
    const query = new URL(requests.at(-1)!.url, "http://localhost").searchParams;
    expect(Object.fromEntries(query)).toEqual({ locationId: "north", serviceId: "consultation", rangeStart: "2026-08-10T13:00:00.000Z", rangeEnd: "2026-08-10T13:30:00.000Z" });
  });

  it("distinguishes a successful empty search from an error and keeps default suggestions disabled", async () => {
    const { search } = await fixture();
    search.state.filters.locationId = "default";
    Object.assign(search.state.filters, { startTime: "07:00", endTime: "08:00" });
    expect(search.location.value!.availabilitySuggestions).toEqual({ enabled: false, expansionDays: 1, maximumAlternatives: 3 });
    expect(await search.search()).toBe(true); expect(search.state.phase).toBe("results");
    expect(search.state.slots).toEqual([]); expect(search.state.error).toBe("");
  });

  it("clears old results and selection when date, time, provider, service or location changes", async () => {
    const { search } = await fixture();
    for (const [field, value] of [["day", "2026-08-11"], ["startTime", "09:00"], ["endTime", "11:00"], ["employeeId", "north-provider"], ["serviceId", "cleaning"], ["locationId", "default"]] as const) {
      Object.assign(search.state.filters, { locationId: "north", serviceId: "consultation", employeeId: "", day: "2026-08-10", startTime: "", endTime: "" });
      await search.search(); search.select(search.state.slots[0]!); expect(search.state.selected).toBeDefined();
      search.state.filters[field] = value;
      expect(search.state.slots).toEqual([]); expect(search.state.selected).toBeUndefined(); expect(search.state.phase).toBe("idle");
    }
    expect(search.state.filters.employeeId).toBe("");
    expect(search.professionals.value.some(item => item.id === "north-provider")).toBe(false);
  });

  it("books exactly the selected alternative at the selected location and consumes it once", async () => {
    const { search, customer, app, requests } = await fixture();
    Object.assign(search.state.filters, { startTime: "08:00", endTime: "09:00" });
    await search.search(); const slot = search.alternatives.value[0]!; search.select(slot);
    const appointment = await search.book(customer.id);
    expect(appointment).toMatchObject({ status: "CONFIRMED", locationId: "north", employeeId: "north-provider", startAt: slot.startAt, endAt: slot.endAt });
    expect(await search.book(customer.id)).toBeUndefined();
    const posts = requests.filter(item => item.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(posts[0]?.body).not.toHaveProperty("idempotencyKey");
    expect(await app.appointments.listUpcomingAppointments({ tenantId: app.tenantId, locationId: "north", customerId: customer.id })).toHaveLength(1);
    expect(await app.appointments.listUpcomingAppointments({ tenantId: app.tenantId, locationId: "default", customerId: customer.id })).toEqual([]);
    expect(await app.adminAudit.listByTenant(app.tenantId)).toHaveLength(1);
    expect(search.state.selected).toBeUndefined();
  });

  it("preserves legacy default-location creation and rejects untrusted location/tenant inputs", async () => {
    const { search, customer, session } = await fixture();
    search.state.filters.locationId = "default"; await search.search(); const slot = search.state.slots[0]!;
    const body = { customerId: customer.id, serviceId: "consultation", employeeId: slot.employeeId, startAt: slot.startAt };
    for (const invalid of [{ locationId: "" }, { locationId: ["north"] }, { tenantId: "other" }]) {
      expect((await server!.inject({ method: "POST", url: "/api/appointments", headers: session.mutationHeaders, payload: { ...body, ...invalid } })).statusCode).toBe(400);
    }
    expect((await server!.inject({ method: "POST", url: "/api/appointments", headers: session.readHeaders, payload: body })).statusCode).toBe(403);
    const outside = await server!.inject({ method: "POST", url: "/api/appointments", headers: session.mutationHeaders, payload: { ...body, locationId: "other-tenant-location" } });
    expect(outside.statusCode).toBeGreaterThanOrEqual(400);
    expect(await api.createAppointment(body)).toMatchObject({ status: "CONFIRMED", locationId: "default", startAt: slot.startAt });
  });

  it("reports Calendar failures without fabricating availability, confirming or retrying a booking", async () => {
    const { app, search, customer, requests } = await fixture();
    vi.spyOn(app.scheduling, "findAvailableSlots").mockResolvedValueOnce({ ok: false, error: { code: "EXTERNAL_CALENDAR_UNAVAILABLE", retryable: true } });
    expect(await search.search()).toBe(false); expect(search.state.phase).toBe("error");
    expect(search.state.error).toContain("could not be verified"); expect(search.state.slots).toEqual([]);
    await search.search(); search.select(search.state.slots[0]!);
    vi.spyOn(app.appointments, "createAppointment").mockResolvedValueOnce({ ok: false, error: { code: "CALENDAR_SYNC_FAILED", retryable: true } });
    expect(await search.book(customer.id)).toBeUndefined(); expect(search.state.error).toContain("Check Appointments");
    expect(search.state.selected).toBeUndefined(); await search.book(customer.id);
    expect(requests.filter(item => item.method === "POST")).toHaveLength(1);
  });

  it("revalidates a selected time that another booking has taken", async () => {
    const { app, search, customer } = await fixture();
    await search.search(); const slot = search.state.slots[0]!; search.select(slot);
    expect((await app.appointments.createAppointment({ tenantId: app.tenantId, locationId: "north", customerId: customer.id,
      serviceId: "consultation", employeeId: slot.employeeId, startAt: slot.startAt, source: "DASHBOARD", idempotencyKey: "competing" })).ok).toBe(true);
    expect(await search.book(customer.id)).toBeUndefined(); expect(search.state.error).toContain("no longer available");
    expect(search.state.slots).toEqual([]);
  });

  it("rejects incomplete time filters and ineligible providers before making a search request", async () => {
    const { search, requests } = await fixture(); const count = requests.length;
    search.state.filters.startTime = "09:00"; expect(await search.search()).toBe(false); expect(search.state.error).toContain("both times");
    search.state.filters.startTime = ""; search.state.filters.employeeId = "employee-1";
    expect(await search.search()).toBe(false); expect(search.state.error).toContain("this location");
    expect(requests).toHaveLength(count);
  });
});

describe("availability local dates and daylight saving", () => {
  it.each([
    ["2026-03-08", "", "", "2026-03-08T06:00:00.000Z", "2026-03-09T05:00:00.000Z"],
    ["2026-11-01", "", "", "2026-11-01T05:00:00.000Z", "2026-11-02T06:00:00.000Z"],
    ["2026-03-08", "03:30", "04:30", "2026-03-08T08:30:00.000Z", "2026-03-08T09:30:00.000Z"],
  ])("converts %s %s–%s in the location timezone", (day, start, end, rangeStart, rangeEnd) => {
    expect(availabilityRange(day!, start!, end!, "America/Chicago")).toEqual({ rangeStart, rangeEnd });
  });
  it.each([
    ["2026-02-30", "", ""], ["not-a-date", "", ""], ["2026-03-08", "02:30", "04:30"], ["2026-11-01", "01:30", "02:30"],
    ["2026-08-10", "11:00", "09:00"], ["2026-08-10", "09:00", "09:00"], ["2026-08-10", "09:00", ""],
  ])("rejects invalid local range %s %s–%s", (day, start, end) => {
    expect(() => availabilityRange(day!, start!, end!, "America/Chicago")).toThrow();
  });
  it("includes the actual date and timezone when an alternative is on another local day", () => {
    expect(availabilityTime("2026-08-11T01:00:00Z", "America/Chicago")).toContain("Aug 10, 2026");
    expect(availabilityTime("2026-08-11T01:00:00Z", "America/Chicago")).toContain("8:00 PM CDT");
    expect(availabilityTime("2026-08-11T01:00:00Z", "Asia/Tokyo")).toContain("Aug 11, 2026");
  });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function controlled() {
  const location: AvailabilityLocation = { id: "north", name: "North", active: true, timezone: "America/Chicago", minimumCancellationNoticeMinutes: 0, minimumRescheduleNoticeMinutes: 0,
    services: [{ id: "consultation", name: "Consultation", durationMinutes: 30, bufferMinutes: 0, eligibleEmployeeIds: ["provider"] }],
    professionals: [{ id: "provider", displayName: "Provider", name: "Provider", serviceIds: ["consultation"] }], availabilitySuggestions: { enabled: false, expansionDays: 1, maximumAlternatives: 3 } };
  const client = { appointmentLocations: vi.fn().mockResolvedValue({ locations: [location] }), availability: vi.fn(), createAppointment: vi.fn() };
  const search = createAvailabilitySearch(client, clock); disposers.push(search.dispose); await search.load();
  const slot: Slot = { employeeId: "provider", startAt: "2026-08-10T14:00:00Z", endAt: "2026-08-10T14:30:00Z" };
  return { search, client, slot };
}
describe("availability request ownership", () => {
  it("ignores an older search after filters change and a newer search completes", async () => {
    const { search, client, slot } = await controlled(); const older = deferred<{ slots: Slot[] }>();
    client.availability.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ slots: [slot] });
    const first = search.search(); search.state.filters.day = "2026-08-10";
    expect(await search.search()).toBe(true); search.select(slot);
    older.resolve({ slots: [] }); expect(await first).toBe(false);
    expect(search.state.slots).toEqual([slot]); expect(search.state.selected).toEqual(slot); expect(search.state.phase).toBe("results");
  });
  it("does not revive search state after leaving the screen", async () => {
    const { search, client, slot } = await controlled(); const response = deferred<{ slots: Slot[] }>();
    client.availability.mockReturnValue(response.promise); const pending = search.search(); search.dispose();
    response.resolve({ slots: [slot] }); expect(await pending).toBe(false); expect(search.state.slots).toEqual([]);
  });
  it("consumes a booking selection before duplicate clicks can send another mutation", async () => {
    const { search, client, slot } = await controlled(); client.availability.mockResolvedValue({ slots: [slot] });
    await search.search(); search.select(slot); const response = deferred<Appointment>(); client.createAppointment.mockReturnValue(response.promise);
    const pending = search.book("customer"); expect(await search.book("customer")).toBeUndefined();
    expect(client.createAppointment).toHaveBeenCalledTimes(1); expect(search.state.booking).toBe(true);
    response.resolve({ id: "appointment", locationId: "north", customerId: "customer", serviceId: "consultation", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "USD", status: "CONFIRMED", ...slot });
    expect(await pending).toMatchObject({ id: "appointment", status: "CONFIRMED" }); expect(search.state.booking).toBe(false);
  });
  it("shows missing choices and load failures without inventing availability", async () => {
    const { search, client } = await controlled(); client.appointmentLocations.mockResolvedValueOnce({ locations: [] });
    await search.load(); expect(search.state.locations).toEqual([]); expect(await search.search()).toBe(false);
    client.appointmentLocations.mockRejectedValueOnce(new Error("offline")); await search.load(); expect(search.state.metadataError).toContain("retry");
    expect(client.availability).not.toHaveBeenCalled();
  });
});
