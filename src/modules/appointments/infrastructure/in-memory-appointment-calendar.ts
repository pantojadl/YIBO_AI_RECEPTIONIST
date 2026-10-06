import { failure, success } from "../../../shared/domain/result.js";
import type {
  AppointmentCalendarError,
  AppointmentCalendarPort,
} from "../ports/appointment-dependencies.js";

export class InMemoryAppointmentCalendar implements AppointmentCalendarPort {
  private readonly events = new Map<string, { idempotencyKey: string; appointmentId: string; startAt: string; endAt: string; etag: string; cancelled?: boolean }>();
  private nextFailure?: AppointmentCalendarError;
  private revision = 0;

  failNext(error: AppointmentCalendarError): void {
    this.nextFailure = error;
  }

  eventCount(): number {
    return [...this.events.values()].filter((event) => !event.cancelled).length;
  }

  async createEvent(command: Parameters<AppointmentCalendarPort["createEvent"]>[0]) {
    const error = this.consumeFailure();
    if (error) return failure<AppointmentCalendarError>(error);
    const existing = [...this.events.entries()].find(([, event]) => event.idempotencyKey === command.idempotencyKey);
    const externalEventId = existing?.[0] ?? `event-${this.events.size + 1}`;
    this.events.set(externalEventId, {
      idempotencyKey: command.idempotencyKey, appointmentId: command.appointmentId,
      startAt: command.startAt, endAt: command.endAt, etag: this.nextEtag(),
    });
    return success({ provider: "memory", externalEventId });
  }

  async rescheduleEvent(command: Parameters<AppointmentCalendarPort["rescheduleEvent"]>[0]) {
    const error = this.consumeFailure();
    if (error) return failure<AppointmentCalendarError>(error);
    if (!this.events.has(command.externalEventId)) return failure<AppointmentCalendarError>({ code: "EVENT_NOT_FOUND" });
    const event = this.events.get(command.externalEventId)!;
    if (command.expectedEtag && command.expectedEtag !== event.etag) return failure<AppointmentCalendarError>({ code: "NEEDS_RECONCILE" });
    this.events.set(command.externalEventId, { ...event, startAt: command.startAt, endAt: command.endAt, etag: this.nextEtag() });
    return success(undefined);
  }

  async cancelEvent(command: Parameters<AppointmentCalendarPort["cancelEvent"]>[0]) {
    const error = this.consumeFailure();
    if (error) return failure<AppointmentCalendarError>(error);
    const event = this.events.get(command.externalEventId);
    if (!event || event.cancelled) {
      return failure<AppointmentCalendarError>({ code: "EVENT_NOT_FOUND" });
    }
    if (command.expectedEtag && command.expectedEtag !== event.etag) return failure<AppointmentCalendarError>({ code: "NEEDS_RECONCILE" });
    this.events.set(command.externalEventId, { ...event, cancelled: true, etag: this.nextEtag() });
    return success(undefined);
  }

  async inspectEvent(command: Parameters<AppointmentCalendarPort["inspectEvent"]>[0]): ReturnType<AppointmentCalendarPort["inspectEvent"]> {
    const match = [...this.events.entries()].find(([id, event]) => !event.cancelled
      && event.appointmentId === command.appointmentId
      && (command.externalEventId === undefined || command.externalEventId === id));
    return success(match
      ? { present: true, externalEventId: match[0], startAt: match[1].startAt, endAt: match[1].endAt, etag: match[1].etag }
      : { present: false });
  }

  storedEvent(externalEventId: string): { startAt: string; endAt: string; etag: string } | undefined {
    const event = this.events.get(externalEventId);
    return event ? { startAt: event.startAt, endAt: event.endAt, etag: event.etag } : undefined;
  }

  /** Test seam: move a stored event without the service, the way a stale writer would. */
  overwriteTimes(externalEventId: string, startAt: string, endAt: string): void {
    const event = this.events.get(externalEventId);
    if (!event) return;
    this.events.set(externalEventId, { ...event, startAt, endAt, etag: this.nextEtag() });
  }

  private nextEtag(): string {
    this.revision += 1;
    return `etag-${this.revision}`;
  }

  private consumeFailure(): AppointmentCalendarError | undefined {
    const error = this.nextFailure;
    this.nextFailure = undefined;
    return error;
  }
}
