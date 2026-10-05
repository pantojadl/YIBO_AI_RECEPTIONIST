import { isCallEnded } from "../../calls/application/call-liveness.js";
import { AppointmentOperationInProgressError } from "../ports/appointment-dependencies.js";
import { operationalLog } from "../../../shared/observability/operational-log.js";
import { failure, success, type Result } from "../../../shared/domain/result.js";
import type { Clock } from "../../../shared/application/system.js";
import type { AppointmentNotificationService } from "../../notifications/index.js";
import type { BusinessDirectory } from "../../business/index.js";
import type { SchedulingError, SchedulingService } from "../../scheduling/index.js";
import type { Appointment } from "../domain/appointment.js";
import type {
  AppointmentCalendarError,
  AppointmentCalendarPort,
  AppointmentConcurrencyGuard,
  CustomerReader,
} from "../ports/appointment-dependencies.js";
import type { AppointmentRepository } from "../ports/appointment-repository.js";
import type {
  AppointmentLookupError,
  AppointmentEditConflict,
  AppointmentCalendarQuery,
  AppointmentService,
  CancelAppointmentCommand,
  CancelAppointmentError,
  CreateAppointmentCommand,
  CreateAppointmentError,
  GetAppointmentQuery,
  ListUpcomingAppointmentsQuery,
  ListAppointmentsQuery,
  MarkAppointmentOutcomeCommand,
  RescheduleAppointmentCommand,
  RescheduleAppointmentError,
} from "./contracts.js";

export class AppointmentServiceImpl implements AppointmentService {
  constructor(
    private readonly repository: AppointmentRepository,
    private readonly customers: CustomerReader,
    private readonly businesses: BusinessDirectory,
    private readonly scheduling: SchedulingService,
    private readonly calendar: AppointmentCalendarPort,
    private readonly guard: AppointmentConcurrencyGuard,
    private readonly createId: () => string,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly notifications?: AppointmentNotificationService,
  ) {}

