import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createApiServer } from "../../src/api/index.js";
import { DEVELOPMENT_US_BUSINESS } from "../../src/app/development-fixtures.js";
import { InMemoryAppointmentRepository } from "../../src/modules/appointments/infrastructure/in-memory-appointment-repository.js";
import type { Appointment } from "../../src/modules/appointments/index.js";
import type { GoogleOAuthService } from "../../src/modules/integrations/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const blocked = { ok: false, error: { code: "CALENDAR_ROUTE_IN_USE" } };
async function fixture(status: Appointment["status"] = "CONFIRMED", override?: string) {
  const profile = structuredClone(DEVELOPMENT_US_BUSINESS);
  profile.locations[0]!.defaultCalendarId = "old@example.test";
  if (override) profile.locations[0]!.professionals[0]!.calendarId = override;
  const appointments = new InMemoryAppointmentRepository();
  const app = buildApplication({ businesses: [profile], tenantId: profile.tenantId, appointmentRepository: appointments,
    googleOAuth: { verifyCalendarAccess: async () => "accessible" } as unknown as GoogleOAuthService });
  const appointment: Appointment = {
    id: "historical", tenantId: profile.tenantId, locationId: "default", employeeId: "employee-us-1",
    customerId: "synthetic", serviceId: "consultation", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "USD",
    startAt: "2026-09-21T15:30:00Z", endAt: "2026-09-21T16:00:00Z", status, idempotencyKey: "historical", source: "API",
    externalCalendarEventId: "legacy-id", // No route snapshot exists in historical rows.
  };
  await appointments.save(appointment);
  return { app, appointments, appointment, profile };
}

describe("configuration guards for booked routes", () => {
  it.each(["CONFIRMED", "PENDING_CONFIRMATION", "FAILED"] as const)("protects %s historical rows and keeps version unchanged", async status => {
    const { app } = await fixture(status);
    expect(await app.businessCatalog.updateLocationDefaultCalendar(app.tenantId, "default", "new@example.test", 1)).toEqual(blocked);
    expect(await app.business.getBusinessConfiguration(app.tenantId)).toMatchObject({ ok: true, value: { version: 1 } });
  });
  it("allows cancelled routes to change", async () => {
    const { app } = await fixture("CANCELLED");
    expect(await app.businessCatalog.updateLocationDefaultCalendar(app.tenantId, "default", "new@example.test", 1)).toMatchObject({ ok: true });
  });
  it("blocks adding/removing overrides and clearing defaults when effective IDs change", async () => {
    const { app } = await fixture();
    expect(await app.businessCatalog.updateProfessionalCalendar(app.tenantId, "default", "employee-us-1", "new@example.test", 1)).toEqual(blocked);
    expect(await app.businessCatalog.updateLocationDefaultCalendar(app.tenantId, "default", undefined, 1)).toEqual(blocked);
    const other = await fixture("CONFIRMED", "override@example.test");
    expect(await other.app.businessCatalog.updateProfessionalCalendar(other.app.tenantId, "default", "employee-us-1", undefined, 1)).toEqual(blocked);
    expect(await other.app.businessCatalog.updateLocationDefaultCalendar(other.app.tenantId, "default", "new@example.test", 1)).toMatchObject({ ok: true });
  });
  it("allows override/fallback changes with identical effective IDs", async () => {
    const { app } = await fixture();
    expect(await app.businessCatalog.updateProfessionalCalendar(app.tenantId, "default", "employee-us-1", "old@example.test", 1)).toMatchObject({ ok: true });
    expect(await app.businessCatalog.updateProfessionalCalendar(app.tenantId, "default", "employee-us-1", undefined, 2)).toMatchObject({ ok: true });
  });
  it("ignores other tenant/location/professional references", async () => {
    for (const scope of [{ tenantId: "other" }, { locationId: "other" }, { employeeId: "other" }]) {
      const { app, appointments, appointment } = await fixture("CANCELLED");
      await appointments.save({ ...appointment, ...scope, id: "other", status: "CONFIRMED" });
      expect(await app.businessCatalog.updateLocationDefaultCalendar(app.tenantId, "default", "new@example.test", 1)).toMatchObject({ ok: true });
    }
  });
  it("returns HTTP 409 for targeted and full-document bypass attempts without audit writes", async () => {
    const { app } = await fixture(); server = await createApiServer(app);
    const admin = await createAdminTestSession(app, server);
    const headers = { ...admin.mutationHeaders, "if-match": '"1"' };
    const document = await app.business.getBusinessConfiguration(app.tenantId);
    if (!document.ok) throw new Error("Missing configuration");
    document.value.configuration.locations[0]!.defaultCalendarId = "new@example.test";
    for (const request of [
      { url: "/api/admin/locations/default/calendar", payload: { calendarId: "new@example.test" } },
      { url: "/api/admin/locations/default/professionals/employee-us-1/calendar", payload: { calendarId: "new@example.test" } },
      { url: "/api/admin/business-configuration", payload: { configuration: document.value.configuration } },
    ]) {
      const response = await server.inject({ method: "PUT", headers, ...request });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: { code: "CALENDAR_ROUTE_IN_USE" } });
    }
    expect(await app.adminAudit.listByTenant(app.tenantId)).toHaveLength(0);
    expect(await app.businessCatalog.updateLocationDefaultCalendar(app.tenantId, "default", "new@example.test", 99))
      .toMatchObject({ ok: false, error: { code: "CONFIGURATION_VERSION_CONFLICT", currentVersion: 1 } });
  });
});

describe("booked route activation safety", () => {
  it.each(["business", "location", "assignment"] as const)("blocks disabling the %s while a booking needs its route", async scope => {
    const { app } = await fixture();
    const current = await app.business.getBusinessConfiguration(app.tenantId);
    if (!current.ok) throw new Error("Missing configuration");
    const candidate = structuredClone(current.value.configuration);
    if (scope === "business") candidate.active = false;
    if (scope === "location") {
      candidate.locations.push({ ...structuredClone(candidate.locations[0]!), id: "other", calledNumbers: ["+12025550188"] });
      candidate.locations[0]!.active = false;
      candidate.locations[0]!.calledNumbers = [];
    }
    if (scope === "assignment") candidate.locations[0]!.professionals[0]!.active = false;
    expect(await app.business.updateBusinessConfiguration(app.tenantId, candidate, 1)).toEqual(blocked);
    expect(await app.business.getBusinessConfiguration(app.tenantId)).toMatchObject({ ok: true, value: { version: 1 } });
  });
  it("allows location deactivation after its bookings are cancelled", async () => {
    const { app } = await fixture("CANCELLED");
    const current = await app.business.getBusinessConfiguration(app.tenantId);
    if (!current.ok) throw new Error("Missing configuration");
    current.value.configuration.locations.push({ ...structuredClone(current.value.configuration.locations[0]!), id: "other", calledNumbers: ["+12025550188"] });
    current.value.configuration.locations[0]!.active = false;
    current.value.configuration.locations[0]!.calledNumbers = [];
    expect(await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, 1)).toMatchObject({ ok: true });
  });
});

it("allows restoring access to an already-disabled route without changing its calendar", async () => {
  const { app, appointments, appointment } = await fixture("CANCELLED");
  const current = await app.business.getBusinessConfiguration(app.tenantId);
  if (!current.ok) throw new Error("Missing configuration");
  current.value.configuration.active = false;
  expect(await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, 1)).toMatchObject({ ok: true });
  await appointments.save({ ...appointment, status: "CONFIRMED" });
  current.value.configuration.active = true;
  expect(await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, 2)).toMatchObject({ ok: true });
});
