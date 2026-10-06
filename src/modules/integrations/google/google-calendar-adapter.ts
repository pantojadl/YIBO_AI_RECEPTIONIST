import { operationalLog } from "../../../shared/observability/operational-log.js";
import { createHash } from "node:crypto";
import { failure, success } from "../../../shared/domain/result.js";
import type { AppointmentCalendarPort, AppointmentCalendarError } from "../../appointments/index.js";
import type { BusyInterval, CalendarPort } from "../../scheduling/index.js";
import { dateTimeInTimezone } from "../../scheduling/domain/time.js";
import type { GoogleOAuthService } from "./google-oauth-service.js";
import type { CalendarAssignmentResolver } from "../calendar/calendar-assignment-resolver.js";

export class GoogleCalendarAdapter implements CalendarPort, AppointmentCalendarPort {
  constructor(
    private readonly calendars: CalendarAssignmentResolver,
    private readonly oauth: GoogleOAuthService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getBusyIntervals(query: { tenantId: string; locationId: string; employeeId: string; rangeStart: string; rangeEnd: string }) {
    const assignment = await this.calendars.resolve(query);
    if (!assignment.ok) return failure({ code: "CALENDAR_NOT_CONNECTED" as const });
    const token = await this.tokenFor(query.tenantId);
    if (!token.ok) return token;
    try {
      const { calendarId, timezone: timeZone } = assignment.value;
      googleLog("calendar.trace.google.availability.request", {
        tenantId: query.tenantId,
        locationId: query.locationId,
        employeeId: query.employeeId,
        assignmentSource: assignment.value.source,
        clinicTimezone: timeZone,
        rangeStart: traceDateTime(query.rangeStart, timeZone),
        rangeEnd: traceDateTime(query.rangeEnd, timeZone),
      });
      const response = await this.fetcher(new URL("https://www.googleapis.com/calendar/v3/freeBusy"), {
        method: "POST", headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json" },
        body: JSON.stringify({ timeMin: query.rangeStart, timeMax: query.rangeEnd, timeZone, items: [{ id: calendarId }] }),
      });
      if (!response.ok) return failure(providerError(response.status));
      const body = await response.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> };
      if (body.calendars?.[calendarId]?.errors?.length) return failure({ code: "PROVIDER_UNAVAILABLE" as const, retryable: false });
      const busy = body.calendars?.[calendarId]?.busy ?? [];
      googleLog("calendar.trace.google.availability.response", {
        tenantId: query.tenantId,
        locationId: query.locationId,
        employeeId: query.employeeId,
        busyIntervalCount: busy.length,
      });
      return success(busy.map(({ start, end }) => ({ startAt: start, endAt: end })) as BusyInterval[]);
    } catch { return failure({ code: "PROVIDER_UNAVAILABLE" as const, retryable: true }); }
  }