  async createAppointment(command: CreateAppointmentCommand) {
    const invalid = validateCreate(command);
    if (invalid) return failure<CreateAppointmentError>({ code: "VALIDATION_ERROR", message: invalid });

    const previous = await this.repository.findByIdempotencyKey(command.tenantId, command.idempotencyKey);
    if (previous) {
      return sameRequest(previous, command) && previous.status === "CONFIRMED"
        ? success(previous)
        : failure<CreateAppointmentError>({ code: "IDEMPOTENCY_CONFLICT" });
    }

    if (!await this.customers.exists(command.tenantId, command.customerId)) {
      return failure<CreateAppointmentError>({ code: "CUSTOMER_NOT_FOUND" });
    }
    const configuration = await this.businesses.getLocation(command.tenantId, command.locationId);
    if (!configuration.ok) return failure<CreateAppointmentError>({ code: "VALIDATION_ERROR", message: "Business is unavailable" });
    const offer = configuration.value.location.services.find((service) => service.serviceId === command.serviceId && service.active);
    if (!offer || !configuration.value.business.services.some((service) => service.id === command.serviceId && service.active)) {
      return failure<CreateAppointmentError>({ code: "SERVICE_NOT_FOUND" });
    }
    if (configuration.value.location.policies.sameDayBooking === false
      && localDay(command.startAt, configuration.value.location.timezone)
        === localDay(this.clock.now().toISOString(), configuration.value.location.timezone)) {
      return failure<CreateAppointmentError>({ code: "VALIDATION_ERROR", message: "Same-day booking is disabled" });
    }
    const assigned = configuration.value.location.professionals.some((professional) =>
      professional.professionalId === command.employeeId && professional.active && professional.serviceIds.includes(command.serviceId));
    if (!assigned || !configuration.value.business.professionals.some((employee) => employee.id === command.employeeId && employee.active)) {
      return failure<CreateAppointmentError>({ code: "EMPLOYEE_NOT_FOUND" });
    }
    const service = configuration.value.business.services.find((candidate) => candidate.id === command.serviceId)!;
    const customer = await this.customers.get(command.tenantId, command.customerId);

    return this.guarded(command, async () => {
      const raced = await this.repository.findByIdempotencyKey(command.tenantId, command.idempotencyKey);
      if (raced) {
        return sameRequest(raced, command) && raced.status === "CONFIRMED"
          ? success(raced)
          : failure<CreateAppointmentError>({ code: "IDEMPOTENCY_CONFLICT" });
      }

      const slot = await this.scheduling.validateSlot({
        tenantId: command.tenantId,
        locationId: command.locationId,
        serviceId: command.serviceId,
        employeeId: command.employeeId,
        startAt: command.startAt,
      });
      calendarLog("calendar.slot.recheck", { tenantId: command.tenantId, employeeId: command.employeeId, startAt: command.startAt, available: slot.ok });
      if (!slot.ok) return failure<CreateAppointmentError>(mapSchedulingError(slot.error));
      if (voiceCallEnded(command)) return failure<CreateAppointmentError>({ code: "CALL_ENDED" });

      const pending: Appointment = {
        id: this.createId(),
        ...command,
        version: 1,
        serviceNameSnapshot: service.name,
        priceAmountMinor: offer.price.amountMinor,
        priceCurrency: offer.price.currency,
        startAt: slot.value.startAt,
        endAt: slot.value.endAt,
        status: "PENDING_CONFIRMATION",
      };
      await this.repository.save(pending);

      calendarLog("calendar.trace.booking.service", {
        tenantId: pending.tenantId,
        locationId: pending.locationId,
        appointmentId: pending.id,
        startAt: pending.startAt,
        endAt: pending.endAt,
      });
      calendarLog("calendar.user.confirmed", { tenantId: pending.tenantId, appointmentId: pending.id });
      calendarLog("calendar.booking.started", { tenantId: pending.tenantId, appointmentId: pending.id, startAt: pending.startAt });
      if (voiceCallEnded(pending)) {
        await this.repository.save({ ...pending, version: 2, status: "FAILED" });
        return failure<CreateAppointmentError>({ code: "CALL_ENDED" });
      }
      const external = await this.calendar.createEvent({
        tenantId: pending.tenantId,
        locationId: pending.locationId,
        appointmentId: pending.id,
        employeeId: pending.employeeId,
        title: command.source === "DEVELOPER_TEST" ? "[YIBO TEST] Test Appointment" : `${service.name} appointment`,
        serviceName: service.name,
        ...(customer ? { patient: customer } : {}),
        startAt: pending.startAt,
        endAt: pending.endAt,
        idempotencyKey: pending.idempotencyKey,
      });
      if (!external.ok) {
        calendarLog("calendar.booking.failed", { tenantId: pending.tenantId, appointmentId: pending.id, code: external.error.code });
        await this.repository.save({ ...pending, version: 2, status: "FAILED" });
        return failure<CreateAppointmentError>(calendarFailure(external.error));
      }

      const linked: Appointment = { ...pending, externalCalendarEventId: external.value.externalEventId };
      await this.repository.save(linked);
      if (voiceCallEnded(linked)) return this.abandonUnconfirmed(linked, "CALL_ENDED");
      const confirmed: Appointment = { ...linked, version: 2, status: "CONFIRMED" };
      try {
        await this.repository.save(confirmed);
      } catch {
        return this.abandonUnconfirmed(linked, "CALENDAR_SYNC_FAILED");
      }
      await this.record(confirmed, "CREATED", command.source === "AI_CALL" ? "AI" : "OFFICE");
      await this.notify("CONFIRMATION", confirmed);
      calendarLog("calendar.booking.completed", { tenantId: confirmed.tenantId, appointmentId: confirmed.id, externalEventId: confirmed.externalCalendarEventId });
      return success(confirmed);
    });
  }

  async cancelAppointment(command: CancelAppointmentCommand) {
    return this.mutate(command, async appointment => {
      if (appointment.status === "CANCELLED") {
        return failure<CancelAppointmentError>({ code: "APPOINTMENT_ALREADY_CANCELLED" });
      }
      const cancellationPolicy = await this.businesses.getLocation(appointment.tenantId, appointment.locationId);
      if (!cancellationPolicy.ok || cancellationPolicy.value.location.policies.cancellationAllowed === false
        || minutesUntil(appointment.startAt, this.clock.now())
        < cancellationPolicy.value.location.policies.minimumCancellationNoticeMinutes) {
        return failure<CancelAppointmentError>({ code: "CANCELLATION_NOTICE_NOT_MET" });
      }
      if (appointment.externalCalendarEventId) {
        const cancelled = await this.calendar.cancelEvent({
          appointmentId: appointment.id,
          tenantId: appointment.tenantId,
          locationId: appointment.locationId,
          employeeId: appointment.employeeId,
          externalEventId: appointment.externalCalendarEventId,
        });
        if (!cancelled.ok) return failure<CancelAppointmentError>(calendarFailure(cancelled.error));
      }
      const result: Appointment = { ...appointment, version: (appointment.version ?? 1) + 1, status: "CANCELLED" };
      await this.repository.save(result);
      await this.record(result, "CANCELLED", "OFFICE");
      await this.notify("CANCELLATION", result);
      return success(result);
    });
  }

