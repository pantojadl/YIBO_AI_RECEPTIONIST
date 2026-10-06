import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase, openRegionalDatabase } from "../../src/infrastructure/database/regional-database.js";
import { SqliteAppointmentRepository } from "../../src/infrastructure/database/sqlite-appointment-repository.js";

const directory = mkdtempSync(join(tmpdir(), "yibo-pending-slot-"));
const database = openRegionalDatabase("US", join(directory, "us.sqlite"));
migrateDatabase(database);
try {
  database.prepare(`INSERT INTO businesses(region_id, tenant_id, business_id, profile_json) VALUES ('US', 'tenant-a', 'business-a', '{}')`).run();
  database.prepare(`INSERT INTO customers(region_id, tenant_id, id, phone) VALUES ('US', 'tenant-a', 'customer-1', '+15550000001')`).run();
  const repository = new SqliteAppointmentRepository(database, "US");
  const row = {
    id: "pending-1", tenantId: "tenant-a", locationId: "default", customerId: "customer-1",
    serviceId: "service-1", employeeId: "employee-1", serviceNameSnapshot: "Consultation",
    priceAmountMinor: 0, priceCurrency: "USD", startAt: "2026-08-10T15:00:00.000Z",
    endAt: "2026-08-10T15:30:00.000Z", idempotencyKey: "pending", source: "DASHBOARD" as const,
  };
  const query = {
    tenantId: "tenant-a", locationId: "default", employeeId: "employee-1",
    rangeStart: row.startAt, rangeEnd: row.endAt,
  };
  await repository.save({ ...row, status: "PENDING_CONFIRMATION", version: 1 });
  assert.deepEqual(await repository.findConfirmedIntervals(query), [{ startAt: row.startAt, endAt: row.endAt }]);
  await repository.save({ ...row, status: "FAILED", version: 2 });
  assert.deepEqual(await repository.findConfirmedIntervals(query), []);
  console.log("pending slot occupies until failed");
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