  async createEvent(command: { tenantId: string; locationId: string; appointmentId: string; employeeId: string; title: string; serviceName: string; patient?: { name?: string; phone: string }; startAt: string; endAt: string; idempotencyKey: string }) {
    const assignment = await this.calendars.resolve(command);
    if (!assignment.ok) return failure({ code: "CALENDAR_NOT_CONNECTED" as const });
    const token = await this.tokenFor(command.tenantId);
    if (!token.ok) return token;
    const externalEventId = googleEventId(command.tenantId, command.appointmentId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(assignment.value.calendarId)}/events`;
    try {
      const timeZone = assignment.value.timezone;
      const start = dateTimeInTimezone(new Date(command.startAt), timeZone);
      const end = dateTimeInTimezone(new Date(command.endAt), timeZone);
      googleLog("calendar.trace.google.adapter.input", {
        tenantId: command.tenantId,
        locationId: command.locationId,
        employeeId: command.employeeId,
        appointmentId: command.appointmentId,
        assignmentSource: assignment.value.source,
        clinicTimezone: timeZone,
        startAt: traceDateTime(command.startAt, timeZone),
        endAt: traceDateTime(command.endAt, timeZone),
      });
      googleLog("calendar.google.event.creating", {
        tenantId: command.tenantId,
        locationId: command.locationId,
        employeeId: command.employeeId,
        appointmentId: command.appointmentId,
        clinicTimezone: timeZone,
        normalizedLocalDateTime: start.dateTime,
        googleCalendarStart: start.dateTime,
        googleCalendarTimezone: timeZone,
        googleCalendarEnd: end.dateTime,
      });
      const operationId = googleOperationId(command.tenantId, command.idempotencyKey);
      const prior = await this.findByOperation(assignment.value.calendarId, token.value, operationId);
      if (prior === "error") return failure({ code: "PROVIDER_UNAVAILABLE" as const, retryable: true });
      if (prior) {
        if (!matchesTimes(prior, command)) return eventMismatch("The existing event has different appointment times.");
        if (prior.extendedProperties?.private?.yiboTenantId && prior.extendedProperties.private.yiboTenantId !== command.tenantId) {
          return eventMismatch("The calendar event does not belong to this appointment.");
        }
        googleLog("calendar.google.event.created", {
          tenantId: command.tenantId, locationId: command.locationId, employeeId: command.employeeId,
          appointmentId: command.appointmentId, externalEventId: prior.id, duplicate: true,
        });
        return success({ provider: "google-calendar", externalEventId: prior.id ?? externalEventId });
      }
      const response = await this.fetcher(url, {
        method: "POST", headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json", "x-goog-request-id": command.idempotencyKey },
        body: JSON.stringify({
          id: externalEventId,
          // Test appointments are intentionally recognizable in a connected calendar.
          // Normal patient appointments retain their existing, patient-friendly title.
          summary: command.title.startsWith("[YIBO TEST]")
            ? command.title
            : command.patient?.name ? `${command.serviceName} — ${command.patient.name}` : command.title,
          description: calendarDescription(command),
          // The appointment stores an instant in UTC. Supplying the clinic zone makes
          // the intended wall-clock time explicit to Google Calendar as well.
          start,
          end,
          extendedProperties: { private: {
            yiboAppointmentId: command.appointmentId,
            yiboTenantId: command.tenantId,
            yiboOperationId: operationId,
          } },
        }),
      });
      if (response.status === 409) {
        const existing = await this.readOwnedEvent({ ...command, externalEventId }, token.value, assignment.value.calendarId);
        if (!existing.ok) return existing;
        const foundOperation = existing.value.extendedProperties?.private?.yiboOperationId;
        if (foundOperation && foundOperation !== operationId) return eventMismatch("The existing event belongs to a different operation.");
        if (!matchesTimes(existing.value, command)) return eventMismatch("The existing event has different appointment times.");
        googleLog("calendar.google.event.created", {
          tenantId: command.tenantId, locationId: command.locationId, employeeId: command.employeeId,
          appointmentId: command.appointmentId, externalEventId, duplicate: true,
        });
        return success({ provider: "google-calendar", externalEventId });
      }
      if (!response.ok) {
        googleLog("calendar.google.event.failed", {
          tenantId: command.tenantId, locationId: command.locationId, employeeId: command.employeeId,
          appointmentId: command.appointmentId, httpStatus: response.status,
        });
        return failure(providerError(response.status));
      }
      const body = await response.json() as { id?: string };
      if (!body.id) {
        googleLog("calendar.google.event.failed", {
          tenantId: command.tenantId, locationId: command.locationId, employeeId: command.employeeId,
          appointmentId: command.appointmentId, failure: "missing_event_id",
        });
        return failure({ code: "VALIDATION_ERROR" as const, message: "Google Calendar did not return an event ID." });
      }
      googleLog("calendar.google.event.created", {
        tenantId: command.tenantId,
        locationId: command.locationId,
        employeeId: command.employeeId,
        appointmentId: command.appointmentId,
        externalEventId: body.id,
      });
      return success({ provider: "google-calendar", externalEventId: body.id });
    } catch {
      googleLog("calendar.google.event.failed", {
        tenantId: command.tenantId, locationId: command.locationId, employeeId: command.employeeId,
        appointmentId: command.appointmentId, failure: "network_or_response_error",
      });
      return failure({ code: "PROVIDER_UNAVAILABLE" as const, retryable: true });
    }
  }

  async rescheduleEvent(command: Parameters<AppointmentCalendarPort["rescheduleEvent"]>[0]) {
    if (!validTimes(command)) return eventMismatch("A valid appointment time range is required.");
    const assignment = await this.calendars.resolve(command);
    if (!assignment.ok) return failure({ code: "CALENDAR_NOT_CONNECTED" as const });
    const token = await this.tokenFor(command.tenantId);
    if (!token.ok) return token;
    try {
      const etag = command.expectedEtag ?? await this.currentEtag(command, token.value, assignment.value.calendarId);
      if (typeof etag !== "string") return etag;
      const timeZone = assignment.value.timezone;
      const response = await this.fetcher(this.eventUrl(command.externalEventId, assignment.value.calendarId), {
        method: "PATCH",
        headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json", "if-match": etag },
        // Preserve event identity, attendees, reminders, notes, and other fields.
        body: JSON.stringify({ start: dateTimeInTimezone(new Date(command.startAt), timeZone), end: dateTimeInTimezone(new Date(command.endAt), timeZone) }),
      });
      if (!response.ok) return failure<AppointmentCalendarError>(eventOperationError(response.status));
      const updated = await response.json() as GoogleEvent;
      if (updated.id !== command.externalEventId || updated.status === "cancelled" || !matchesTimes(updated, command)) {
        return eventMismatch("The calendar did not return the expected rescheduled event.");
      }
      return success(undefined);
    } catch {
      return failure<AppointmentCalendarError>({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    }
  }

  async cancelEvent(command: Parameters<AppointmentCalendarPort["cancelEvent"]>[0]) {
    const assignment = await this.calendars.resolve(command);
    if (!assignment.ok) return failure({ code: "CALENDAR_NOT_CONNECTED" as const });
    const token = await this.tokenFor(command.tenantId);
    if (!token.ok) return token;
    try {
      const etag = command.expectedEtag ?? await this.currentEtag(command, token.value, assignment.value.calendarId);
      if (typeof etag !== "string") return etag;
      const response = await this.fetcher(this.eventUrl(command.externalEventId, assignment.value.calendarId), {
        method: "DELETE", headers: { authorization: `Bearer ${token.value}`, "if-match": etag },
      });
      if (!response.ok) return failure<AppointmentCalendarError>(eventOperationError(response.status));
      return success(undefined);
    } catch {
      return failure<AppointmentCalendarError>({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    }
  }

  async inspectEvent(command: Parameters<AppointmentCalendarPort["inspectEvent"]>[0]): ReturnType<AppointmentCalendarPort["inspectEvent"]> {
    const assignment = await this.calendars.resolve(command);
    if (!assignment.ok) return failure({ code: "CALENDAR_NOT_CONNECTED" as const });
    const token = await this.tokenFor(command.tenantId);
    if (!token.ok) return token;
    const externalEventId = command.externalEventId ?? googleEventId(command.tenantId, command.appointmentId);
    try {
      const existing = await this.readOwnedEvent(
        { tenantId: command.tenantId, appointmentId: command.appointmentId, externalEventId },
        token.value,
        assignment.value.calendarId,
      );
      if (!existing.ok) {
        return existing.error.code === "EVENT_NOT_FOUND" ? success({ present: false }) : existing;
      }
      return success({
        present: true,
        externalEventId,
        ...(existing.value.etag ? { etag: existing.value.etag } : {}),
        ...(existing.value.start?.dateTime ? { startAt: existing.value.start.dateTime } : {}),
        ...(existing.value.end?.dateTime ? { endAt: existing.value.end.dateTime } : {}),
      });
    } catch {
      return failure<AppointmentCalendarError>({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    }
  }

  /** One read used only when the caller did not store an etag. A stored etag never reaches this method. */
  private async currentEtag(
    command: { tenantId: string; appointmentId: string; externalEventId: string },
    token: string,
    calendarId: string,
  ) {
    const existing = await this.readOwnedEvent(command, token, calendarId);
    if (!existing.ok) return existing;
    if (!existing.value.etag) return eventMismatch("The calendar event has no version identifier.");
    return existing.value.etag;
  }

  private async findByOperation(calendarId: string, token: string, operationId: string) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("privateExtendedProperty", `yiboOperationId=${operationId}`);
    url.searchParams.set("maxResults", "2");
    url.searchParams.set("showDeleted", "false");
    const response = await this.fetcher(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 404) return null;
    if (!response.ok) return "error" as const;
    const body = await response.json() as { items?: GoogleEvent[] };
    return (body.items ?? []).find((event) => event.status !== "cancelled"
      && event.extendedProperties?.private?.yiboOperationId === operationId) ?? null;
  }

  private eventUrl(externalEventId: string, calendarId: string): string {
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalEventId)}`;
  }