  async rescheduleAppointment(command: RescheduleAppointmentCommand) {
    if (!validDate(command.startAt)) {
      return failure<RescheduleAppointmentError>({ code: "VALIDATION_ERROR", message: "startAt must be a valid ISO datetime" });
    }
    return this.mutate(command, async appointment => {
      if (appointment.status !== "CONFIRMED" || !appointment.externalCalendarEventId) {
        return failure<RescheduleAppointmentError>({ code: "APPOINTMENT_NOT_CONFIRMED" });
      }
      const reschedulePolicy = await this.businesses.getLocation(appointment.tenantId, appointment.locationId);
      if (!reschedulePolicy.ok || reschedulePolicy.value.location.policies.reschedulingAllowed === false
        || minutesUntil(appointment.startAt, this.clock.now())
        < reschedulePolicy.value.location.policies.minimumRescheduleNoticeMinutes) {
        return failure<RescheduleAppointmentError>({ code: "RESCHEDULE_NOTICE_NOT_MET" });
      }

      const slot = await this.scheduling.validateSlot({
        tenantId: appointment.tenantId,
        locationId: appointment.locationId,
        serviceId: appointment.serviceId,
        employeeId: appointment.employeeId,
        startAt: command.startAt,
      });
      if (!slot.ok) {
        const mapped = mapSchedulingError(slot.error);
        return failure<RescheduleAppointmentError>(
          mapped.code === "CALENDAR_SYNC_FAILED" ? mapped : { code: "SLOT_NO_LONGER_AVAILABLE" },
        );
      }

      const moved = await this.calendar.rescheduleEvent({
        tenantId: appointment.tenantId,
        locationId: appointment.locationId,
        appointmentId: appointment.id,
        employeeId: appointment.employeeId,
        externalEventId: appointment.externalCalendarEventId!,
        startAt: slot.value.startAt,
        endAt: slot.value.endAt,
      });
      if (!moved.ok) return failure<RescheduleAppointmentError>(calendarFailure(moved.error));

      const updated: Appointment = {
        ...appointment,
        version: (appointment.version ?? 1) + 1,
        startAt: slot.value.startAt,
        endAt: slot.value.endAt,
        externalCalendarEventId: appointment.externalCalendarEventId,
      };
      await this.repository.save(updated);
      await this.record(updated, "RESCHEDULED", "OFFICE", { previousStartAt: appointment.startAt });
      await this.notify("RESCHEDULE", updated);
      return success(updated);
    });
  }

  async getAppointment(query: GetAppointmentQuery) {
    const appointment = await this.repository.findById(query.tenantId, query.appointmentId);
    return appointment && appointment.locationId === query.locationId
      ? success(appointment)
      : failure<AppointmentLookupError>({ code: "APPOINTMENT_NOT_FOUND" });
  }

  listUpcomingAppointments(query: ListUpcomingAppointmentsQuery): Promise<Appointment[]> {
    return this.repository.findUpcomingByCustomer({
      ...query,
      startsAtOrAfter: this.clock.now().toISOString(),
    });
  }

