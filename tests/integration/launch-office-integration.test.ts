import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createApiServer } from "../../src/api/index.js";
import { DEVELOPMENT_BUSINESS } from "../../src/app/development-fixtures.js";
import { BusinessDirectoryService, InMemoryBusinessRepository, resolvedAiCapabilities } from "../../src/modules/business/index.js";
import { InMemoryCustomerRepository } from "../../src/modules/customers/index.js";
import { InMemoryAppointmentRepository, type Appointment } from "../../src/modules/appointments/index.js";
import { InMemoryCalendarAdapter } from "../../src/modules/integrations/index.js";
import { NotificationService, type NotificationDelivery } from "../../src/modules/notifications/index.js";
import type { AdminRole } from "../../src/modules/auth/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const range = { rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-15T00:00:00.000Z" };
async function fixture(role: AdminRole = "secretary") {
  const profile = structuredClone(DEVELOPMENT_BUSINESS);
  profile.locations[0]!.policies.availabilitySuggestions = { enabled: true, expansionDays: 1, maximumAlternatives: 2 };
  const repository = new InMemoryAppointmentRepository();
  const businessRepository = new InMemoryBusinessRepository([profile], id => repository.calendarRouteReferences(id));
  const customers = new InMemoryCustomerRepository();
  const deliveries: NotificationDelivery[] = [];
  const send = vi.fn(async () => ({ ok: true as const, messageId: "synthetic-delivery" }));
  const notifications = new NotificationService({
    save: async value => { const index = deliveries.findIndex(item => item.id === value.id); if (index < 0) deliveries.push(value); else deliveries[index] = value; },
    list: async (tenant, appointment) => deliveries.filter(item => item.tenantId === tenant && item.appointmentId === appointment),
  }, customers, new BusinessDirectoryService(businessRepository), { send }, () => `notice-${deliveries.length}`);
  const calendar = new InMemoryCalendarAdapter();
  const app = buildApplication({ businesses: [profile], businessRepository, customerRepository: customers,
    appointmentRepository: repository, appointmentNotifications: notifications, calendar,
    clock: { now: () => new Date("2026-08-01T00:00:00Z") } });
  server = await createApiServer(app);
  const session = await createAdminTestSession(app, server, [role]);
  async function request(url: string, method: "GET" | "POST" | "PUT" = "GET", payload?: object) {
    return server!.inject({ url, method, headers: method === "GET" ? session.readHeaders : session.mutationHeaders, ...(payload ? { payload } : {}) });
  }
  async function book() {
    const customer = await request("/api/customers", "POST", { name: "Launch Test", phone: "+1 (555) 000-0201", email: "launch@example.test", preferredLanguage: "es-MX", emailOptIn: true });
    expect(customer.statusCode).toBe(200);
    const created = await request("/api/appointments", "POST", { customerId: customer.json().id, locationId: "default", serviceId: "consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z" });
    expect(created.statusCode).toBe(201);
    return created.json<Appointment>();
  }
  return { app, customers, repository, calendar, notifications, deliveries, send, request, book, session };
}

