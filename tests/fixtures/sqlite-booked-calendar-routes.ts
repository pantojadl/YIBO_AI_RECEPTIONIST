import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DEVELOPMENT_US_BUSINESS } from "../../src/app/development-fixtures.js";
import { migrateDatabase, seedBusiness } from "../../src/infrastructure/database/regional-database.js";
import { SqliteBusinessRepository } from "../../src/infrastructure/database/sqlite-business-repository.js";
import { SqliteAppointmentRepository } from "../../src/infrastructure/database/sqlite-appointment-repository.js";
import type { Appointment } from "../../src/modules/appointments/index.js";

const db = new DatabaseSync(":memory:");
try {
  migrateDatabase(db);
  const profile = structuredClone(DEVELOPMENT_US_BUSINESS);
  profile.locations[0]!.defaultCalendarId = "old@example.test";
  seedBusiness(db, profile);
  db.prepare("INSERT INTO customers(region_id, tenant_id, id, phone) VALUES (?, ?, ?, ?)")
    .run("US", profile.tenantId, "synthetic", "+12025550101");
  const appointments = new SqliteAppointmentRepository(db, "US");
  const business = new SqliteBusinessRepository(db, "US");
  const appointment: Appointment = {
    id: "legacy", tenantId: profile.tenantId, locationId: "default", employeeId: "employee-us-1", customerId: "synthetic",
    serviceId: "consultation", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "USD",
    startAt: "2026-09-21T15:30:00Z", endAt: "2026-09-21T16:00:00Z", status: "CONFIRMED", idempotencyKey: "legacy", source: "API", externalCalendarEventId: "original-event",
  };
  const next = structuredClone(profile); next.locations[0]!.defaultCalendarId = "new@example.test";
  for (const status of ["PENDING_CONFIRMATION", "CONFIRMED", "FAILED"] as const) {
    await appointments.save({ ...appointment, status });
    assert.deepEqual(await business.saveIfVersion(next, 1), { saved: false, currentVersion: 1, reason: "CALENDAR_ROUTE_IN_USE" });
    await assert.rejects(business.save(next), /CALENDAR_ROUTE_IN_USE/);
    assert.equal((await business.findConfigurationByTenantId(profile.tenantId))?.version, 1);
    assert.equal((await appointments.findById(profile.tenantId, appointment.id))?.externalCalendarEventId, "original-event");
  }
  assert.deepEqual(await business.saveIfVersion(next, 9), { saved: false, currentVersion: 1 });
  const disabled = structuredClone(profile); disabled.active = false;
  assert.deepEqual(await business.saveIfVersion(disabled, 1), { saved: false, currentVersion: 1, reason: "CALENDAR_ROUTE_IN_USE" });
  await assert.rejects(business.save(disabled), /CALENDAR_ROUTE_IN_USE/);
  const harmless = structuredClone(profile); harmless.name = "New display name";
  assert.deepEqual(await business.saveIfVersion(harmless, 1), { saved: true, version: 2 });
  assert.deepEqual(new SqliteAppointmentRepository(db, "MX").calendarRouteReferences(profile.tenantId), []);
  assert.deepEqual(appointments.calendarRouteReferences("another-tenant"), []);
  await appointments.save({ ...appointment, status: "CANCELLED" });
  assert.deepEqual(await business.saveIfVersion(next, 2), { saved: true, version: 3 });
  // A new pending booking reserves the new route; old route cannot be restored underneath it.
  await appointments.save({ ...appointment, id: "new", idempotencyKey: "new", status: "PENDING_CONFIRMATION" });
  assert.deepEqual(await business.saveIfVersion(profile, 3), { saved: false, currentVersion: 3, reason: "CALENDAR_ROUTE_IN_USE" });
  console.log(JSON.stringify({ passed: true }));
} finally { db.close(); }
