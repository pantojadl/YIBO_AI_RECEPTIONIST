import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DEVELOPMENT_BUSINESS } from "../../src/app/development-fixtures.js";
import { migrateDatabase, seedBusiness } from "../../src/infrastructure/database/regional-database.js";
import { SqliteAppointmentRepository } from "../../src/infrastructure/database/sqlite-appointment-repository.js";
import type { Appointment } from "../../src/modules/appointments/index.js";

const database = new DatabaseSync(":memory:");
try {
  migrateDatabase(database);
  for (const region of ["MX", "US"] as const) {
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      const profile = structuredClone(DEVELOPMENT_BUSINESS);
      profile.region = region; profile.tenantId = tenantId; profile.businessId = `${region}-${tenantId}`;
      profile.locations[0]!.calledNumbers = [];
      profile.locations.push({ ...structuredClone(profile.locations[0]!), id: "south" });
      seedBusiness(database, profile);
      database.prepare("INSERT INTO customers(region_id, tenant_id, id, phone) VALUES (?, ?, ?, ?)")
        .run(region, tenantId, "customer-1", "+15550000001");
      const repository = new SqliteAppointmentRepository(database, region);
      for (const locationId of ["default", "south"]) {
        const appointment: Appointment = {
          id: `appointment-${locationId}`, tenantId, locationId, customerId: "customer-1",
          serviceId: "consultation", employeeId: "employee-1", serviceNameSnapshot: `${region}-${tenantId}-${locationId}`,
          priceAmountMinor: 0, priceCurrency: "USD", startAt: "2026-09-20T15:00:00.000Z",
          endAt: "2026-09-20T15:30:00.000Z", status: "CONFIRMED", idempotencyKey: locationId, source: "API",
        };
        await repository.save(appointment);
      }
    }
  }
  const mx = new SqliteAppointmentRepository(database, "MX");
  const us = new SqliteAppointmentRepository(database, "US");
  const original = (await mx.findById("tenant-a", "appointment-default"))!;
  await mx.save({ ...original, status: "CANCELLED" });
  assert.equal((await us.findById("tenant-a", original.id))?.status, "CONFIRMED");
  assert.equal((await mx.findById("tenant-b", original.id))?.status, "CONFIRMED");
  assert.equal((await mx.findById("tenant-a", "appointment-south"))?.status, "CONFIRMED");
  assert.equal(await mx.findById("unknown-tenant", original.id), null);
  for (const [region, repository] of [["MX", mx], ["US", us]] as const) {
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      for (const locationId of ["default", "south"]) {
        const rows = await repository.findUpcomingByCustomer({ tenantId, locationId, customerId: "customer-1", startsAtOrAfter: "2026-09-01" });
        const cancelled = region === "MX" && tenantId === "tenant-a" && locationId === "default";
        assert.deepEqual(rows.map(row => row.serviceNameSnapshot), cancelled ? [] : [`${region}-${tenantId}-${locationId}`]);
        assert.equal((await repository.findByIdempotencyKey(tenantId, locationId))?.serviceNameSnapshot, `${region}-${tenantId}-${locationId}`);
        const calendar = await repository.findInRange({ tenantId, locationId, rangeStart: "2026-09-20T15:00:00.000Z", rangeEnd: "2026-09-20T16:00:00.000Z" });
        assert.deepEqual(calendar.map(row => row.serviceNameSnapshot), [`${region}-${tenantId}-${locationId}`]);
        assert.equal(calendar[0]!.status, cancelled ? "CANCELLED" : "CONFIRMED");
        assert.deepEqual(await repository.findInRange({ tenantId, locationId, rangeStart: "2026-09-20T15:30:00.000Z", rangeEnd: "2026-09-20T16:00:00.000Z" }), []);
        assert.deepEqual(await repository.findInRange({ tenantId, locationId, rangeStart: "2026-09-20T14:30:00.000Z", rangeEnd: "2026-09-20T15:00:00.000Z" }), []);
      }
    }
  }
  console.log("regional tenant location isolation verified");
} finally { database.close(); }