describe("launch branch office and Product UX integration", () => {
  it("retains both location projections and active service/staff assignments", async () => {
    const { request } = await fixture();
    const location = (await request("/api/appointment-locations")).json().locations[0];
    expect(location).toMatchObject({ cancellationAllowed: true, reschedulingAllowed: true,
      availabilitySuggestions: { enabled: true, maximumAlternatives: 2 },
      services: expect.arrayContaining([expect.objectContaining({ id: "consultation", eligibleEmployeeIds: expect.arrayContaining(["employee-1"]) })]),
      professionals: expect.arrayContaining([expect.objectContaining({ id: "employee-1", name: "Dra. Ana", displayName: "Dra. Ana", serviceIds: expect.arrayContaining(["consultation"]) })]) });
    expect(JSON.stringify(location)).not.toMatch(/calendarId|calledNumbers|administrativeReason/);
  });

  it("books through the office, appears in both calendars and customer history, moves the same event twice, then cancels with delivery records", async () => {
    const { request, book, calendar, deliveries, send } = await fixture();
    const create = vi.spyOn(calendar, "createEvent"), move = vi.spyOn(calendar, "rescheduleEvent"), cancel = vi.spyOn(calendar, "cancelEvent");
    const appointment = await book();
    const path = `/api/locations/default/appointments/${appointment.id}`;
    const office = (await request(`/api/office/schedule?${new URLSearchParams({ locationId: "default", serviceId: "consultation", ...range })}`)).json();
    expect(office.appointments).toHaveLength(1); expect(office.slots.length).toBeGreaterThan(0);
    expect((await request(`/api/locations/default/appointment-calendar?${new URLSearchParams(range)}`)).json().appointments[0])
      .toMatchObject({ id: appointment.id, customerName: "Launch Test", customerPhone: "+15550000201", professionalName: "Dra. Ana" });
    expect((await request("/api/office/directory")).json().customers[0]).toMatchObject({ preferredLanguage: "es-MX", emailOptIn: true, appointmentCount: 1, professionalIds: ["employee-1"] });
    expect((await request(`/api/customers/${appointment.customerId}/appointments`)).json().appointments).toHaveLength(1);
    for (const day of ["11", "12"]) {
      const changed = await request(`${path}/reschedule`, "POST", { startAt: `2026-08-${day}T16:00:00.000Z` });
      expect(changed.statusCode).toBe(200); expect(changed.json().externalCalendarEventId).toBe(appointment.externalCalendarEventId);
    }
    expect((await request(`${path}/cancel`, "POST", {})).json().status).toBe("CANCELLED");
    const timeline = (await request(`${path}/events`)).json();
    expect(timeline.events.map((item: { type: string }) => item.type)).toEqual(["CREATED", "RESCHEDULED", "RESCHEDULED", "CANCELLED"]);
    expect(timeline.notifications.map((item: { status: string }) => item.status)).toEqual(["SENT", "SENT", "SENT", "SENT"]);
    expect(deliveries.map(item => item.kind)).toEqual(["CONFIRMATION", "RESCHEDULE", "RESCHEDULE", "CANCELLATION"]);
    expect(send).toHaveBeenCalledTimes(4); expect(create).toHaveBeenCalledTimes(1); expect(move).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce();
    for (const [command] of [...move.mock.calls, ...cancel.mock.calls]) expect(command.externalEventId).toBe(appointment.externalCalendarEventId);
    expect((await request(`/api/locations/default/appointment-calendar?${new URLSearchParams(range)}`)).json().appointments).toHaveLength(1);
  });

  it("retains completed/no-show outcomes in office filters, Product UX detail and customer history", async () => {
    const { request, book } = await fixture(); const appointment = await book();
    const path = `/api/locations/default/appointments/${appointment.id}`;
    for (const outcome of ["COMPLETED", "NO_SHOW"]) {
      expect((await request(`${path}/outcome`, "POST", { outcome })).json().outcomeStatus).toBe(outcome);
      expect((await request(`/api/office/schedule?${new URLSearchParams({ locationId: "default", status: outcome, ...range })}`)).json().appointments).toHaveLength(1);
      expect((await request(`/api/locations/default/appointment-calendar?${new URLSearchParams(range)}`)).json().appointments[0].outcomeStatus).toBe(outcome);
      expect((await request(`/api/customers/${appointment.customerId}/appointments`)).json().appointments[0].outcomeStatus).toBe(outcome);
    }
  });

  it("keeps appointment success authoritative for failed/skipped emails and applies cancellation rules to both UIs", async () => {
    const { request, book, notifications, deliveries, send, app } = await fixture();
    send.mockResolvedValueOnce({ ok: false, code: "PROVIDER_REJECTED" } as never);
    const appointment = await book(); expect(deliveries[0]!.status).toBe("FAILED");
    const path = `/api/locations/default/appointments/${appointment.id}`;
    expect((await request(`/api/customers/${appointment.customerId}`, "PUT", { emailOptIn: false })).statusCode).toBe(200);
    await notifications.appointmentChanged("RESCHEDULE", appointment);
    expect(deliveries[1]!.status).toBe("SKIPPED"); expect(send).toHaveBeenCalledOnce();
    const config = await app.business.getBusinessConfiguration(app.tenantId); if (!config.ok) throw new Error("config");
    config.value.configuration.locations[0]!.policies.cancellationAllowed = false;
    config.value.configuration.locations[0]!.policies.reschedulingAllowed = false;
    expect((await app.business.updateBusinessConfiguration(app.tenantId, config.value.configuration, config.value.version)).ok).toBe(true);
    expect((await request(`${path}/cancel`, "POST", {})).json().error.code).toBe("CANCELLATION_NOTICE_NOT_MET");
    expect((await request(`${path}/reschedule`, "POST", { startAt: "2026-08-11T15:00:00.000Z" })).json().error.code).toBe("RESCHEDULE_NOTICE_NOT_MET");
    expect((await request(path)).json().status).toBe("CONFIRMED");
  });

  it.each(["owner", "office_manager", "secretary", "read_only", "tenant_admin", "operator"] as const)("applies %s access to both API families and readiness", async role => {
    const { request } = await fixture(role);
    for (const url of ["/api/office/directory", "/api/appointment-locations", `/api/locations/default/appointment-calendar?${new URLSearchParams(range)}`]) {
      expect((await request(url)).statusCode).toBe(200);
    }
    const customer = await request("/api/customers", "POST", { phone: "+15550000999", name: "Role Test" });
    expect(customer.statusCode).toBe(role === "read_only" ? 403 : 200);
    const ready = await request("/api/admin/readiness");
    expect(ready.statusCode).toBe(["owner", "office_manager", "tenant_admin"].includes(role) ? 200 : 403);
    if (ready.statusCode === 200) expect(ready.json()).toMatchObject({ ready: false, providers: { email: false, telephony: false } });
    if (role === "read_only") {
      for (const suffix of ["cancel", "reschedule", "outcome"]) expect((await request(`/api/locations/default/appointments/anything/${suffix}`, "POST", {})).statusCode).toBe(403);
      expect((await request("/api/appointments", "POST", {})).statusCode).toBe(403);
    }
  });

  it("keeps customer, schedule, timeline and notification queries tenant/location scoped", async () => {
    const { app, request, book, customers, repository, notifications } = await fixture();
    const appointment = await book();
    await customers.save({ id: "foreign", tenantId: "other", phone: "+15550000777", name: "Foreign Example" });
    await repository.save({ ...appointment, id: "foreign", tenantId: "other", customerId: "foreign" });
    await notifications.appointmentChanged("CONFIRMATION", { ...appointment, id: "foreign", tenantId: "other" });
    expect((await request("/api/office/directory")).json().customers).toHaveLength(1);
    expect((await request(`/api/office/schedule?${new URLSearchParams({ locationId: "default", ...range })}`)).json().appointments).toHaveLength(1);
    expect((await request("/api/customers/foreign/appointments")).json().appointments).toEqual([]);
    expect((await request(`/api/locations/default/appointments/foreign/events`)).statusCode).toBe(404);
    const wrongLocation = await request(`/api/locations/other/appointments/${appointment.id}/events`);
    expect(wrongLocation.statusCode).toBe(404);
    expect((await request(`/api/office/schedule?${new URLSearchParams({ locationId: "default", tenantId: app.tenantId, ...range })}`)).statusCode).toBe(400);
  });

  it("keeps verified suggestions labeled and lets Operations further restrict them for the caller", async () => {
    const { app } = await fixture();
    const current = await app.business.getBusinessConfiguration(app.tenantId); if (!current.ok) throw new Error("business");
    const location = current.value.configuration.locations[0]!;
    const query = { service: "consultation", rangeStart: "2026-08-11T00:00:00Z", rangeEnd: "2026-08-11T01:00:00Z" };
    async function available(callId: string) {
      const context = { tenantId: app.tenantId, locationId: "default", callId, turnSequence: 1 };
      const result = await app.agents.prepare(context); if (!result.ok) throw new Error("agent");
      return result.value.toolExecutor.execute(context, { toolCallId: "availability", name: "check_availability", arguments: query });
    }
    const withSuggestions = await available("suggestions"); expect(withSuggestions.ok).toBe(true);
    if (!withSuggestions.ok) return;
    expect((withSuggestions.data as { slots: Array<{ outsideRequestedRange?: boolean }> }).slots)
      .toEqual(expect.arrayContaining([expect.objectContaining({ outsideRequestedRange: true, displayStart: expect.any(String), localStartAt: expect.any(String) })]));
    location.aiCapabilities = { ...resolvedAiCapabilities(location), offerAlternatives: false };
    expect((await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, current.value.version)).ok).toBe(true);
    expect(await available("restricted")).toMatchObject({ ok: true, data: { slots: [], availableSlots: [], earliestSlot: null } });
  });

  it("combines contact persistence, configured readback, price restrictions and location AI permissions in the real prepared agent", async () => {
    const { app, customers, repository } = await fixture();
    const customer = await app.customers.findOrCreateByPhone({ tenantId: app.tenantId, phone: "+15550000100" }); if (!customer.ok) throw new Error("customer");
    const current = await app.business.getBusinessConfiguration(app.tenantId); if (!current.ok) throw new Error("business");
    const location = current.value.configuration.locations[0]!;
    location.agentOverrides = { phoneReadback: "natural_grouped", locale: "en-GB" };
    location.aiCapabilities = { ...resolvedAiCapabilities(location), quotePrices: false, collectEmail: true, cancelAppointments: false };
    expect((await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, current.value.version)).ok).toBe(true);
    const context = { tenantId: app.tenantId, locationId: "default", callId: "merge-call", customerId: customer.value.id, turnSequence: 1 };
    const prepared = await app.agents.prepare(context); if (!prepared.ok) throw new Error("agent");
    const agent = prepared.value;
    const execute = (name: Parameters<typeof agent.toolExecutor.execute>[1]["name"], args: object) => agent.toolExecutor.execute(context, { name, arguments: args, toolCallId: name });
    expect(agent.locale).toBe("en-GB"); expect(agent.instructions).toContain("natural British English");
    expect(agent.instructions).toContain("Read in natural groups"); expect(agent.instructions).not.toContain("repeat the number digit by digit");
    expect(agent.behavior.allowPriceDisclosure).toBe(false);
    expect(await execute("cancel_appointment", {})).toMatchObject({ ok: false, error: { code: "TOOL_DISABLED" } });
    expect(await execute("create_appointment", { service: "consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00Z" }))
      .toMatchObject({ ok: false, error: { code: "CONTACT_CONFIRMATION_REQUIRED" } });
    expect(await execute("update_customer", { name: "Launch Voice", phone: "+1 (555) 000-0100", email: "voice@example.test", preferredLanguage: "en-GB" }))
      .toMatchObject({ ok: true, data: { saved: true, contactConfirmedForBooking: true, phoneReadback: "+ 1, 555, 000, 0100" } });
    expect(await customers.findById(app.tenantId, customer.value.id)).toMatchObject({ phone: "+15550000100", email: "voice@example.test", preferredLanguage: "en-GB" });
    const booked = await execute("create_appointment", { service: "consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00Z" });
    expect(booked).toMatchObject({ ok: true, data: { confirmed: true, localStartAt: "2026-08-10T09:00:00-06:00", professional: "Dra. Ana" } });
    expect(JSON.stringify(booked)).not.toContain('"price"');
    expect(await repository.findInRange({ tenantId: app.tenantId, locationId: "default", ...range })).toHaveLength(1);
  });
});
