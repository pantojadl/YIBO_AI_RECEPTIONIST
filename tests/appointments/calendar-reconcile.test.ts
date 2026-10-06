import { describe, expect, it, vi } from "vitest";
import { success } from "../../src/shared/domain/result.js";
import {
  BusinessDirectoryService,
  InMemoryBusinessRepository,
  type BusinessProfile,
} from "../../src/modules/business/index.js";
import type { SchedulingService } from "../../src/modules/scheduling/index.js";
import {
  AppointmentServiceImpl,
  InMemoryAppointmentCalendar,
  InMemoryAppointmentConcurrencyGuard,
  InMemoryAppointmentRepository,
  type CustomerReader,
} from "../../src/modules/appointments/index.js";

const business: BusinessProfile = {
  region: "MX",
  tenantId: "tenant-a",
  businessId: "business-a",
  name: "YIBO Test Business",
  timezone: "America/Mexico_City",
  locale: "es-MX",
  active: true,
  calledNumbers: ["+525555555555"],
  services: [{ id: "service-1", name: "Consultation", durationMinutes: 30, bufferMinutes: 0, eligibleEmployeeIds: ["employee-1"] }],
  employees: [{ id: "employee-1", displayName: "Ana", active: true }],
  openingHours: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
};

const customers: CustomerReader = {
  exists: async (tenantId, customerId) => tenantId === "tenant-a" && customerId === "customer-1",
  get: async () => ({ name: "John Smith", phone: "9155551234" }),
};

const scheduling: SchedulingService = {
  findAvailableSlots: async () => success([]),
  validateSlot: async (query) => success({
    employeeId: query.employeeId,
    startAt: new Date(query.startAt).toISOString(),
    endAt: new Date(new Date(query.startAt).valueOf() + 30 * 60_000).toISOString(),
    validatedAt: "2026-08-09T12:00:00.000Z",
  }),
};

class StealGuard extends InMemoryAppointmentConcurrencyGuard {
  private stolen = new Set<string>();
  arm(tenantId: string, locationId: string): void { this.stolen.add(`${tenantId}:${locationId}`); }
  override hasUnresolvedSteal(tenantId: string, locationId: string): boolean {
    return this.stolen.has(`${tenantId}:${locationId}`);
  }
  override clearSteal(tenantId: string, locationId: string): void {
    this.stolen.delete(`${tenantId}:${locationId}`);
  }
}

function fixture(guard = new InMemoryAppointmentConcurrencyGuard()) {
  const repository = new InMemoryAppointmentRepository();
  const calendar = new InMemoryAppointmentCalendar();
  let nextId = 0;
  const service = new AppointmentServiceImpl(
    repository, customers, new BusinessDirectoryService(new InMemoryBusinessRepository([business])),
    scheduling, calendar, guard, () => `appointment-${++nextId}`,
    { now: () => new Date("2026-08-01T00:00:00.000Z") },
  );
  return { repository, calendar, service, guard };
}

const command = {
  tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
  employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z", idempotencyKey: "book-1", source: "DASHBOARD" as const,
};

describe("open intent and calendar repair", () => {
  it("an open intent blocks a different idempotency key before Google", async () => {
    const { repository, calendar, service } = fixture();
    const created = await service.createAppointment(command);
    if (!created.ok) throw new Error("create");
    const stored = await repository.findById(command.tenantId, created.value.id);
    await repository.save({
      ...stored!, operationIntent: "RESCHEDULING", intentKey: "move-a", intentFingerprint: "reschedule:appointment-1:2026-08-11T16:00:00.000Z",
      intentEtag: "etag-1",
    });
    const move = vi.spyOn(calendar, "rescheduleEvent");
    await expect(service.rescheduleAppointment({
      tenantId: command.tenantId, locationId: command.locationId, appointmentId: created.value.id,
      startAt: "2026-08-12T16:00:00.000Z", idempotencyKey: "move-b",
    })).resolves.toEqual({ ok: false, error: { code: "APPOINTMENT_OPERATION_IN_PROGRESS" } });
    expect(move).not.toHaveBeenCalled();
    expect((await repository.findById(command.tenantId, created.value.id))?.intentKey).toBe("move-a");
  });

  it("repairs Google toward the committed row after a steal and skips a live heartbeat", async () => {
    const guard = new StealGuard();
    const { calendar, service } = fixture(guard);
    const created = await service.createAppointment(command);
    if (!created.ok || !created.value.externalCalendarEventId) throw new Error("create");
    const drifted = "2026-08-20T15:00:00.000Z";
    calendar.overwriteTimes(created.value.externalCalendarEventId, drifted, "2026-08-20T15:30:00.000Z");
    guard.arm(command.tenantId, command.locationId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let acquired: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = guard.execute(command.tenantId, command.locationId, command.employeeId, async () => {
      acquired();
      await gate;
    });
    await ready;
    await service.recoverStuckBookings(command.tenantId);
    expect(calendar.storedEvent(created.value.externalCalendarEventId)?.startAt).toBe(drifted);
    release();
    await held;
    await service.recoverStuckBookings(command.tenantId);
    const event = calendar.storedEvent(created.value.externalCalendarEventId);
    expect(event?.startAt).toBe(created.value.startAt);
    expect(event?.endAt).toBe(created.value.endAt);
    expect(guard.hasUnresolvedSteal(command.tenantId, command.locationId)).toBe(false);
  });

  it("repairs every drifted event before it clears the steal", async () => {
    const guard = new StealGuard();
    const { calendar, service } = fixture(guard);
    const earlier = await service.createAppointment(command);
    const later = await service.createAppointment({
      ...command, startAt: "2026-08-11T15:00:00.000Z", idempotencyKey: "book-2",
    });
    if (!earlier.ok || !later.ok || !earlier.value.externalCalendarEventId || !later.value.externalCalendarEventId) {
      throw new Error("create");
    }
    const drifted = "2026-08-20T15:00:00.000Z";
    calendar.overwriteTimes(earlier.value.externalCalendarEventId, drifted, "2026-08-20T15:30:00.000Z");
    guard.arm(command.tenantId, command.locationId);
    await service.recoverStuckBookings(command.tenantId);
    expect(calendar.storedEvent(earlier.value.externalCalendarEventId)?.startAt).toBe(earlier.value.startAt);
    expect(calendar.storedEvent(later.value.externalCalendarEventId)?.startAt).toBe(later.value.startAt);
    expect(guard.hasUnresolvedSteal(command.tenantId, command.locationId)).toBe(false);
  });
});