  async listCalendarAppointments(query: AppointmentCalendarQuery) {
    const iso = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
    const validDay = (value: string) => {
      const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
      return Number.isFinite(day.valueOf()) && day.toISOString().slice(0, 10) === value.slice(0, 10);
    };
    const start = Date.parse(query.rangeStart), end = Date.parse(query.rangeEnd);
    if (!iso.test(query.rangeStart) || !iso.test(query.rangeEnd) || !validDay(query.rangeStart) || !validDay(query.rangeEnd) || !Number.isFinite(start)
      || !Number.isFinite(end) || end <= start || end - start > 31 * 86_400_000) {
      return failure({ code: "VALIDATION_ERROR" as const, message: "Choose a period of at most 31 days with explicit time zones." });
    }
    // Read configuration directly so inactive locations/professionals do not hide historical bookings.
    const context = await this.businesses.getBusinessConfiguration(query.tenantId);
    if (!context.ok || !context.value.configuration.locations.some(item => item.id === query.locationId)) {
      return failure({ code: "VALIDATION_ERROR" as const, message: "Location is unavailable." });
    }
    const appointments = await this.repository.findInRange({
      ...query, rangeStart: new Date(start).toISOString(), rangeEnd: new Date(end).toISOString(),
    });
    const customers = new Map<string, Awaited<ReturnType<CustomerReader["get"]>>>();
    for (const customerId of new Set(appointments.map(item => item.customerId))) {
      customers.set(customerId, await this.customers.get(query.tenantId, customerId));
    }
    return success(appointments.map(item => {
      const customer = customers.get(item.customerId);
      return {
        ...item,
        ...(customer?.name ? { customerName: customer.name } : {}),
        ...(customer ? { customerPhone: customer.phone } : {}),
        professionalName: context.value.configuration.professionals.find(person => person.id === item.employeeId)?.displayName
          ?? "Unlisted professional",
      };
    }));
  }

  listAppointments(query: ListAppointmentsQuery): Promise<Appointment[]> {
    return this.repository.findByRange(query);
  }

  async listAppointmentEvents(query: GetAppointmentQuery) {
    const appointment = await this.repository.findById(query.tenantId, query.appointmentId);
    return appointment?.locationId === query.locationId
      ? this.repository.listEvents(query.tenantId, query.appointmentId) : [];
  }

  async markAppointmentOutcome(command: MarkAppointmentOutcomeCommand) {
    return this.mutate(command, async appointment => {
      if (appointment.status !== "CONFIRMED") return failure<AppointmentLookupError>({ code: "APPOINTMENT_NOT_FOUND" });
      const updated: Appointment = { ...appointment, version: (appointment.version ?? 1) + 1, outcomeStatus: command.outcome };
      await this.repository.save(updated);
      await this.record(updated, command.outcome, "OFFICE");
      return success(updated);
    });
  }

  private async mutate<E>(command: CancelAppointmentCommand, operation: (appointment: Appointment) => Promise<Result<Appointment, E>>)
    : Promise<Result<Appointment, E | AppointmentLookupError | AppointmentEditConflict>> {
    // The first read supplies only the lock scope. Never mutate this snapshot.
    const scope = await this.repository.findById(command.tenantId, command.appointmentId);
    if (!scope || scope.locationId !== command.locationId) return failure({ code: "APPOINTMENT_NOT_FOUND" });
    return this.guarded<Appointment, E | AppointmentLookupError | AppointmentEditConflict>(scope, async () => {
      const appointment = await this.repository.findById(command.tenantId, command.appointmentId);
      if (!appointment || appointment.locationId !== command.locationId) return failure<AppointmentLookupError>({ code: "APPOINTMENT_NOT_FOUND" });
      if (command.expectedVersion !== undefined && command.expectedVersion !== (appointment.version ?? 1)) {
        return failure<AppointmentEditConflict>({ code: "APPOINTMENT_VERSION_CONFLICT" });
      }
      return operation(appointment);
    });
  }

  private async guarded<T, E>(scope: { tenantId: string; locationId: string; employeeId: string }, operation: () => Promise<Result<T, E>>)
    : Promise<Result<T, E | AppointmentEditConflict>> {
    try { return await this.guard.execute(scope.tenantId, scope.locationId, scope.employeeId, operation); }
    catch (error) {
      if (error instanceof AppointmentOperationInProgressError) return failure({ code: "APPOINTMENT_OPERATION_IN_PROGRESS" });
      throw error;
    }
  }

  listCustomerHistory(tenantId: string, customerId: string, limit = 100) {
    return this.repository.findHistoryByCustomer(tenantId, customerId, Math.min(250, Math.max(1, limit)));
  }


  listTenantHistory(tenantId: string, limit = 5_000) {
    return this.repository.findByTenant(tenantId, Math.min(10_000, Math.max(1, limit)));
  }

