import { isCallEnded } from "../../calls/application/call-liveness.js";
import { currentAppointmentFence } from "./appointment-lock.js";
import { AppointmentOperationInProgressError } from "../ports/appointment-dependencies.js";
import { StaleAppointmentWriteError } from "../ports/appointment-repository.js";
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

  private recoveryChain: Promise<void> = Promise.resolve();

  async createAppointment(command: CreateAppointmentCommand) {
    const invalid = validateCreate(command);
    if (invalid) return failure<CreateAppointmentError>({ code: "VALIDATION_ERROR", message: invalid });
    await this.recoverStuckBookings(command.tenantId);

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
        updatedAt: this.clock.now().toISOString(),
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
      if (!this.fenceHeld(pending)) return failure<CreateAppointmentError>({ code: "APPOINTMENT_VERSION_CONFLICT" });
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
    const invalidKey = requiredKey(command.idempotencyKey);
    if (invalidKey) return failure<CancelAppointmentError>({ code: "VALIDATION_ERROR", message: invalidKey });
    const fingerprint = mutationFingerprint("cancel", command.appointmentId);
    const replay = await this.replay(command.tenantId, command.idempotencyKey, fingerprint);
    if (replay) return replay;
    await this.recoverStuckBookings(command.tenantId);
    const recovered = await this.replay(command.tenantId, command.idempotencyKey, fingerprint);
    if (recovered) return recovered;
    return this.mutate(command, async appointment => {
      const raced = await this.replay(command.tenantId, command.idempotencyKey, fingerprint);
      if (raced) return raced;
      if (appointment.intentKey === command.idempotencyKey && appointment.operationIntent) {
        if (appointment.intentFingerprint !== fingerprint) return failure<CancelAppointmentError>({ code: "IDEMPOTENCY_CONFLICT" });
        return this.finishCancel(appointment, command.idempotencyKey, fingerprint);
      }
      if (this.otherIntent(appointment, command.idempotencyKey)) {
        return failure<CancelAppointmentError>({ code: "APPOINTMENT_OPERATION_IN_PROGRESS" });
      }
      if (appointment.status === "CANCELLED") {
        return failure<CancelAppointmentError>({ code: "APPOINTMENT_ALREADY_CANCELLED" });
      }
      const cancellationPolicy = await this.businesses.getLocation(appointment.tenantId, appointment.locationId);
      if (!cancellationPolicy.ok || cancellationPolicy.value.location.policies.cancellationAllowed === false
        || minutesUntil(appointment.startAt, this.clock.now())
        < cancellationPolicy.value.location.policies.minimumCancellationNoticeMinutes) {
        return failure<CancelAppointmentError>({ code: "CANCELLATION_NOTICE_NOT_MET" });
      }
      const captured = await this.captureIntentEtag(appointment);
      if (captured.state === "stale") return failure<CancelAppointmentError>({ code: "NEEDS_RECONCILE" });
      if (captured.state === "unavailable") return failure<CancelAppointmentError>({ code: "CALENDAR_SYNC_FAILED", retryable: true });
      const marked = await this.markIntent(appointment, "CANCELLING", command.idempotencyKey, fingerprint, captured.etag);
      if (!marked) return failure<CancelAppointmentError>({ code: "APPOINTMENT_VERSION_CONFLICT" });
      return this.finishCancel(marked, command.idempotencyKey, fingerprint);
    });
  }

  async rescheduleAppointment(command: RescheduleAppointmentCommand) {
    if (!validDate(command.startAt)) {
      return failure<RescheduleAppointmentError>({ code: "VALIDATION_ERROR", message: "startAt must be a valid ISO datetime" });
    }
    const invalidKey = requiredKey(command.idempotencyKey);
    if (invalidKey) return failure<RescheduleAppointmentError>({ code: "VALIDATION_ERROR", message: invalidKey });
    const fingerprint = mutationFingerprint("reschedule", command.appointmentId, new Date(command.startAt).toISOString());
    const replay = await this.replay(command.tenantId, command.idempotencyKey, fingerprint);
    if (replay) return replay;
    await this.recoverStuckBookings(command.tenantId);
    const recovered = await this.replay(command.tenantId, command.idempotencyKey, fingerprint);
    if (recovered) return recovered;
    return this.mutate(command, async appointment => {
      const raced = await this.replay(command.tenantId, command.idempotencyKey, fingerprint);
      if (raced) return raced;
      if (appointment.intentKey === command.idempotencyKey && appointment.operationIntent) {
        if (appointment.intentFingerprint !== fingerprint) return failure<RescheduleAppointmentError>({ code: "IDEMPOTENCY_CONFLICT" });
        const slot = await this.scheduling.validateSlot({
          tenantId: appointment.tenantId, locationId: appointment.locationId, serviceId: appointment.serviceId,
          employeeId: appointment.employeeId, startAt: command.startAt,
        });
        if (!slot.ok) {
          const mapped = mapSchedulingError(slot.error);
          return failure<RescheduleAppointmentError>(mapped.code === "CALENDAR_SYNC_FAILED" ? mapped : { code: "SLOT_NO_LONGER_AVAILABLE" });
        }
        return this.finishReschedule(appointment, command.idempotencyKey, fingerprint, slot.value);
      }
      if (this.otherIntent(appointment, command.idempotencyKey)) {
        return failure<RescheduleAppointmentError>({ code: "APPOINTMENT_OPERATION_IN_PROGRESS" });
      }
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
        tenantId: appointment.tenantId, locationId: appointment.locationId, serviceId: appointment.serviceId,
        employeeId: appointment.employeeId, startAt: command.startAt,
      });
      if (!slot.ok) {
        const mapped = mapSchedulingError(slot.error);
        return failure<RescheduleAppointmentError>(mapped.code === "CALENDAR_SYNC_FAILED" ? mapped : { code: "SLOT_NO_LONGER_AVAILABLE" });
      }
      const captured = await this.captureIntentEtag(appointment);
      if (captured.state === "stale") return failure<RescheduleAppointmentError>({ code: "NEEDS_RECONCILE" });
      if (captured.state === "unavailable") return failure<RescheduleAppointmentError>({ code: "CALENDAR_SYNC_FAILED", retryable: true });
      const marked = await this.markIntent(appointment, "RESCHEDULING", command.idempotencyKey, fingerprint, captured.etag);
      if (!marked) return failure<RescheduleAppointmentError>({ code: "APPOINTMENT_VERSION_CONFLICT" });
      return this.finishReschedule(marked, command.idempotencyKey, fingerprint, slot.value);
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

  async markAppointmentOutcome(command: MarkAppointmentOutcomeCommand): Promise<Result<Appointment, AppointmentLookupError | AppointmentEditConflict>> {
    return this.mutate<AppointmentLookupError | AppointmentEditConflict>(command, async appointment => {
      if (appointment.status !== "CONFIRMED") return failure<AppointmentLookupError>({ code: "APPOINTMENT_NOT_FOUND" });
      const updated: Appointment = {
        ...appointment, version: (appointment.version ?? 1) + 1, outcomeStatus: command.outcome, updatedAt: this.clock.now().toISOString(),
      };
      const saved = await this.writeIfCurrent(updated, appointment.version ?? 1, "CONFIRMED");
      if (!saved) return failure<AppointmentEditConflict>({ code: "APPOINTMENT_VERSION_CONFLICT" });
      await this.record(updated, command.outcome, "OFFICE");
      return success(updated);
    });
  }

  private async mutate<E>(
    command: { tenantId: string; locationId: string; appointmentId: string; expectedVersion?: number; idempotencyKey?: string },
    operation: (appointment: Appointment) => Promise<Result<Appointment, E>>,
  ): Promise<Result<Appointment, E | AppointmentLookupError | AppointmentEditConflict>> {
    // The first read supplies only the lock scope. Never mutate this snapshot.
    const scope = await this.repository.findById(command.tenantId, command.appointmentId);
    if (!scope || scope.locationId !== command.locationId) return failure({ code: "APPOINTMENT_NOT_FOUND" });
    return this.guarded<Appointment, E | AppointmentLookupError | AppointmentEditConflict>(scope, async () => {
      const appointment = await this.repository.findById(command.tenantId, command.appointmentId);
      if (!appointment || appointment.locationId !== command.locationId) return failure<AppointmentLookupError>({ code: "APPOINTMENT_NOT_FOUND" });
      const continuing = Boolean(command.idempotencyKey && appointment.intentKey === command.idempotencyKey && appointment.operationIntent);
      if (!continuing && command.expectedVersion !== undefined && command.expectedVersion !== (appointment.version ?? 1)) {
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
      if (error instanceof StaleAppointmentWriteError) return failure({ code: "APPOINTMENT_VERSION_CONFLICT" });
      throw error;
    }
  }

  listCustomerHistory(tenantId: string, customerId: string, limit = 100) {
    return this.repository.findHistoryByCustomer(tenantId, customerId, Math.min(250, Math.max(1, limit)));
  }


  listTenantHistory(tenantId: string, limit = 5_000) {
    return this.repository.findByTenant(tenantId, Math.min(10_000, Math.max(1, limit)));
  }

  async recoverStuckBookings(tenantId: string) {
    const reconciled = await this.reconcileUnconfirmedBookings(tenantId);
    return { ...reconciled, releasedLocks: [] as string[] };
  }

  async reconcileUnconfirmedBookings(tenantId: string) {
    const run = this.recoveryChain.then(() => this.reconcileOnce(tenantId));
    this.recoveryChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async reconcileOnce(tenantId: string) {
    const released: string[] = [];
    const confirmed: string[] = [];
    const held: string[] = [];
    const repairHeld = new Set<string>();
    const liveLocations = new Set<string>();
    const staleBefore = this.clock.now().getTime() - STALE_APPOINTMENT_LOCK_MS;
    const appointments = await this.repository.findByTenant(tenantId, 10_000);
    for (const appointment of appointments) {
      if (this.guard.hasLiveLease(appointment.tenantId, appointment.locationId)) {
        liveLocations.add(appointment.locationId);
        continue;
      }
      const outcome = await this.reconcileOne(appointment, staleBefore);
      if (outcome === "released") released.push(appointment.id);
      else if (outcome === "confirmed") confirmed.push(appointment.id);
      else if (outcome === "held") held.push(appointment.id);
      if (outcome === "held" && this.repairCandidate(appointment)) repairHeld.add(appointment.locationId);
    }
    const locations = new Set(appointments.map((item) => item.locationId));
    for (const locationId of locations) {
      if (liveLocations.has(locationId) || repairHeld.has(locationId)) continue;
      if (this.guard.hasUnresolvedSteal(tenantId, locationId)) this.guard.clearSteal(tenantId, locationId);
    }
    return { released, confirmed, held };
  }

  private async reconcileOne(appointment: Appointment, staleBefore: number): Promise<"released" | "confirmed" | "held" | "skipped"> {
    if (this.guard.hasLiveLease(appointment.tenantId, appointment.locationId)) return "skipped";
    if (appointment.operationIntent) return this.reconcileOpenIntent(appointment);
    if (appointment.status !== "PENDING_CONFIRMATION") {
      if (!this.repairCandidate(appointment) || !this.guard.hasUnresolvedSteal(appointment.tenantId, appointment.locationId)) {
        return "skipped";
      }
      return this.repairCommitted(appointment);
    }
    const updatedAt = appointment.updatedAt ? Date.parse(appointment.updatedAt) : 0;
    if (!appointment.compensationRequired && updatedAt >= staleBefore) return "skipped";
    const preview = await this.calendar.inspectEvent(this.inspectionQuery(appointment));
    if (!preview.ok) return "held";
    try {
      return await this.guard.execute(appointment.tenantId, appointment.locationId, appointment.employeeId, async () => {
        const current = await this.repository.findById(appointment.tenantId, appointment.id);
        if (!current || current.status !== "PENDING_CONFIRMATION" || (current.version ?? 1) !== (appointment.version ?? 1)) {
          return "skipped";
        }
        if (current.compensationRequired) return this.finishCompensation(current);
        const inspection = await this.calendar.inspectEvent(this.inspectionQuery(current));
        if (!inspection.ok) return "held";
        return this.finishReconciliation(current, inspection.value);
      });
    } catch (error) {
      if (error instanceof AppointmentOperationInProgressError) return "held";
      throw error;
    }
  }

  private inspectionQuery(appointment: Appointment) {
    return {
      tenantId: appointment.tenantId,
      locationId: appointment.locationId,
      employeeId: appointment.employeeId,
      appointmentId: appointment.id,
      ...(appointment.externalCalendarEventId ? { externalEventId: appointment.externalCalendarEventId } : {}),
    };
  }

  private async finishReconciliation(
    current: Appointment,
    inspection: { present: boolean; externalEventId?: string },
  ): Promise<"released" | "confirmed" | "held" | "skipped"> {
    if (current.compensationRequired) return this.finishCompensation(current);
    const expected = current.version ?? 1;
    const stamp = this.clock.now().toISOString();
    if (!inspection.present) {
      const saved = await this.writeIfCurrent({
        ...current,
        version: expected + 1,
        status: "FAILED",
        externalCalendarEventId: undefined,
        compensationRequired: undefined,
        updatedAt: stamp,
      }, expected, "PENDING_CONFIRMATION");
      return saved ? "released" : "skipped";
    }
    const externalCalendarEventId = inspection.externalEventId ?? current.externalCalendarEventId;
    const confirmedAppointment: Appointment = {
      ...current,
      version: expected + 1,
      status: "CONFIRMED",
      compensationRequired: undefined,
      updatedAt: stamp,
      ...(externalCalendarEventId ? { externalCalendarEventId } : {}),
    };
    const saved = await this.writeIfCurrent(confirmedAppointment, expected, "PENDING_CONFIRMATION");
    if (!saved) return "skipped";
    await this.record(confirmedAppointment, "CREATED", "SYSTEM", { reconciled: "calendar" });
    return "confirmed";
  }

  /** A compensation row is failed only after the event is proven gone. Timeout and 5xx stay pending. */
  private async finishCompensation(current: Appointment): Promise<"released" | "held" | "skipped"> {
    const expected = current.version ?? 1;
    const externalCalendarEventId = current.externalCalendarEventId;
    if (externalCalendarEventId) {
      let gone = false;
      try {
        const inspection = await this.calendar.inspectEvent(this.inspectionQuery(current));
        if (!inspection.ok) return "held";
        gone = !inspection.value.present;
        if (!gone) {
          if (!inspection.value.etag || !this.fenceHeld(current)) return "held";
          const cancelled = await this.calendar.cancelEvent({
            appointmentId: current.id, tenantId: current.tenantId, locationId: current.locationId,
            employeeId: current.employeeId, externalEventId: externalCalendarEventId,
            expectedEtag: inspection.value.etag,
          });
          if (!cancelled.ok && cancelled.error.code !== "EVENT_NOT_FOUND") return "held";
          gone = true;
        }
      } catch {
        return "held";
      }
      if (!gone) return "held";
    }
    const saved = await this.writeIfCurrent({
      ...current,
      version: expected + 1,
      status: "FAILED",
      externalCalendarEventId: undefined,
      compensationRequired: undefined,
      updatedAt: this.clock.now().toISOString(),
    }, expected, "PENDING_CONFIRMATION");
    return saved ? "released" : "skipped";
  }

  private async reconcileOpenIntent(appointment: Appointment): Promise<"released" | "confirmed" | "held" | "skipped"> {
    try {
      return await this.guard.execute(appointment.tenantId, appointment.locationId, appointment.employeeId, async () => {
        const current = await this.repository.findById(appointment.tenantId, appointment.id);
        if (!current || !current.operationIntent || (current.version ?? 1) !== (appointment.version ?? 1)) return "skipped";
        const inspection = await this.calendar.inspectEvent(this.inspectionQuery(current));
        if (!inspection.ok) return "held";
        if (current.operationIntent === "RESCHEDULING" || current.intentFingerprint?.startsWith("reschedule:")) {
          const target = current.intentFingerprint?.split(":").slice(2).join(":");
          const moved = inspection.value.present && target && inspection.value.startAt
            && Date.parse(inspection.value.startAt) === Date.parse(target);
          if (!moved || !inspection.value.endAt) return "held";
          const saved = await this.commitRecovered(current, {
            ...current,
            startAt: inspection.value.startAt!,
            endAt: inspection.value.endAt,
          }, "RESCHEDULED", "reschedule");
          return saved ? "confirmed" : "skipped";
        }
        if (inspection.value.present && current.externalCalendarEventId) {
          if (!current.intentEtag || !this.fenceHeld(current)) return "held";
          try {
            const cancelled = await this.calendar.cancelEvent({
              appointmentId: current.id, tenantId: current.tenantId, locationId: current.locationId,
              employeeId: current.employeeId, externalEventId: current.externalCalendarEventId,
              expectedEtag: current.intentEtag,
            });
            if (cancelled.ok || cancelled.error.code === "EVENT_NOT_FOUND") {
              /* The stored etag still matched, so the delete is the intent's delete. */
            } else return "held";
          } catch {
            return "held";
          }
        }
        return (await this.commitRecovered(current, { ...current, status: "CANCELLED" }, "CANCELLED", "cancel")) ? "released" : "skipped";
      });
    } catch (error) {
      if (error instanceof AppointmentOperationInProgressError) return "held";
      throw error;
    }
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
      if (!cancelled.ok) {
        await this.repository.save({
          ...appointment,
          compensationRequired: true,
          updatedAt: this.clock.now().toISOString(),
        });
        return failure({ code: "CALENDAR_SYNC_FAILED", retryable: true });
      }
    }
    await this.repository.save({
      ...appointment,
      version: (appointment.version ?? 1) + 1,
      status: "FAILED",
      externalCalendarEventId: undefined,
    });
    return failure(code === "CALL_ENDED" ? { code: "CALL_ENDED" } : { code: "CALENDAR_SYNC_FAILED", retryable: false });
  }

  private async persistChange(
    appointment: Appointment,
    expectedVersion: number,
    receipt: { idempotencyKey: string; action: "cancel" | "reschedule"; appointmentId: string; fingerprint: string; appointment: Appointment },
    type: "CANCELLED" | "RESCHEDULED",
    metadata: Record<string, string> | undefined,
    expectedStatus: Appointment["status"],
  ) {
    try {
      await this.repository.commitChange({
        appointment,
        expectedVersion,
        expectedStatus,
        receipt,
        event: {
          id: this.createId(), tenantId: appointment.tenantId, appointmentId: appointment.id, type,
          occurredAt: this.clock.now().toISOString(), actorType: "OFFICE", ...(metadata ? { metadata } : {}),
        },
      });
      return success(appointment);
    } catch (error) {
      if (error instanceof StaleAppointmentWriteError) return failure({ code: "APPOINTMENT_VERSION_CONFLICT" as const });
      return failure({ code: "CALENDAR_SYNC_FAILED" as const, retryable: true });
    }
  }

  private fenceHeld(scope: { tenantId: string; locationId: string }): boolean {
    const fence = currentAppointmentFence();
    if (!fence) return true;
    return this.guard.ownsFence(scope.tenantId, scope.locationId, fence.ownerId, fence.fence);
  }

  private otherIntent(appointment: Appointment, key: string): boolean {
    return Boolean(appointment.operationIntent && appointment.intentKey !== key);
  }

  /** Read the etag once, before the intent is stored. A later mutation must not read a replacement. */
  private async captureIntentEtag(appointment: Appointment): Promise<{ state: "ready"; etag?: string } | { state: "stale" } | { state: "unavailable" }> {
    if (!this.fenceHeld(appointment)) return { state: "stale" };
    if (!appointment.externalCalendarEventId) return { state: "ready" };
    try {
      const inspection = await this.calendar.inspectEvent(this.inspectionQuery(appointment));
      if (!this.fenceHeld(appointment)) return { state: "stale" };
      if (!inspection.ok) return { state: "unavailable" };
      if (!inspection.value.present) return { state: "ready" };
      if (!inspection.value.etag) return { state: "unavailable" };
      return { state: "ready", etag: inspection.value.etag };
    } catch {
      return { state: "unavailable" };
    }
  }

  /** A committed row this recovery pass may push back onto Google. */
  private repairCandidate(appointment: Appointment): boolean {
    return !appointment.operationIntent && this.recentlyCommitted(appointment);
  }

  private recentlyCommitted(appointment: Appointment): boolean {
    if (appointment.status !== "CONFIRMED" && appointment.status !== "CANCELLED") return false;
    if (!appointment.externalCalendarEventId) return false;
    const updated = appointment.updatedAt ? Date.parse(appointment.updatedAt) : Number.NaN;
    return Number.isFinite(updated) && this.clock.now().getTime() - updated <= REPAIR_WINDOW_MS;
  }

  /** Push Google back to a committed row. The read here is the repair, not the original mutation's etag. */
  private async repairCommitted(appointment: Appointment): Promise<"released" | "confirmed" | "held" | "skipped"> {
    try {
      return await this.guard.execute(appointment.tenantId, appointment.locationId, appointment.employeeId, async () => {
        const current = await this.repository.findById(appointment.tenantId, appointment.id);
        if (!current || current.operationIntent || (current.version ?? 1) !== (appointment.version ?? 1)) return "skipped";
        if (!this.fenceHeld(current)) return "skipped";
        const inspection = await this.calendar.inspectEvent(this.inspectionQuery(current));
        if (!inspection.ok) return "held";
        if (current.status === "CANCELLED") {
          if (!inspection.value.present || !current.externalCalendarEventId) return "skipped";
          if (!inspection.value.etag || !this.fenceHeld(current)) return "held";
          const cancelled = await this.calendar.cancelEvent({
            appointmentId: current.id, tenantId: current.tenantId, locationId: current.locationId,
            employeeId: current.employeeId, externalEventId: current.externalCalendarEventId,
            expectedEtag: inspection.value.etag,
          });
          if (!cancelled.ok && cancelled.error.code !== "EVENT_NOT_FOUND") return "held";
          return "released";
        }
        if (current.status !== "CONFIRMED" || !current.externalCalendarEventId) return "skipped";
        if (!inspection.value.present) return "held";
        const sameStart = Boolean(inspection.value.startAt) && Date.parse(inspection.value.startAt!) === Date.parse(current.startAt);
        const sameEnd = Boolean(inspection.value.endAt) && Date.parse(inspection.value.endAt!) === Date.parse(current.endAt);
        if (sameStart && sameEnd) return "skipped";
        if (!inspection.value.etag || !this.fenceHeld(current)) return "held";
        const moved = await this.calendar.rescheduleEvent({
          tenantId: current.tenantId, locationId: current.locationId, appointmentId: current.id,
          employeeId: current.employeeId, externalEventId: current.externalCalendarEventId,
          startAt: current.startAt, endAt: current.endAt, expectedEtag: inspection.value.etag,
        });
        return moved.ok ? "confirmed" : "held";
      });
    } catch (error) {
      if (error instanceof AppointmentOperationInProgressError) return "skipped";
      throw error;
    }
  }

  private async markIntent(
    appointment: Appointment,
    intent: "CANCELLING" | "RESCHEDULING",
    key: string,
    fingerprint: string,
    etag?: string,
  ): Promise<Appointment | null> {
    const expected = appointment.version ?? 1;
    const next: Appointment = {
      ...appointment,
      version: expected + 1,
      operationIntent: intent,
      intentKey: key,
      intentFingerprint: fingerprint,
      ...(etag ? { intentEtag: etag } : {}),
      updatedAt: this.clock.now().toISOString(),
    };
    return await this.writeIfCurrent(next, expected, appointment.status) ? next : null;
  }

  private async markUnknown(appointment: Appointment): Promise<void> {
    const expected = appointment.version ?? 1;
    await this.writeIfCurrent({
      ...appointment,
      version: expected + 1,
      operationIntent: "OUTCOME_UNKNOWN",
      updatedAt: this.clock.now().toISOString(),
    }, expected, appointment.status);
  }

  private async writeIfCurrent(appointment: Appointment, expectedVersion: number, expectedStatus: Appointment["status"]) {
    const fence = currentAppointmentFence();
    if (fence && !this.guard.ownsFence(appointment.tenantId, appointment.locationId, fence.ownerId, fence.fence)) return false;
    return this.repository.saveIfVersion(appointment, expectedVersion, expectedStatus);
  }

  private async finishCancel(appointment: Appointment, key: string, fingerprint: string) {
    if (appointment.externalCalendarEventId) {
      const removed = await this.proveCancelled(appointment);
      if (removed === "stale" || removed === "reconcile") return failure<CancelAppointmentError>({ code: "NEEDS_RECONCILE" });
      if (removed !== "done") {
        await this.markUnknown(appointment);
        return failure<CancelAppointmentError>({ code: "CALENDAR_SYNC_FAILED", retryable: true });
      }
    }
    const result: Appointment = clearIntent({
      ...appointment,
      version: (appointment.version ?? 1) + 1,
      status: "CANCELLED",
      updatedAt: this.clock.now().toISOString(),
    });
    const persisted = await this.persistChange(result, appointment.version ?? 1, {
      idempotencyKey: key, action: "cancel", appointmentId: result.id, fingerprint, appointment: result,
    }, "CANCELLED", undefined, appointment.status);
    if (!persisted.ok) {
      if (this.fenceHeld(appointment)) await this.markUnknown(appointment);
      return persisted;
    }
    await this.notify("CANCELLATION", result);
    return success(result);
  }

  private async finishReschedule(
    appointment: Appointment,
    key: string,
    fingerprint: string,
    slot: { startAt: string; endAt: string },
  ) {
    const moved = await this.proveRescheduled(appointment, slot);
    if (moved === "stale" || moved === "reconcile") return failure<RescheduleAppointmentError>({ code: "NEEDS_RECONCILE" });
    if (moved !== "done") {
      await this.markUnknown(appointment);
      return failure<RescheduleAppointmentError>({ code: "CALENDAR_SYNC_FAILED", retryable: true });
    }
    const updated: Appointment = clearIntent({
      ...appointment,
      version: (appointment.version ?? 1) + 1,
      startAt: slot.startAt,
      endAt: slot.endAt,
      updatedAt: this.clock.now().toISOString(),
    });
    const persisted = await this.persistChange(updated, appointment.version ?? 1, {
      idempotencyKey: key, action: "reschedule", appointmentId: updated.id, fingerprint, appointment: updated,
    }, "RESCHEDULED", { previousStartAt: appointment.startAt }, appointment.status);
    if (!persisted.ok) {
      if (this.fenceHeld(appointment)) await this.markUnknown(appointment);
      return persisted;
    }
    await this.notify("RESCHEDULE", updated);
    return success(updated);
  }

  /** done: the event is gone or this call deleted it with the stored etag. reconcile/stale keep the intent. */
  private async proveCancelled(appointment: Appointment): Promise<"done" | "unknown" | "reconcile" | "stale"> {
    if (!this.fenceHeld(appointment)) return "stale";
    try {
      const inspection = await this.calendar.inspectEvent(this.inspectionQuery(appointment));
      if (!inspection.ok) return "unknown";
      if (!inspection.value.present) return "done";
      if (!appointment.externalCalendarEventId || !appointment.intentEtag) return "reconcile";
      if (!this.fenceHeld(appointment)) return "stale";
      const cancelled = await this.calendar.cancelEvent({
        appointmentId: appointment.id, tenantId: appointment.tenantId, locationId: appointment.locationId,
        employeeId: appointment.employeeId, externalEventId: appointment.externalCalendarEventId,
        expectedEtag: appointment.intentEtag,
      });
      if (cancelled.ok || cancelled.error.code === "EVENT_NOT_FOUND") return "done";
      if (cancelled.error.code === "NEEDS_RECONCILE") return "reconcile";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** done: Google already shows the target time, or this call moved it with the stored etag. */
  private async proveRescheduled(appointment: Appointment, slot: { startAt: string; endAt: string }): Promise<"done" | "unknown" | "reconcile" | "stale"> {
    if (!this.fenceHeld(appointment)) return "stale";
    try {
      const inspection = await this.calendar.inspectEvent(this.inspectionQuery(appointment));
      if (!inspection.ok || !inspection.value.present || !appointment.externalCalendarEventId) return "unknown";
      if (inspection.value.startAt && Date.parse(inspection.value.startAt) === Date.parse(slot.startAt)
        && inspection.value.endAt && Date.parse(inspection.value.endAt) === Date.parse(slot.endAt)) return "done";
      if (!appointment.intentEtag) return "reconcile";
      if (!this.fenceHeld(appointment)) return "stale";
      const moved = await this.calendar.rescheduleEvent({
        tenantId: appointment.tenantId, locationId: appointment.locationId, appointmentId: appointment.id,
        employeeId: appointment.employeeId, externalEventId: appointment.externalCalendarEventId,
        startAt: slot.startAt, endAt: slot.endAt, expectedEtag: appointment.intentEtag,
      });
      if (moved.ok) return "done";
      if (moved.error.code === "NEEDS_RECONCILE") return "reconcile";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  private async commitRecovered(
    current: Appointment,
    next: Appointment,
    type: "CANCELLED" | "RESCHEDULED",
    action: "cancel" | "reschedule",
  ): Promise<boolean> {
    const expected = current.version ?? 1;
    const appointment: Appointment = clearIntent({
      ...next,
      version: expected + 1,
      updatedAt: this.clock.now().toISOString(),
    });
    if (!current.intentKey || !current.intentFingerprint) {
      return this.writeIfCurrent(appointment, expected, current.status);
    }
    try {
      await this.repository.commitChange({
        appointment, expectedVersion: expected, expectedStatus: current.status,
        receipt: {
          idempotencyKey: current.intentKey, action, appointmentId: appointment.id,
          fingerprint: current.intentFingerprint, appointment,
        },
        event: {
          id: this.createId(), tenantId: appointment.tenantId, appointmentId: appointment.id, type,
          occurredAt: appointment.updatedAt ?? this.clock.now().toISOString(), actorType: "SYSTEM",
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async replay(tenantId: string, key: string, fingerprint: string) {
    const existing = await this.repository.findMutation(tenantId, key);
    if (!existing) return null;
    return existing.fingerprint === fingerprint
      ? success(existing.appointment)
      : failure({ code: "IDEMPOTENCY_CONFLICT" as const });
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

/** A crashed writer or a hung provider must not block the location forever. */
export const STALE_APPOINTMENT_LOCK_MS = 3 * 60 * 1000;

const clearIntent = (appointment: Appointment): Appointment => {
  const {
    operationIntent: _operationIntent, intentKey: _intentKey, intentFingerprint: _intentFingerprint, intentEtag: _intentEtag, ...rest
  } = appointment;
  return rest;
};

const REPAIR_WINDOW_MS = 15 * 60 * 1000;

const requiredKey = (key: string | undefined): string | null =>
  key && key.trim() ? null : "An idempotency key is required";

const mutationFingerprint = (action: "cancel" | "reschedule", appointmentId: string, startAt = ""): string =>
  `${action}:${appointmentId}:${startAt}`;

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
