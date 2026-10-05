import { describe, expect, it, vi } from "vitest";
import { buildApplication } from "../../src/bootstrap/index.js";
import { InMemoryAppointmentRepository } from "../../src/modules/appointments/index.js";
import { InMemoryCalendarAdapter } from "../../src/modules/integrations/index.js";

const nextStart = "2026-08-11T16:00:00.000Z";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const repository = new InMemoryAppointmentRepository(), calendar = new InMemoryCalendarAdapter();
  const app = buildApplication({ appointmentRepository: repository, calendar, clock: { now: () => new Date("2026-08-01T00:00:00Z") } });
  const customer = await app.customers.findOrCreateByPhone({ tenantId: app.tenantId, name: "Concurrency Example", phone: "+15550000800" });
  if (!customer.ok) throw new Error("customer");
  const result = await app.appointments.createAppointment({ tenantId: app.tenantId, locationId: "default", customerId: customer.value.id,
    serviceId: "consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00Z", idempotencyKey: "original", source: "DASHBOARD" });
  if (!result.ok) throw new Error("booking");
  const scope = { tenantId: app.tenantId, locationId: "default", appointmentId: result.value.id };
  function holdMove() {
    const entered = deferred(), release = deferred(); const original = calendar.rescheduleEvent.bind(calendar);
    vi.spyOn(calendar, "rescheduleEvent").mockImplementationOnce(async command => {
      const result = await original(command); entered.resolve(); await release.promise; return result;
    });
    return { entered: entered.promise, release: release.resolve };
  }
  return { app, repository, calendar, scope, booked: result.value, holdMove };
}

describe("RISK-001 appointment mutation serialization", () => {
  it("does not resurrect a cancelled appointment when a successful Calendar reschedule response arrives late", async () => {
    const f = await fixture(); const held = f.holdMove(); const cancelEvent = vi.spyOn(f.calendar, "cancelEvent");
    const moving = f.app.appointments.rescheduleAppointment({ ...f.scope, startAt: nextStart });
    await held.entered;
    const cancelling = f.app.appointments.cancelAppointment(f.scope);
    await tick(); const cancelledWhileMoving = cancelEvent.mock.calls.length;
    held.release(); const [move, cancel] = await Promise.all([moving, cancelling]);
    expect(move.ok).toBe(true); expect(cancel.ok).toBe(true);
    expect(cancelledWhileMoving).toBe(0);
    expect(await f.repository.findById(f.scope.tenantId, f.scope.appointmentId)).toMatchObject({ status: "CANCELLED", startAt: nextStart,
      externalCalendarEventId: f.booked.externalCalendarEventId });
    expect(await f.calendar.getBusyIntervals({ ...f.scope, employeeId: f.booked.employeeId, rangeStart: "2026-08-10T00:00:00Z", rangeEnd: "2026-08-12T00:00:00Z" }))
      .toEqual({ ok: true, value: [] });
  });

  it("does not lose an office outcome or restore the old time during a reschedule", async () => {
    const f = await fixture(); const held = f.holdMove();
    const moving = f.app.appointments.rescheduleAppointment({ ...f.scope, startAt: nextStart });
    await held.entered;
    const marking = f.app.appointments.markAppointmentOutcome({ ...f.scope, outcome: "COMPLETED" });
    await tick(); held.release(); await Promise.all([moving, marking]);
    expect(await f.repository.findById(f.scope.tenantId, f.scope.appointmentId)).toMatchObject({ startAt: nextStart, outcomeStatus: "COMPLETED" });
  });

  it("deletes and records cancellation only once when two operators cancel together", async () => {
    const f = await fixture(); const cancel = vi.spyOn(f.calendar, "cancelEvent");
    const results = await Promise.all([f.app.appointments.cancelAppointment(f.scope), f.app.appointments.cancelAppointment(f.scope)]);
    expect(results.filter(item => item.ok)).toHaveLength(1); expect(cancel).toHaveBeenCalledOnce();
    expect((await f.repository.listEvents(f.scope.tenantId, f.scope.appointmentId)).map(item => item.type)).toEqual(["CREATED", "CANCELLED"]);
  });

  it("uses the latest appointment snapshot for two queued reschedules and preserves event identity", async () => {
    const f = await fixture(); const held = f.holdMove();
    const first = f.app.appointments.rescheduleAppointment({ ...f.scope, startAt: nextStart });
    await held.entered;
    const second = f.app.appointments.rescheduleAppointment({ ...f.scope, startAt: "2026-08-12T16:00:00.000Z" });
    await tick(); held.release(); const results = await Promise.all([first, second]);
    expect(results.every(item => item.ok)).toBe(true);
    const changes = (await f.repository.listEvents(f.scope.tenantId, f.scope.appointmentId)).filter(item => item.type === "RESCHEDULED");
    expect(changes.map(item => item.metadata?.previousStartAt)).toEqual([f.booked.startAt, nextStart]);
    expect(await f.repository.findById(f.scope.tenantId, f.scope.appointmentId)).toMatchObject({ startAt: "2026-08-12T16:00:00.000Z", externalCalendarEventId: f.booked.externalCalendarEventId });
  });
});