  private async readOwnedEvent(command: { tenantId: string; appointmentId: string; externalEventId: string }, token: string, calendarId: string) {
    const response = await this.fetcher(this.eventUrl(command.externalEventId, calendarId), { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return failure<AppointmentCalendarError>(eventOperationError(response.status));
    const event = await response.json() as GoogleEvent;
    if (event.status === "cancelled") return failure<AppointmentCalendarError>({ code: "EVENT_NOT_FOUND" });
    const identity = event.extendedProperties?.private;
    // Older YIBO events have only yiboAppointmentId. Preserve their persisted IDs
    // and accept that marker; new events additionally record the tenant.
    if (event.id !== command.externalEventId || identity?.yiboAppointmentId !== command.appointmentId
      || (identity.yiboTenantId !== undefined && identity.yiboTenantId !== command.tenantId)) {
      return eventMismatch("The calendar event does not belong to this appointment.");
    }
    return success(event);
  }

  private async tokenFor(tenantId: string) {
    const status = await this.oauth.status(tenantId);
    if (!status.configured || !status.connected) return failure({ code: "CALENDAR_NOT_CONNECTED" as const });
    const token = await this.oauth.accessToken(tenantId);
    return token ? success(token) : failure({ code: "AUTHORIZATION_REQUIRED" as const });
  }
}

const googleEventId = (tenantId: string, appointmentId: string): string =>
  `a${createHash("sha256").update(JSON.stringify([tenantId, appointmentId])).digest("hex")}`;

const googleOperationId = (tenantId: string, idempotencyKey: string): string =>
  createHash("sha256").update(JSON.stringify(["op", tenantId, idempotencyKey])).digest("hex");

interface GoogleEvent {
  id?: string;
  etag?: string;
  status?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  extendedProperties?: { private?: { yiboAppointmentId?: string; yiboTenantId?: string; yiboOperationId?: string } };
}
const validTimes = (command: { startAt: string; endAt: string }): boolean =>
  Number.isFinite(Date.parse(command.startAt)) && Number.isFinite(Date.parse(command.endAt)) && Date.parse(command.startAt) < Date.parse(command.endAt);
const matchesTimes = (event: GoogleEvent, command: { startAt: string; endAt: string }): boolean =>
  Date.parse(event.start?.dateTime ?? "") === Date.parse(command.startAt) && Date.parse(event.end?.dateTime ?? "") === Date.parse(command.endAt);
const eventMismatch = (message: string) => failure<AppointmentCalendarError>({ code: "VALIDATION_ERROR", message });
const eventOperationError = (status: number): AppointmentCalendarError => {
  if (status === 404 || status === 410) return { code: "EVENT_NOT_FOUND" };
  if (status === 412) return { code: "NEEDS_RECONCILE" };
  return providerError(status);
};

const providerError = (status: number) => {
  if (status === 401 || status === 403) return { code: "AUTHORIZATION_REQUIRED" as const };
  if (status === 429) return { code: "RATE_LIMITED" as const };
  return { code: "PROVIDER_UNAVAILABLE" as const, retryable: status >= 500 };
};

const calendarDescription = (command: { serviceName: string; patient?: { phone: string } }): string => [
  `Service: ${command.serviceName}`,
  ...(command.patient?.phone ? [`Phone: ${maskPhone(command.patient.phone)}`] : []),
].join("\n");

const maskPhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
};

const googleLog = operationalLog;

const traceDateTime = (value: string, timeZone: string) => {
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf())
    ? { input: value, invalid: true }
    : { input: value, iso: instant.toISOString(), ...dateTimeInTimezone(instant, timeZone) };
};
