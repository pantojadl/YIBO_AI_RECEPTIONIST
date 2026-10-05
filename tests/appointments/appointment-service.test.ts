import { afterEach, describe, expect, it } from "vitest";
import { markCallEnded, resetCallLiveness } from "../../src/modules/calls/index.js";
import { failure, success } from "../../src/shared/domain/result.js";
import {
  BusinessDirectoryService,
  InMemoryBusinessRepository,
  upgradeBusinessProfile,
  type BusinessProfile,
  type VersionedBusinessProfile,
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
  services: [{
    id: "service-1",
    name: "Consultation",
    durationMinutes: 30,
    bufferMinutes: 0,
    eligibleEmployeeIds: ["employee-1"],
  }],
  employees: [{ id: "employee-1", displayName: "Ana", active: true }],
  openingHours: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
};

const customers: CustomerReader = {
  exists: async (tenantId, customerId) => tenantId === "tenant-a" && customerId === "customer-1",
  get: async (tenantId, customerId) => tenantId === "tenant-a" && customerId === "customer-1"
    ? { name: "John Smith", phone: "9155551234" }
    : null,
};

const scheduling = (validate: SchedulingService["validateSlot"] = async (query) => success({
  employeeId: query.employeeId,
  startAt: new Date(query.startAt).toISOString(),
  endAt: new Date(new Date(query.startAt).valueOf() + 30 * 60_000).toISOString(),
  validatedAt: "2026-08-09T12:00:00.000Z",
})): SchedulingService => ({
  findAvailableSlots: async () => success([]),
  validateSlot: validate,
});

const command = {
  tenantId: "tenant-a",
  locationId: "default",
  customerId: "customer-1",
  serviceId: "service-1",
  employeeId: "employee-1",
  startAt: "2026-08-10T15:00:00.000Z",
  idempotencyKey: "request-1",
  source: "AI_CALL" as const,
  sourceCallId: "call-1",
};

function fixture(options: { scheduling?: SchedulingService; business?: VersionedBusinessProfile } = {}) {
  const repository = new InMemoryAppointmentRepository();
  const calendar = new InMemoryAppointmentCalendar();
  const businessRepository = new InMemoryBusinessRepository([options.business ?? business]);
  let nextId = 1;
  const service = new AppointmentServiceImpl(
    repository,
    customers,
    new BusinessDirectoryService(businessRepository),
    options.scheduling ?? scheduling(),
    calendar,
    new InMemoryAppointmentConcurrencyGuard(),
    () => `appointment-${nextId++}`,
    { now: () => new Date("2026-08-01T00:00:00.000Z") },
  );
  return { businessRepository, calendar, repository, service };
}

