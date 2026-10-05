import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildConfiguredApplication } from "../../src/bootstrap/build-configured-application.js";
import { DEVELOPMENT_US_BUSINESS } from "../../src/app/development-fixtures.js";
import { openRegionalDatabase } from "../../src/infrastructure/database/regional-database.js";
import { SqliteAppointmentConcurrencyGuard } from "../../src/infrastructure/database/sqlite-appointment-concurrency-guard.js";
import { AppointmentOperationInProgressError } from "../../src/modules/appointments/index.js";
import { InMemoryCalendarAdapter } from "../../src/modules/integrations/index.js";
const directory = mkdtempSync(join(tmpdir(), "yibo-appointment-locks-"));
const path = join(directory, "us.sqlite");
const profile = structuredClone(DEVELOPMENT_US_BUSINESS);
const calendar = new InMemoryCalendarAdapter();
const options = { environment: { YIBO_DATABASE_US: path }, businesses: [profile], tenantId: profile.tenantId,
  calendar, clock: { now: () => new Date("2026-08-01T00:00:00Z") } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
let worker: ReturnType<typeof fork> | undefined;
try {
  const api = await buildConfiguredApplication(options), voice = await buildConfiguredApplication(options);
  const customer = await api.customers.findOrCreateByPhone({ tenantId: profile.tenantId, phone: "+15550000888", name: "Two process example" }); assert(customer.ok);
  const command = { tenantId: profile.tenantId, locationId: "default", customerId: customer.value.id, serviceId: "consultation",
    employeeId: "employee-us-1", startAt: "2026-08-10T15:00:00Z", idempotencyKey: "original", source: "DASHBOARD" as const };
  const originalCreate = calendar.createEvent.bind(calendar), originalMove = calendar.rescheduleEvent.bind(calendar);
  const originalCancel = calendar.cancelEvent.bind(calendar);
  let creates = 0, moves = 0, cancels = 0;
  const enteredCreate = deferred(), releaseCreate = deferred();
  calendar.createEvent = async input => { creates++; const result = await originalCreate(input); if (creates === 1) { enteredCreate.resolve(); await releaseCreate.promise; } return result; };
  calendar.cancelEvent = async input => { cancels++; return originalCancel(input); };
  const pending = api.appointments.createAppointment(command); await enteredCreate.promise;
  const competitor = await voice.appointments.createAppointment({ ...command, idempotencyKey: "competitor" });
  assert.deepEqual(competitor, { ok: false, error: { code: "APPOINTMENT_OPERATION_IN_PROGRESS" } });
  assert.equal(creates, 1); releaseCreate.resolve(); const booked = await pending; assert(booked.ok);
  const scope = { tenantId: profile.tenantId, locationId: "default", appointmentId: booked.value.id };
  const neighbor = await voice.appointments.createAppointment({ ...command, startAt: "2026-08-10T18:00:00Z", idempotencyKey: "neighbor" }); assert(neighbor.ok);
  const enteredMove = deferred(), releaseMove = deferred();
  calendar.rescheduleEvent = async input => { moves++; const result = await originalMove(input); if (moves === 1) { enteredMove.resolve(); await releaseMove.promise; } return result; };
  const moving = api.appointments.rescheduleAppointment({ ...scope, expectedVersion: booked.value.version, startAt: "2026-08-11T16:00:00Z" }); await enteredMove.promise;
  assert.deepEqual(await voice.appointments.cancelAppointment(scope), { ok: false, error: { code: "APPOINTMENT_OPERATION_IN_PROGRESS" } });
  assert.equal(cancels, 0); releaseMove.resolve(); const moved = await moving; assert(moved.ok); assert.equal(moved.value.version, 3);
  assert.deepEqual(await voice.appointments.cancelAppointment({ ...scope, expectedVersion: booked.value.version }), { ok: false, error: { code: "APPOINTMENT_VERSION_CONFLICT" } });
  const movedAgain = await voice.appointments.rescheduleAppointment({ ...scope, expectedVersion: moved.value.version, startAt: "2026-08-12T16:00:00Z" }); assert(movedAgain.ok);
  assert.equal(movedAgain.value.externalCalendarEventId, booked.value.externalCalendarEventId); assert.equal(movedAgain.value.version, 4);
  const cancelled = await api.appointments.cancelAppointment({ ...scope, expectedVersion: movedAgain.value.version }); assert(cancelled.ok);
  assert.equal(cancelled.value.version, 5); assert.equal(cancelled.value.externalCalendarEventId, booked.value.externalCalendarEventId);
  assert.equal(creates, 2); assert.equal(moves, 2); assert.equal(cancels, 1);
  assert.deepEqual(await voice.appointments.getAppointment(scope), cancelled);
  assert.deepEqual(await voice.appointments.getAppointment({ ...scope, appointmentId: neighbor.value.id }), neighbor);
  assert.deepEqual(await calendar.getBusyIntervals({ ...command, rangeStart: "2026-08-10T00:00:00Z", rangeEnd: "2026-08-13T00:00:00Z" }),
    { ok: true, value: [{ startAt: neighbor.value.startAt, endAt: neighbor.value.endAt }] });
  const database = openRegionalDatabase("US", path);
  try {
    const guard = new SqliteAppointmentConcurrencyGuard(database, "US");
    await assert.rejects(guard.execute(profile.tenantId, "default", "test", async () => { throw new Error("synthetic provider exception"); }), /synthetic provider exception/);
    assert.equal(database.prepare("SELECT COUNT(*) n FROM appointment_operation_locks").get()!.n, 0);
    worker = fork("tests/fixtures/appointment-lock-worker.ts", [path, profile.tenantId, "default"], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const ready = await once(worker, "message"); assert.deepEqual(ready[0], { held: true });
    const neighborScope = { ...scope, appointmentId: neighbor.value.id };
    assert.deepEqual(await api.appointments.cancelAppointment(neighborScope), { ok: false, error: { code: "APPOINTMENT_OPERATION_IN_PROGRESS" } });
    assert.equal(await guard.execute(profile.tenantId, "other-location", "test", async () => 42), 42);
    assert.equal(await guard.execute("other-tenant", "default", "test", async () => 42), 42);
    assert.equal(await new SqliteAppointmentConcurrencyGuard(database, "MX").execute(profile.tenantId, "default", "test", async () => 42), 42);
    const exiting = once(worker, "exit"); worker.kill("SIGKILL"); await exiting; worker = undefined;
    const lock = database.prepare("SELECT owner_id FROM appointment_operation_locks WHERE region_id = 'US' AND tenant_id = ? AND location_id = 'default'").get(profile.tenantId)!;
    assert(lock); assert.equal(typeof lock.owner_id, "string");
    await assert.rejects(guard.execute(profile.tenantId, "default", "test", async () => { throw new Error("must not run"); }), AppointmentOperationInProgressError);
    // Only this disposable fixture: provider state is known unchanged after killing its synthetic worker.
    database.prepare("DELETE FROM appointment_operation_locks WHERE region_id = 'US' AND tenant_id = ? AND location_id = 'default' AND owner_id = ?").run(profile.tenantId, String(lock.owner_id));
    assert.equal(await guard.execute(profile.tenantId, "default", "test", async () => 42), 42);
  } finally { database.close(); }
  console.log(JSON.stringify({ sameDatabaseWriters: true, realProcessContention: true, crashFailsClosed: true,
    scopedLocks: true, providerFailureReleases: true, revisionsPersisted: true, originalEventPreserved: true, noDuplicates: true, neighborUnchanged: true }));
} finally { worker?.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
