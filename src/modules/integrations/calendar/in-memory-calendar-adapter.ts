import { failure, success } from "../../../shared/domain/result.js";
import type { AppointmentCalendarPort } from "../../appointments/ports/appointment-dependencies.js";
import type { CalendarPort, BusyInterval } from "../../scheduling/ports/calendar-port.js";

type CalendarEvent = {
  externalEventId: string;
  tenantId: string;
  locationId: string;
  appointmentId: string;
  employeeId: string;
  title: string;
  startAt: string;
  endAt: string;
  idempotencyKey: string;
  cancelled: boolean;
  etag: string;
};

/**
 * A contract-complete calendar adapter for local development and integration tests.
 * A Google/Outlook adapter can replace it without leaking provider SDK types into
 * Scheduling or Appointments.
 */
export class InMemoryCalendarAdapter implements CalendarPort, AppointmentCalendarPort {
  private readonly events = new Map<string, CalendarEvent>();
  private readonly eventIdByKey = new Map<string, string>();
  private nextId = 1;
  private revision = 0;

  async getBusyIntervals(query: {
    tenantId: string;
    locationId: string;
    employeeId: string;
    rangeStart: string;
    rangeEnd: string;
  }) {
    const rangeStart = new Date(query.rangeStart);
    const rangeEnd = new Date(query.rangeEnd);
    if (!isValidRange(rangeStart, rangeEnd)) {
      return failure({ code: "VALIDATION_ERROR" as const, message: "A valid calendar range is required." });
    }

    const intervals: BusyInterval[] = [];
    for (const event of this.events.values()) {
      if (event.cancelled || event.tenantId !== query.tenantId || event.locationId !== query.locationId
        || event.employeeId !== query.employeeId) continue;
      if (overlaps(new Date(event.startAt), new Date(event.endAt), rangeStart, rangeEnd)) {
        intervals.push({ startAt: event.startAt, endAt: event.endAt });
      }
    }
    return success(intervals.sort((left, right) => left.startAt.localeCompare(right.startAt)));
  }

  async createEvent(command: {
    tenantId: string;
    locationId: string;
    appointmentId: string;
    employeeId: string;
    title: string;
    startAt: string;
    endAt: string;
    idempotencyKey: string;
  }) {
    const start = new Date(command.startAt);
    const end = new Date(command.endAt);
    if (!command.tenantId || !command.locationId || !command.appointmentId || !command.employeeId || !command.idempotencyKey || !isValidRange(start, end)) {
      return failure({ code: "VALIDATION_ERROR" as const, message: "A complete and valid calendar event is required." });
    }

    const key = `${command.tenantId}:${command.locationId}:${command.idempotencyKey}`;
    const existingId = this.eventIdByKey.get(key);
    if (existingId) return success({ provider: "in-memory", externalEventId: existingId });

    const externalEventId = `calendar-event-${this.nextId++}`;
    this.events.set(externalEventId, { ...command, externalEventId, cancelled: false, etag: this.nextEtag() });
    this.eventIdByKey.set(key, externalEventId);
    return success({ provider: "in-memory", externalEventId });
  }

  async rescheduleEvent(command: Parameters<AppointmentCalendarPort["rescheduleEvent"]>[0]) {
    if (!isValidRange(new Date(command.startAt), new Date(command.endAt))) {
      return failure({ code: "VALIDATION_ERROR" as const, message: "A valid event range is required." });
    }
    const event = this.events.get(command.externalEventId);
    if (!event || event.cancelled || event.tenantId !== command.tenantId || event.locationId !== command.locationId
      || event.employeeId !== command.employeeId || event.appointmentId !== command.appointmentId) {
      return failure({ code: "EVENT_NOT_FOUND" as const });
    }
    if (command.expectedEtag && command.expectedEtag !== event.etag) return failure({ code: "NEEDS_RECONCILE" as const });
    this.events.set(event.externalEventId, { ...event, startAt: command.startAt, endAt: command.endAt, etag: this.nextEtag() });
    return success(undefined);
  }

  async cancelEvent(command: { tenantId: string; locationId: string; employeeId: string; externalEventId: string; expectedEtag?: string }) {
    const event = this.events.get(command.externalEventId);
    if (!event || event.tenantId !== command.tenantId || event.locationId !== command.locationId
      || event.employeeId !== command.employeeId) {
      return failure({ code: "EVENT_NOT_FOUND" as const });
    }
    if (command.expectedEtag && command.expectedEtag !== event.etag) return failure({ code: "NEEDS_RECONCILE" as const });
    this.events.set(event.externalEventId, { ...event, cancelled: true, etag: this.nextEtag() });
    return success(undefined);
  }

  async inspectEvent(command: Parameters<AppointmentCalendarPort["inspectEvent"]>[0]): ReturnType<AppointmentCalendarPort["inspectEvent"]> {
    const found = [...this.events.values()].find((event) => !event.cancelled
      && event.tenantId === command.tenantId
      && event.appointmentId === command.appointmentId
      && event.employeeId === command.employeeId
      && (command.externalEventId === undefined || event.externalEventId === command.externalEventId));
    return success(found
      ? { present: true, externalEventId: found.externalEventId, startAt: found.startAt, endAt: found.endAt, etag: found.etag }
      : { present: false });
  }

  private nextEtag(): string {
    this.revision += 1;
    return `etag-${this.revision}`;
  }
}

const isValidRange = (start: Date, end: Date): boolean =>
  !Number.isNaN(start.valueOf()) && !Number.isNaN(end.valueOf()) && start < end;

const overlaps = (start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean =>
  start < rangeEnd && rangeStart < end;