describe("AppointmentServiceImpl", () => {
  afterEach(() => resetCallLiveness());
  it("revalidates the slot and confirms only after the external event succeeds", async () => {
    const { service } = fixture();

    const result = await service.createAppointment(command);

    expect(result).toEqual({ ok: true, value: {
      id: "appointment-1",
      ...command,
      version: 2,
      serviceNameSnapshot: "Consultation",
      priceAmountMinor: 0,
      priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z",
      endAt: "2026-08-10T15:30:00.000Z",
      status: "CONFIRMED",
      externalCalendarEventId: "event-1",
    } });
  });

  it("returns the previous result for a semantically identical idempotent retry", async () => {
    const { calendar, service } = fixture();
    const first = await service.createAppointment(command);
    const retry = await service.createAppointment(command);

    expect(first.ok).toBe(true);
    expect(retry).toEqual(first);
    expect(calendar.eventCount()).toBe(1);
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const { service } = fixture();
    await service.createAppointment(command);

    await expect(service.createAppointment({
      ...command,
      startAt: "2026-08-10T16:00:00.000Z",
    })).resolves.toEqual({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("marks the local appointment failed when calendar creation fails", async () => {
    const { calendar, service } = fixture();
    calendar.failNext({ code: "PROVIDER_UNAVAILABLE", retryable: true });

    const result = await service.createAppointment(command);
    const stored = await service.getAppointment({ tenantId: "tenant-a", locationId: "default", appointmentId: "appointment-1" });

    expect(result).toEqual({ ok: false, error: { code: "CALENDAR_SYNC_FAILED", retryable: true } });
    expect(stored.ok && stored.value.status).toBe("FAILED");
  });

  it("never returns an appointment through another tenant", async () => {
    const { service } = fixture();
    await service.createAppointment(command);

    await expect(service.getAppointment({
      tenantId: "tenant-b",
      locationId: "default",
      appointmentId: "appointment-1",
    })).resolves.toEqual({ ok: false, error: { code: "APPOINTMENT_NOT_FOUND" } });
  });

  it("freezes service name and price independently from later catalog changes", async () => {
    const priced = upgradeBusinessProfile(business);
    priced.locations[0]!.services[0]!.price = { amountMinor: 85000, currency: "MXN" };
    const { businessRepository, service } = fixture({ business: priced });

    const created = await service.createAppointment(command);
    expect(created).toMatchObject({
      ok: true,
      value: { serviceNameSnapshot: "Consultation", priceAmountMinor: 85000, priceCurrency: "MXN" },
    });

    priced.services[0]!.name = "Renamed later";
    priced.locations[0]!.services[0]!.price = { amountMinor: 99000, currency: "MXN" };
    await businessRepository.save(priced);
    await expect(service.getAppointment({
      tenantId: command.tenantId, locationId: command.locationId, appointmentId: "appointment-1",
    })).resolves.toMatchObject({
      ok: true,
      value: { serviceNameSnapshot: "Consultation", priceAmountMinor: 85000, priceCurrency: "MXN" },
    });
  });

  it("never returns an appointment through another location", async () => {
    const { service } = fixture();
    await service.createAppointment(command);

    await expect(service.getAppointment({
      tenantId: "tenant-a",
      locationId: "other-location",
      appointmentId: "appointment-1",
    })).resolves.toEqual({ ok: false, error: { code: "APPOINTMENT_NOT_FOUND" } });
  });

  it("lists only confirmed upcoming appointments in the trusted tenant, customer, and location", async () => {
    const { repository, service } = fixture();
    const created = await service.createAppointment(command);
    if (!created.ok) throw new Error("fixture appointment was not created");
    await repository.save({
      ...created.value, id: "appointment-earlier", idempotencyKey: "earlier",
      startAt: "2026-08-05T15:00:00.000Z", endAt: "2026-08-05T15:30:00.000Z",
    });
    await repository.save({
      ...created.value, id: "appointment-other-customer", idempotencyKey: "other-customer",
      customerId: "customer-2",
    });
    await repository.save({
      ...created.value, id: "appointment-other-location", idempotencyKey: "other-location",
      locationId: "other-location",
    });
    await repository.save({
      ...created.value, id: "appointment-cancelled", idempotencyKey: "cancelled", status: "CANCELLED",
    });
    await repository.save({
      ...created.value, id: "appointment-past", idempotencyKey: "past",
      startAt: "2026-07-31T15:00:00.000Z", endAt: "2026-07-31T15:30:00.000Z",
    });

    await expect(service.listUpcomingAppointments({
      tenantId: "tenant-a", locationId: "default", customerId: "customer-1",
    })).resolves.toMatchObject([
      { id: "appointment-earlier", startAt: "2026-08-05T15:00:00.000Z" },
      { id: "appointment-1", startAt: "2026-08-10T15:00:00.000Z" },
    ]);
  });

  it("serializes concurrent attempts so only one can claim a slot", async () => {
    let validations = 0;
    let activeValidations = 0;
    let maximumConcurrency = 0;
    const guardedScheduling = scheduling(async (query) => {
      activeValidations += 1;
      maximumConcurrency = Math.max(maximumConcurrency, activeValidations);
      await Promise.resolve();
      activeValidations -= 1;
      validations += 1;
      if (validations > 1) return failure({ code: "SLOT_CONFLICT" as const });
      return success({
        employeeId: query.employeeId,
        startAt: query.startAt,
        endAt: "2026-08-10T15:30:00.000Z",
        validatedAt: "2026-08-09T12:00:00.000Z",
      });
    });
    const { service } = fixture({ scheduling: guardedScheduling });

    const results = await Promise.all([
      service.createAppointment(command),
      service.createAppointment({ ...command, customerId: "customer-1", idempotencyKey: "request-2" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "SLOT_NO_LONGER_AVAILABLE" } },
    ]);
    expect(maximumConcurrency).toBe(1);
  });

  it("cancels the external event before marking an appointment cancelled", async () => {
    const { service } = fixture();
    await service.createAppointment(command);

    const cancelled = await service.cancelAppointment({
      tenantId: "tenant-a",
      locationId: "default",
      appointmentId: "appointment-1",
    });

    expect(cancelled.ok && cancelled.value.status).toBe("CANCELLED");
  });

  it("preserves the external event and persists the validated rescheduled slot", async () => {
    const { service } = fixture();
    await service.createAppointment(command);

    const rescheduled = await service.rescheduleAppointment({
      tenantId: "tenant-a",
      locationId: "default",
      appointmentId: "appointment-1",
      startAt: "2026-08-10T16:00:00.000Z",
    });

    expect(rescheduled).toMatchObject({ ok: true, value: {
      id: "appointment-1",
      startAt: "2026-08-10T16:00:00.000Z",
      endAt: "2026-08-10T16:30:00.000Z",
      status: "CONFIRMED",
      externalCalendarEventId: "event-1",
    } });
  });

  it("enforces location notice before cancellation and rescheduling", async () => {
    const restricted = upgradeBusinessProfile(business);
    restricted.locations[0]!.policies.minimumCancellationNoticeMinutes = 14 * 24 * 60;
    restricted.locations[0]!.policies.minimumRescheduleNoticeMinutes = 14 * 24 * 60;
    const { service } = fixture({ business: restricted });
    await service.createAppointment(command);

    await expect(service.cancelAppointment({
      tenantId: command.tenantId, locationId: command.locationId, appointmentId: "appointment-1",
    })).resolves.toEqual({ ok: false, error: { code: "CANCELLATION_NOTICE_NOT_MET" } });
    await expect(service.rescheduleAppointment({
      tenantId: command.tenantId, locationId: command.locationId,
      appointmentId: "appointment-1", startAt: "2026-08-10T16:00:00.000Z",
    })).resolves.toEqual({ ok: false, error: { code: "RESCHEDULE_NOTICE_NOT_MET" } });
  });

  it("does not confirm when the database rejects the confirmed write", async () => {
    const { calendar, repository, service } = fixture();
    const original = repository.save.bind(repository);
    repository.save = async (appointment) => {
      if (appointment.status === "CONFIRMED") throw new Error("disk full");
      await original(appointment);
    };

    const result = await service.createAppointment(command);

    expect(result).toEqual({ ok: false, error: { code: "CALENDAR_SYNC_FAILED", retryable: false } });
    expect(calendar.eventCount()).toBe(0);
    expect(await repository.findById("tenant-a", "appointment-1")).toMatchObject({
      status: "FAILED",
      externalCalendarEventId: undefined,
    });
  });

  it("keeps the pending row and calendar event when compensation cannot delete the event", async () => {
    const { calendar, repository, service } = fixture();
    const original = repository.save.bind(repository);
    repository.save = async (appointment) => {
      if (appointment.status === "CONFIRMED") throw new Error("disk full");
      await original(appointment);
    };
    calendar.cancelEvent = async () => failure({ code: "PROVIDER_UNAVAILABLE", retryable: true });

    const result = await service.createAppointment(command);

    expect(result).toEqual({ ok: false, error: { code: "CALENDAR_SYNC_FAILED", retryable: true } });
    expect(calendar.eventCount()).toBe(1);
    expect(await repository.findById("tenant-a", "appointment-1")).toMatchObject({
      status: "PENDING_CONFIRMATION",
      externalCalendarEventId: "event-1",
    });
  });

  it("does not book a disabled professional or an inactive location assignment", async () => {
    const inactiveProfessional = upgradeBusinessProfile(structuredClone(business));
    inactiveProfessional.professionals[0]!.active = false;
    inactiveProfessional.locations[0]!.professionals[0]!.active = false;
    const inactiveAssignment = upgradeBusinessProfile(structuredClone(business));
    inactiveAssignment.locations[0]!.professionals[0]!.active = false;
    for (const profile of [inactiveProfessional, inactiveAssignment]) {
      const { calendar, service } = fixture({ business: profile });
      await expect(service.createAppointment(command)).resolves.toEqual({ ok: false, error: { code: "EMPLOYEE_NOT_FOUND" } });
      expect(calendar.eventCount()).toBe(0);
    }
  });

  it("does not book when the caller hangs up during calendar creation", async () => {
    const { calendar, repository, service } = fixture();
    const original = calendar.createEvent.bind(calendar);
    calendar.createEvent = async (input) => {
      markCallEnded("call-1");
      return original(input);
    };

    const result = await service.createAppointment(command);

    expect(result).toEqual({ ok: false, error: { code: "CALL_ENDED" } });
    expect(calendar.eventCount()).toBe(0);
    expect(await repository.findById("tenant-a", "appointment-1")).toMatchObject({
      status: "FAILED",
      externalCalendarEventId: undefined,
    });
  });

  it("does not book a voice appointment after the call has already ended", async () => {
    const { calendar, repository, service } = fixture();
    markCallEnded("call-1");

    const result = await service.createAppointment(command);

    expect(result).toEqual({ ok: false, error: { code: "CALL_ENDED" } });
    expect(calendar.eventCount()).toBe(0);
    expect(await repository.findById("tenant-a", "appointment-1")).toBeNull();
  });

  it("treats a pending confirmation as occupying the staff slot", async () => {
    const { repository } = fixture();
    await repository.save({
      id: "pending-1", tenantId: "tenant-a", locationId: "default", customerId: "customer-1",
      serviceId: "service-1", employeeId: "employee-1", serviceNameSnapshot: "Consultation",
      priceAmountMinor: 0, priceCurrency: "MXN", startAt: "2026-08-10T15:00:00.000Z",
      endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION", idempotencyKey: "pending",
      source: "DASHBOARD", version: 1,
    });

    await expect(repository.findConfirmedIntervals({
      tenantId: "tenant-a", locationId: "default", employeeId: "employee-1",
      rangeStart: "2026-08-10T15:00:00.000Z", rangeEnd: "2026-08-10T15:30:00.000Z",
    })).resolves.toEqual([{ startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z" }]);
  });

  it("releases pending bookings that have no calendar event and holds those that do", async () => {
    const { repository, service } = fixture();
    const base = {
      tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION" as const,
      source: "DASHBOARD" as const, version: 1,
    };
    await repository.save({ ...base, id: "plain", idempotencyKey: "plain" });
    await repository.save({ ...base, id: "linked", idempotencyKey: "linked", externalCalendarEventId: "event-kept", startAt: "2026-08-10T16:00:00.000Z" });

    await expect(service.reconcileUnconfirmedBookings("tenant-a")).resolves.toEqual({ released: ["plain"], held: ["linked"] });
    expect(await repository.findById("tenant-a", "plain")).toMatchObject({ status: "FAILED" });
    expect(await repository.findById("tenant-a", "linked")).toMatchObject({ status: "PENDING_CONFIRMATION", externalCalendarEventId: "event-kept" });
  });

  it("serializes different professionals competing for the same location capacity", async () => {
    const guard = new InMemoryAppointmentConcurrencyGuard();
    let active = 0;
    let maximum = 0;
    const operation = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
    };
    await Promise.all([
      guard.execute("tenant-a", "default", "employee-1", operation),
      guard.execute("tenant-a", "default", "employee-2", operation),
    ]);
    expect(maximum).toBe(1);
  });
});
