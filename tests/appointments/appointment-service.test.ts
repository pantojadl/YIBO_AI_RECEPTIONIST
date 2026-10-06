import { afterEach, describe, expect, it, vi } from "vitest";
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
  type AppointmentConcurrencyGuard,
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

function fixture(options: {
  scheduling?: SchedulingService;
  business?: VersionedBusinessProfile;
  guard?: AppointmentConcurrencyGuard;
} = {}) {
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
    options.guard ?? new InMemoryAppointmentConcurrencyGuard(),
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
      updatedAt: "2026-08-01T00:00:00.000Z",
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
      idempotencyKey: "cancel-1",
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
      idempotencyKey: "move-1",
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
      idempotencyKey: "cancel-notice",
    })).resolves.toEqual({ ok: false, error: { code: "CANCELLATION_NOTICE_NOT_MET" } });
    await expect(service.rescheduleAppointment({
      tenantId: command.tenantId, locationId: command.locationId,
      appointmentId: "appointment-1", startAt: "2026-08-10T16:00:00.000Z",
      idempotencyKey: "move-notice",
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

  it("confirms a pending booking whose calendar event exists and releases one whose event is gone", async () => {
    const { calendar, repository, service } = fixture();
    const base = {
      tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION" as const,
      source: "DASHBOARD" as const, version: 1,
    };
    await repository.save({ ...base, id: "plain", idempotencyKey: "plain" });
    const created = await calendar.createEvent({
      tenantId: "tenant-a", locationId: "default", appointmentId: "linked", employeeId: "employee-1",
      title: "Consultation", serviceName: "Consultation", startAt: base.startAt, endAt: base.endAt, idempotencyKey: "linked",
    });
    if (!created.ok) throw new Error("event");
    await repository.save({
      ...base, id: "linked", idempotencyKey: "linked", externalCalendarEventId: created.value.externalEventId,
      startAt: "2026-08-10T16:00:00.000Z",
    });
    await repository.save({ ...base, id: "missing", idempotencyKey: "missing", externalCalendarEventId: "gone", startAt: "2026-08-10T17:00:00.000Z" });

    const result = await service.reconcileUnconfirmedBookings("tenant-a");

    expect(result.confirmed).toEqual(["linked"]);
    expect(result.released.sort()).toEqual(["missing", "plain"]);
    expect(result.held).toEqual([]);
    expect(await repository.findById("tenant-a", "plain")).toMatchObject({ status: "FAILED" });
    expect(await repository.findById("tenant-a", "missing")).toMatchObject({ status: "FAILED", externalCalendarEventId: undefined });
    expect(await repository.findById("tenant-a", "linked")).toMatchObject({
      status: "CONFIRMED", externalCalendarEventId: created.value.externalEventId,
    });
    expect(calendar.eventCount()).toBe(1);
  });

  it("retries a failed calendar cancel and then releases the slot", async () => {
    const { calendar, repository, service } = fixture();
    const created = await calendar.createEvent({
      tenantId: "tenant-a", locationId: "default", appointmentId: "stuck", employeeId: "employee-1",
      title: "Consultation", serviceName: "Consultation",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", idempotencyKey: "stuck",
    });
    if (!created.ok) throw new Error("event");
    await repository.save({
      id: "stuck", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION",
      idempotencyKey: "stuck", source: "AI_CALL", version: 2, externalCalendarEventId: created.value.externalEventId,
      compensationRequired: true,
    });

    await expect(service.recoverStuckBookings("tenant-a")).resolves.toMatchObject({ released: ["stuck"], confirmed: [], held: [] });
    expect(await repository.findById("tenant-a", "stuck")).toMatchObject({ status: "FAILED", externalCalendarEventId: undefined });
    expect(calendar.eventCount()).toBe(0);
  });

  it("does not let a slow recovery overwrite a cancellation that finished first", async () => {
    const { calendar, repository, service } = fixture();
    const created = await calendar.createEvent({
      tenantId: "tenant-a", locationId: "default", appointmentId: "racy", employeeId: "employee-1",
      title: "Consultation", serviceName: "Consultation",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", idempotencyKey: "racy",
    });
    if (!created.ok) throw new Error("event");
    await repository.save({
      id: "racy", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION",
      idempotencyKey: "racy", source: "AI_CALL", version: 2, externalCalendarEventId: created.value.externalEventId,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    let releaseInspect: () => void = () => undefined;
    const inspecting = new Promise<void>((resolve) => { releaseInspect = resolve; });
    let sawInspect = false;
    const originalInspect = calendar.inspectEvent.bind(calendar);
    calendar.inspectEvent = async (command) => {
      const seen = await originalInspect(command);
      sawInspect = true;
      await inspecting;
      return seen;
    };
    const recovery = service.reconcileUnconfirmedBookings("tenant-a");
    for (let attempt = 0; attempt < 20 && !sawInspect; attempt += 1) await Promise.resolve();
    expect(sawInspect).toBe(true);
    await calendar.cancelEvent({
      tenantId: "tenant-a", locationId: "default", appointmentId: "racy", employeeId: "employee-1",
      externalEventId: created.value.externalEventId,
    });
    await repository.save({
      id: "racy", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "CANCELLED",
      idempotencyKey: "racy", source: "AI_CALL", version: 3, externalCalendarEventId: created.value.externalEventId,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    releaseInspect();
    await recovery;
    expect(await repository.findById("tenant-a", "racy")).toMatchObject({ status: "CANCELLED", version: 3 });
    expect(calendar.eventCount()).toBe(0);
  });

  it("does not let a slow recovery overwrite a reschedule that finished first", async () => {
    const { calendar, repository, service } = fixture();
    const created = await calendar.createEvent({
      tenantId: "tenant-a", locationId: "default", appointmentId: "moved", employeeId: "employee-1",
      title: "Consultation", serviceName: "Consultation",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", idempotencyKey: "moved",
    });
    if (!created.ok) throw new Error("event");
    await repository.save({
      id: "moved", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION",
      idempotencyKey: "moved", source: "AI_CALL", version: 2, externalCalendarEventId: created.value.externalEventId,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    let releaseInspect: () => void = () => undefined;
    const inspecting = new Promise<void>((resolve) => { releaseInspect = resolve; });
    let sawInspect = false;
    const originalInspect = calendar.inspectEvent.bind(calendar);
    calendar.inspectEvent = async (command) => {
      const seen = await originalInspect(command);
      sawInspect = true;
      await inspecting;
      return seen;
    };
    const recovery = service.reconcileUnconfirmedBookings("tenant-a");
    for (let attempt = 0; attempt < 20 && !sawInspect; attempt += 1) await Promise.resolve();
    expect(sawInspect).toBe(true);
    await repository.save({
      id: "moved", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T18:00:00.000Z", endAt: "2026-08-10T18:30:00.000Z", status: "CONFIRMED",
      idempotencyKey: "moved", source: "AI_CALL", version: 5, externalCalendarEventId: created.value.externalEventId,
      outcomeStatus: "COMPLETED", updatedAt: "2026-08-01T00:00:00.000Z",
    });
    releaseInspect();
    await recovery;
    expect(await repository.findById("tenant-a", "moved")).toMatchObject({
      status: "CONFIRMED", version: 5, startAt: "2026-08-10T18:00:00.000Z", outcomeStatus: "COMPLETED",
    });
    expect(calendar.eventCount()).toBe(1);
  });

  it("does not confirm or fail a booking when calendar delete times out", async () => {
    const { calendar, repository, service } = fixture();
    const created = await calendar.createEvent({
      tenantId: "tenant-a", locationId: "default", appointmentId: "timeout", employeeId: "employee-1",
      title: "Consultation", serviceName: "Consultation",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", idempotencyKey: "timeout",
    });
    if (!created.ok) throw new Error("event");
    calendar.cancelEvent = async () => { throw new Error("timeout"); };
    await repository.save({
      id: "timeout", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION",
      idempotencyKey: "timeout", source: "DASHBOARD", version: 2, externalCalendarEventId: created.value.externalEventId,
      compensationRequired: true, updatedAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(service.reconcileUnconfirmedBookings("tenant-a")).resolves.toMatchObject({ confirmed: [], released: [], held: ["timeout"] });
    expect(await repository.findById("tenant-a", "timeout")).toMatchObject({
      status: "PENDING_CONFIRMATION", compensationRequired: true,
    });
    expect(calendar.eventCount()).toBe(1);
  });

  it("runs one stuck-booking scan at a time", async () => {
    const { calendar, repository, service } = fixture();
    await repository.save({
      id: "scan", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION",
      idempotencyKey: "scan", source: "DASHBOARD", version: 1, updatedAt: "2020-01-01T00:00:00.000Z",
    });
    let active = 0;
    let maximum = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    calendar.inspectEvent = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return success({ present: false });
    };
    const first = service.recoverStuckBookings("tenant-a");
    const second = service.recoverStuckBookings("tenant-a");
    for (let attempt = 0; attempt < 20 && maximum < 1; attempt += 1) await Promise.resolve();
    expect(maximum).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
  });

  it("keeps a failed hangup cleanup pending instead of confirming the booking", async () => {
    const { calendar, repository, service } = fixture();
    const created = await calendar.createEvent({
      tenantId: "tenant-a", locationId: "default", appointmentId: "kept", employeeId: "employee-1",
      title: "Consultation", serviceName: "Consultation",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", idempotencyKey: "kept",
    });
    if (!created.ok) throw new Error("event");
    calendar.cancelEvent = async () => failure({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    await repository.save({
      id: "kept", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION",
      idempotencyKey: "kept", source: "DASHBOARD", version: 2, externalCalendarEventId: created.value.externalEventId,
      compensationRequired: true,
    });

    await expect(service.reconcileUnconfirmedBookings("tenant-a")).resolves.toMatchObject({ confirmed: [], released: [], held: ["kept"] });
    expect(await repository.findById("tenant-a", "kept")).toMatchObject({
      status: "PENDING_CONFIRMATION", compensationRequired: true, externalCalendarEventId: created.value.externalEventId,
    });
    await expect(service.reconcileUnconfirmedBookings("tenant-a")).resolves.toMatchObject({ confirmed: [], released: [], held: ["kept"] });
    expect(calendar.eventCount()).toBe(1);
  });

  it("holds a pending booking when the calendar cannot be checked", async () => {
    const { calendar, repository, service } = fixture();
    calendar.inspectEvent = async () => failure({ code: "PROVIDER_UNAVAILABLE" as const, retryable: true });
    await repository.save({
      id: "unknown", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION",
      idempotencyKey: "unknown", source: "DASHBOARD", version: 1,
    });

    await expect(service.reconcileUnconfirmedBookings("tenant-a")).resolves.toEqual({ released: [], confirmed: [], held: ["unknown"] });
    expect(await repository.findById("tenant-a", "unknown")).toMatchObject({ status: "PENDING_CONFIRMATION" });
  });

  it("leaves a fresh in-flight pending row alone and does not delete a lock by age", async () => {
    const claims = [{ tenantId: "tenant-a", locationId: "default", ownerId: "crashed", acquiredAt: "2020-01-01T00:00:00.000Z" }];
    const guard = {
      execute: async <T>(_tenantId: string, _locationId: string, _employeeId: string, operation: () => Promise<T>) => operation(),
      listClaims: () => claims.map((claim) => ({ ...claim })),
      heartbeat: () => false,
      ownsFence: () => true,
      hasLiveLease: () => false,
      hasUnresolvedSteal: () => false,
      clearSteal: () => undefined,
      releaseClaim: () => false,
    };
    const { repository, service } = fixture({ guard });
    await repository.save({
      id: "fresh", tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
      employeeId: "employee-1", serviceNameSnapshot: "Consultation", priceAmountMinor: 0, priceCurrency: "MXN",
      startAt: "2026-08-10T15:00:00.000Z", endAt: "2026-08-10T15:30:00.000Z", status: "PENDING_CONFIRMATION",
      idempotencyKey: "fresh", source: "AI_CALL", version: 1, updatedAt: "2026-08-01T00:00:00.000Z",
    });

    await expect(service.recoverStuckBookings("tenant-a")).resolves.toMatchObject({
      released: [], confirmed: [], held: [], releasedLocks: [],
    });
    expect(await repository.findById("tenant-a", "fresh")).toMatchObject({ status: "PENDING_CONFIRMATION" });
    expect(claims).toHaveLength(1);
  });

  it("replays a cancel or reschedule with the same key and rejects a different change", async () => {
    const { calendar, service } = fixture();
    await service.createAppointment(command);
    const cancel = vi.spyOn(calendar, "cancelEvent");
    const scope = { tenantId: "tenant-a", locationId: "default", appointmentId: "appointment-1", idempotencyKey: "cancel-replay" };
    const first = await service.cancelAppointment(scope);
    const second = await service.cancelAppointment(scope);
    expect(first.ok && second.ok && first.value.id).toBe("appointment-1");
    expect(second).toEqual(first);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(service.cancelAppointment({ ...scope, appointmentId: "appointment-1", idempotencyKey: "cancel-replay" })).resolves.toEqual(first);

    const { calendar: moveCalendar, service: moveService } = fixture();
    await moveService.createAppointment(command);
    const move = vi.spyOn(moveCalendar, "rescheduleEvent");
    const moved = await moveService.rescheduleAppointment({
      tenantId: "tenant-a", locationId: "default", appointmentId: "appointment-1",
      startAt: "2026-08-10T16:00:00.000Z", idempotencyKey: "move-replay",
    });
    const replayed = await moveService.rescheduleAppointment({
      tenantId: "tenant-a", locationId: "default", appointmentId: "appointment-1",
      startAt: "2026-08-10T16:00:00.000Z", idempotencyKey: "move-replay",
    });
    expect(replayed).toEqual(moved);
    expect(move).toHaveBeenCalledOnce();
    await expect(moveService.rescheduleAppointment({
      tenantId: "tenant-a", locationId: "default", appointmentId: "appointment-1",
      startAt: "2026-08-10T17:00:00.000Z", idempotencyKey: "move-replay",
    })).resolves.toEqual({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(move).toHaveBeenCalledOnce();
    await expect(service.cancelAppointment({
      tenantId: "tenant-a", locationId: "default", appointmentId: "appointment-1", idempotencyKey: " ",
    })).resolves.toEqual({ ok: false, error: { code: "VALIDATION_ERROR", message: "An idempotency key is required" } });
  });

  it("retries cancel and reschedule after the receipt write fails without a second provider call", async () => {
    const { calendar, repository, service } = fixture();
    const created = await service.createAppointment(command);
    if (!created.ok) throw new Error("create");
    const cancel = vi.spyOn(calendar, "cancelEvent");
    const originalCommit = repository.commitChange.bind(repository);
    let failures = 0;
    repository.commitChange = async (change) => {
      failures += 1;
      if (failures === 1) throw new Error("receipt io");
      return originalCommit(change);
    };
    const cancelCommand = {
      tenantId: "tenant-a", locationId: "default", appointmentId: created.value.id,
      idempotencyKey: "cancel-gap", expectedVersion: created.value.version,
    };
    await expect(service.cancelAppointment(cancelCommand)).resolves.toEqual({
      ok: false, error: { code: "CALENDAR_SYNC_FAILED", retryable: true },
    });
    expect(await repository.findById("tenant-a", created.value.id)).toMatchObject({
      status: "CONFIRMED", operationIntent: "OUTCOME_UNKNOWN",
    });
    expect(await repository.findMutation("tenant-a", "cancel-gap")).toBeNull();
    const cancelled = await service.cancelAppointment(cancelCommand);
    expect(cancelled).toMatchObject({ ok: true, value: { status: "CANCELLED", id: created.value.id } });
    expect(cancel).toHaveBeenCalledOnce();
    await expect(service.cancelAppointment(cancelCommand)).resolves.toEqual(cancelled);
    expect(cancel).toHaveBeenCalledOnce();

    const { calendar: moveCalendar, repository: moveRepository, service: moveService } = fixture();
    const booked = await moveService.createAppointment(command);
    if (!booked.ok) throw new Error("create");
    const move = vi.spyOn(moveCalendar, "rescheduleEvent");
    const originalMove = moveRepository.commitChange.bind(moveRepository);
    let moveFailures = 0;
    moveRepository.commitChange = async (change) => {
      moveFailures += 1;
      if (moveFailures === 1) throw new Error("receipt io");
      return originalMove(change);
    };
    const moveCommand = {
      tenantId: "tenant-a", locationId: "default", appointmentId: booked.value.id,
      startAt: "2026-08-10T16:00:00.000Z", idempotencyKey: "move-gap", expectedVersion: booked.value.version,
    };
    await expect(moveService.rescheduleAppointment(moveCommand)).resolves.toEqual({
      ok: false, error: { code: "CALENDAR_SYNC_FAILED", retryable: true },
    });
    expect(await moveRepository.findById("tenant-a", booked.value.id)).toMatchObject({
      status: "CONFIRMED", startAt: booked.value.startAt, operationIntent: "OUTCOME_UNKNOWN",
    });
    expect(await moveRepository.findMutation("tenant-a", "move-gap")).toBeNull();
    const moved = await moveService.rescheduleAppointment(moveCommand);
    expect(moved).toMatchObject({ ok: true, value: { startAt: "2026-08-10T16:00:00.000Z" } });
    expect(move).toHaveBeenCalledOnce();
    await expect(moveService.rescheduleAppointment(moveCommand)).resolves.toEqual(moved);
    expect(move).toHaveBeenCalledOnce();
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