  async reconcileUnconfirmedBookings(tenantId: string) {
    const released: string[] = [];
    const held: string[] = [];
    for (const appointment of await this.repository.findByTenant(tenantId, 10_000)) {
      if (appointment.status !== "PENDING_CONFIRMATION") continue;
      if (appointment.externalCalendarEventId) {
        held.push(appointment.id);
        continue;
      }
      await this.repository.save({ ...appointment, version: (appointment.version ?? 1) + 1, status: "FAILED" });
      released.push(appointment.id);
    }
    return { released, held };
  }

  /** Drop a calendar event created in this request when the booking cannot be confirmed. */
  private async abandonUnconfirmed(appointment: Appointment, code: "CALENDAR_SYNC_FAILED" | "CALL_ENDED")
    : Promise<Result<Appointment, CreateAppointmentError>> {
    if (appointment.externalCalendarEventId) {
      const cancelled = await this.calendar.cancelEvent({
        appointmentId: appointment.id,
        tenantId: appointment.tenantId,
        locationId: appointment.locationId,
        employeeId: appointment.employeeId,
        externalEventId: appointment.externalCalendarEventId,
      });
      if (!cancelled.ok) return failure({ code: "CALENDAR_SYNC_FAILED", retryable: true });
    }
    await this.repository.save({
      ...appointment,
      version: (appointment.version ?? 1) + 1,
      status: "FAILED",
      externalCalendarEventId: undefined,
    });
    return failure(code === "CALL_ENDED" ? { code: "CALL_ENDED" } : { code: "CALENDAR_SYNC_FAILED", retryable: false });
  }

  private record(appointment: Appointment, type: "CREATED" | "RESCHEDULED" | "CANCELLED" | "COMPLETED" | "NO_SHOW",
    actorType: "AI" | "OFFICE" | "SYSTEM", metadata?: Record<string, string>) {
    return this.repository.appendEvent({ id: this.createId(), tenantId: appointment.tenantId,
      appointmentId: appointment.id, type, occurredAt: this.clock.now().toISOString(), actorType, ...(metadata ? { metadata } : {}) });
  }

  private async notify(kind: "CONFIRMATION" | "RESCHEDULE" | "CANCELLATION", appointment: Appointment) {
    try { await this.notifications?.appointmentChanged(kind, appointment); }
    catch { /* Appointment/calendar success remains authoritative; delivery status is secondary. */ }
  }
}

const voiceCallEnded = (command: { source: string; sourceCallId?: string }): boolean =>
  command.source === "AI_CALL" && Boolean(command.sourceCallId) && isCallEnded(command.sourceCallId!);

const validateCreate = (command: CreateAppointmentCommand): string | null => {
  if (!command.tenantId || !command.locationId || !command.customerId || !command.serviceId || !command.employeeId || !command.idempotencyKey) {
    return "Required identifiers must not be empty";
  }
  return validDate(command.startAt) ? null : "startAt must be a valid ISO datetime";
};

const validDate = (value: string): boolean => !Number.isNaN(new Date(value).valueOf());
const minutesUntil = (value: string, now: Date): number => (new Date(value).valueOf() - now.valueOf()) / 60_000;
const localDay = (value: string, timezone: string) => new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(value));

const sameRequest = (appointment: Appointment, command: CreateAppointmentCommand): boolean =>
  appointment.customerId === command.customerId &&
  appointment.locationId === command.locationId &&
  appointment.serviceId === command.serviceId &&
  appointment.employeeId === command.employeeId &&
  appointment.startAt === new Date(command.startAt).toISOString();

const mapSchedulingError = (error: SchedulingError): CreateAppointmentError => {
  if (error.code === "SERVICE_NOT_FOUND") return { code: "SERVICE_NOT_FOUND" };
  if (error.code === "EMPLOYEE_NOT_FOUND") return { code: "EMPLOYEE_NOT_FOUND" };
  if (error.code === "EXTERNAL_CALENDAR_UNAVAILABLE") {
    return { code: "CALENDAR_SYNC_FAILED", retryable: error.retryable };
  }
  if (error.code === "INVALID_TIME_RANGE") return { code: "VALIDATION_ERROR", message: "Invalid appointment time" };
  return { code: "SLOT_NO_LONGER_AVAILABLE" };
};

const calendarFailure = (error: AppointmentCalendarError) => ({
  code: "CALENDAR_SYNC_FAILED" as const,
  retryable: error.code === "PROVIDER_UNAVAILABLE" ? error.retryable : error.code === "RATE_LIMITED",
});

const calendarLog = operationalLog;
