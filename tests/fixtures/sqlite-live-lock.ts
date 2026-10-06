import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase, openRegionalDatabase } from "../../src/infrastructure/database/regional-database.js";
import { SqliteAppointmentConcurrencyGuard } from "../../src/infrastructure/database/sqlite-appointment-concurrency-guard.js";
import { SqliteAppointmentRepository } from "../../src/infrastructure/database/sqlite-appointment-repository.js";
import { AppointmentOperationInProgressError } from "../../src/modules/appointments/index.js";
import { currentAppointmentFence } from "../../src/modules/appointments/application/appointment-lock.js";

const directory = mkdtempSync(join(tmpdir(), "yibo-live-lock-"));
const database = openRegionalDatabase("MX", join(directory, "mx.sqlite"));
migrateDatabase(database);
const clock = { ms: 1_000_000 };
const leaseMs = 60_000;
try {
  database.prepare("INSERT INTO businesses(region_id, tenant_id, business_id, profile_json) VALUES ('MX', 'tenant-a', 'business-a', '{}')").run();
  database.prepare("INSERT INTO customers(region_id, tenant_id, id, phone) VALUES ('MX', 'tenant-a', 'customer-1', '+529990000001')").run();
  const repository = new SqliteAppointmentRepository(database, "MX");
  const appointment = {
    id: "locked", tenantId: "tenant-a", locationId: "default", customerId: "customer-1",
    serviceId: "service-1", employeeId: "employee-1", serviceNameSnapshot: "Consultation",
    priceAmountMinor: 0, priceCurrency: "MXN", startAt: "2026-08-10T15:00:00.000Z",
    endAt: "2026-08-10T15:30:00.000Z", status: "CONFIRMED" as const, idempotencyKey: "locked",
    source: "DASHBOARD" as const, version: 1,
  };
  await repository.save(appointment);
  const guard = new SqliteAppointmentConcurrencyGuard(database, "MX", {
    now: () => clock.ms,
    leaseMs,
    heartbeatMs: 60 * 60_000,
  });
  let owner: { ownerId: string; fence: number } | undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = guard.execute("tenant-a", "default", "employee-1", async () => {
    owner = currentAppointmentFence();
    await gate;
    return repository.saveIfVersion({ ...appointment, version: 2, status: "CANCELLED" }, 1, "CONFIRMED");
  });
  assert.equal(owner?.fence, 1);
  clock.ms += 3 * 60_000;
  assert.equal(guard.heartbeat("tenant-a", "default", owner!.ownerId, owner!.fence), true);
  await assert.rejects(
    () => guard.execute("tenant-a", "default", "employee-1", async () => "second"),
    (error: unknown) => error instanceof AppointmentOperationInProgressError,
  );
  clock.ms += leaseMs;
  let releaseSteal: () => void = () => undefined;
  const stealGate = new Promise<void>((resolve) => { releaseSteal = resolve; });
  const stolen = guard.execute("tenant-a", "default", "employee-1", async () => {
    const fence = currentAppointmentFence();
    await stealGate;
    return fence?.fence;
  });
  release();
  assert.equal(await held, false);
  assert.equal((await repository.findById("tenant-a", "locked"))?.status, "CONFIRMED");
  assert.equal(guard.listClaims("tenant-a")[0]?.fence, 2);
  releaseSteal();
  assert.equal(await stolen, 2);
  console.log(JSON.stringify({ heartbeatsHold: true, missedHeartbeatsSteal: true, staleFenceRejected: true }));
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