describe("RISK-001 appointment edit preconditions", () => {
  it.each(["cancel", "reschedule", "outcome"] as const)("rejects a stale %s before side effects", async operation => {
    const f = await fixture();
    expect((await f.app.appointments.rescheduleAppointment({ ...f.scope, expectedVersion: f.booked.version, startAt: nextStart })).ok).toBe(true);
    const cancel = vi.spyOn(f.calendar, "cancelEvent"), move = vi.spyOn(f.calendar, "rescheduleEvent");
    const command = { ...f.scope, expectedVersion: f.booked.version };
    const result = operation === "cancel" ? await f.app.appointments.cancelAppointment(command)
      : operation === "outcome" ? await f.app.appointments.markAppointmentOutcome({ ...command, outcome: "NO_SHOW" })
      : await f.app.appointments.rescheduleAppointment({ ...command, startAt: "2026-08-12T16:00:00Z" });
    expect(result).toEqual({ ok: false, error: { code: "APPOINTMENT_VERSION_CONFLICT" } });
    expect(cancel).not.toHaveBeenCalled(); expect(move).not.toHaveBeenCalled();
    expect((await f.repository.listEvents(f.scope.tenantId, f.scope.appointmentId)).map(item => item.type)).toEqual(["CREATED", "RESCHEDULED"]);
  });

  it("rejects the second concurrent edit of the same version without a second Calendar write", async () => {
    const f = await fixture(); const held = f.holdMove();
    const command = { ...f.scope, expectedVersion: f.booked.version };
    const first = f.app.appointments.rescheduleAppointment({ ...command, startAt: nextStart }); await held.entered;
    const second = f.app.appointments.rescheduleAppointment({ ...command, startAt: "2026-08-12T16:00:00Z" });
    await tick(); held.release(); expect((await first).ok).toBe(true);
    expect(await second).toEqual({ ok: false, error: { code: "APPOINTMENT_VERSION_CONFLICT" } });
    expect(f.calendar.rescheduleEvent).toHaveBeenCalledOnce();
  });

  it("rechecks cancelled status after waiting for a cancellation to finish", async () => {
    const f = await fixture(); const entered = deferred(), release = deferred();
    const original = f.calendar.cancelEvent.bind(f.calendar);
    vi.spyOn(f.calendar, "cancelEvent").mockImplementationOnce(async command => { const result = await original(command); entered.resolve(); await release.promise; return result; });
    const move = vi.spyOn(f.calendar, "rescheduleEvent");
    const cancelled = f.app.appointments.cancelAppointment(f.scope); await entered.promise;
    const moving = f.app.appointments.rescheduleAppointment({ ...f.scope, startAt: nextStart });
    await tick(); release.resolve(); expect((await cancelled).ok).toBe(true);
    expect(await moving).toEqual({ ok: false, error: { code: "APPOINTMENT_NOT_CONFIRMED" } }); expect(move).not.toHaveBeenCalled();
  });

  it.each(["cancel", "reschedule"] as const)("keeps the row/revision unchanged on a rejected Calendar %s and releases the guard", async operation => {
    const f = await fixture();
    const method = operation === "cancel" ? "cancelEvent" : "rescheduleEvent";
    vi.spyOn(f.app.calendar, method).mockResolvedValueOnce({ ok: false, error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
    const command = { ...f.scope, expectedVersion: f.booked.version };
    const run = () => operation === "cancel" ? f.app.appointments.cancelAppointment(command)
      : f.app.appointments.rescheduleAppointment({ ...command, startAt: nextStart });
    expect(await run()).toEqual({ ok: false, error: { code: "CALENDAR_SYNC_FAILED", retryable: true } });
    expect(await f.repository.findById(f.scope.tenantId, f.scope.appointmentId)).toEqual(f.booked);
    expect(await f.repository.listEvents(f.scope.tenantId, f.scope.appointmentId)).toHaveLength(1);
    expect((await run()).ok).toBe(true);
  });
});

describe("RISK-001 voice references", () => {
  it("rejects a stale spoken appointment reference, then accepts explicit relisting and repeated changes", async () => {
    const f = await fixture(); const context = { tenantId: f.scope.tenantId, locationId: f.scope.locationId,
      callId: "concurrent-voice", customerId: f.booked.customerId, turnSequence: 1 };
    const prepared = await f.app.agents.prepare(context); if (!prepared.ok) throw new Error("agent");
    let sequence = 0;
    const execute = (name: "list_customer_appointments" | "reschedule_appointment" | "cancel_appointment", args = {}) =>
      prepared.value.toolExecutor.execute(context, { toolCallId: `edit-${++sequence}`, name, arguments: args });
    expect(await execute("list_customer_appointments")).toMatchObject({ ok: true });
    expect((await f.app.appointments.rescheduleAppointment({ ...f.scope, startAt: nextStart })).ok).toBe(true);
    const cancel = vi.spyOn(f.calendar, "cancelEvent");
    const rejected = await execute("cancel_appointment", { appointmentReference: "upcoming-1" });
    expect(rejected).toMatchObject({ ok: false, error: { code: "APPOINTMENT_VERSION_CONFLICT", retryable: false } });
    expect(JSON.stringify(rejected)).toContain("List upcoming appointments again"); expect(cancel).not.toHaveBeenCalled();
    expect(await execute("list_customer_appointments")).toMatchObject({ ok: true });
    for (const day of ["12", "13"]) {
      expect(await execute("reschedule_appointment", { appointmentReference: "upcoming-1", startAt: `2026-08-${day}T16:00:00Z` })).toMatchObject({ ok: true, data: { rescheduled: true } });
    }
    expect(await execute("cancel_appointment", { appointmentReference: "upcoming-1" })).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await f.repository.findById(f.scope.tenantId, f.scope.appointmentId)).toMatchObject({ status: "CANCELLED", externalCalendarEventId: f.booked.externalCalendarEventId });
  });
});
