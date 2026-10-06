import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarAdapter, type CalendarAssignmentResolver, type GoogleOAuthService } from "../../src/modules/integrations/index.js";
import { normalizeDateTimeForTimezone } from "../../src/modules/scheduling/domain/time.js";

const calendarResolver = (calendarId: string, timezone: string): CalendarAssignmentResolver => ({
  resolve: async () => ({ ok: true, value: { calendarId, timezone, source: "location" } }),
});

describe("GoogleCalendarAdapter", () => {
  it("uses Google's FreeBusy endpoint with the configured calendar ID in the request body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      calendars: { "yibo-test@example.com": { busy: [{ start: "2026-08-24T15:00:00.000Z", end: "2026-08-24T15:30:00.000Z" }] } },
    }), { status: 200 }));
    const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "test-access-token" } as unknown as GoogleOAuthService;
    const adapter = new GoogleCalendarAdapter(calendarResolver("yibo-test@example.com", "America/Chicago"), oauth, fetcher);

    await expect(adapter.getBusyIntervals({
      tenantId: "tenant-1", locationId: "default", employeeId: "employee-1", rangeStart: "2026-08-24T00:00:00.000Z", rangeEnd: "2026-08-25T00:00:00.000Z",
    })).resolves.toEqual({ ok: true, value: [{ startAt: "2026-08-24T15:00:00.000Z", endAt: "2026-08-24T15:30:00.000Z" }] });
    expect(fetcher).toHaveBeenCalledWith(new URL("https://www.googleapis.com/calendar/v3/freeBusy"), expect.objectContaining({
      method: "POST", body: expect.stringContaining("yibo-test@example.com"),
    }));
  });

  it("writes an 11:00 AM Chicago appointment as 11:00 AM Central in Google Calendar", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "event-1" }), { status: 200 }));
    const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "test-access-token" } as unknown as GoogleOAuthService;
    const adapter = new GoogleCalendarAdapter(calendarResolver("yibo-test@example.com", "America/Chicago"), oauth, fetcher);

    await expect(adapter.createEvent({
      tenantId: "tenant-1", locationId: "default", appointmentId: "appointment-1", employeeId: "employee-1", title: "Consultation appointment", serviceName: "Consultation",
      patient: { name: "John Smith", phone: "915-555-1234" },
      startAt: "2026-08-24T16:00:00.000Z", endAt: "2026-08-24T16:30:00.000Z", idempotencyKey: "request-1",
    })).resolves.toEqual({ ok: true, value: { provider: "google-calendar", externalEventId: "event-1" } });

    const request = fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      start: { dateTime: "2026-08-24T11:00:00-05:00", timeZone: "America/Chicago" },
      end: { dateTime: "2026-08-24T11:30:00-05:00", timeZone: "America/Chicago" },
      summary: "Consultation — John Smith",
      description: "Service: Consultation\nPhone: ***1234",
    });
  });

  it("writes the exact 3:00 PM availability instant to Google without changing AM/PM", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "event-3pm" }), { status: 200 }));
    const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "test-access-token" } as unknown as GoogleOAuthService;
    const adapter = new GoogleCalendarAdapter(calendarResolver("yibo-test@example.com", "America/Denver"), oauth, fetcher);
    const selectedSlot = normalizeDateTimeForTimezone("2026-08-24T15:00", "America/Denver")!.toISOString();

    await adapter.createEvent({
      tenantId: "tenant-1", locationId: "default", appointmentId: "appointment-3pm", employeeId: "employee-1", title: "Consultation appointment", serviceName: "Consultation",
      startAt: selectedSlot, endAt: "2026-08-24T21:30:00.000Z", idempotencyKey: "request-3pm",
    });

    const event = JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
    expect(selectedSlot).toBe("2026-08-24T21:00:00.000Z");
    expect(event.start).toEqual({ dateTime: "2026-08-24T15:00:00-06:00", timeZone: "America/Denver" });
  });

  it("clearly marks a Developer Test Mode event without changing normal patient event titles", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "test-event" }), { status: 200 }));
    const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "test-access-token" } as unknown as GoogleOAuthService;
    const adapter = new GoogleCalendarAdapter(calendarResolver("yibo-test@example.com", "America/Denver"), oauth, fetcher);

    await adapter.createEvent({
      tenantId: "tenant-1", locationId: "default", appointmentId: "test-appointment", employeeId: "employee-1",
      title: "[YIBO TEST] Test Appointment", serviceName: "Consultation",
      patient: { name: "YIBO Test Patient", phone: "+15550000000" },
      startAt: "2026-08-24T21:00:00.000Z", endAt: "2026-08-24T21:30:00.000Z", idempotencyKey: "test-request",
    });

    const event = JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
    expect(event.summary).toBe("[YIBO TEST] Test Appointment");
  });

  it("uses each business's selected timezone when writing the same local appointment time", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "event-1" }), { status: 200 }));
    const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "test-access-token" } as unknown as GoogleOAuthService;
    const zones: Record<string, string> = { central: "America/Chicago", mountain: "America/Denver" };
    const adapter = new GoogleCalendarAdapter({
      resolve: async ({ tenantId }) => ({
        ok: true, value: { calendarId: "yibo-test@example.com", timezone: zones[tenantId]!, source: "location" },
      }),
    }, oauth, fetcher);

    await adapter.createEvent({ tenantId: "central", locationId: "default", appointmentId: "central-1", employeeId: "employee-1", title: "Consultation appointment", serviceName: "Consultation", startAt: "2026-08-24T16:00:00.000Z", endAt: "2026-08-24T16:30:00.000Z", idempotencyKey: "central-1" });
    await adapter.createEvent({ tenantId: "mountain", locationId: "default", appointmentId: "mountain-1", employeeId: "employee-1", title: "Consultation appointment", serviceName: "Consultation", startAt: "2026-08-24T17:00:00.000Z", endAt: "2026-08-24T17:30:00.000Z", idempotencyKey: "mountain-1" });

    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    const central = JSON.parse(String(posts[0]?.[1]?.body));
    const mountain = JSON.parse(String(posts[1]?.[1]?.body));
    expect(central.start).toEqual({ dateTime: "2026-08-24T11:00:00-05:00", timeZone: "America/Chicago" });
    expect(mountain.start).toEqual({ dateTime: "2026-08-24T11:00:00-06:00", timeZone: "America/Denver" });
  });

  it("distinguishes an unconnected calendar, expired authorization, and a Google API failure", async () => {
    const disconnected = new GoogleCalendarAdapter(calendarResolver("calendar@example.com", "America/Denver"), {
      status: async () => ({ configured: true, connected: false }), accessToken: async () => null,
    } as unknown as GoogleOAuthService);
    await expect(disconnected.getBusyIntervals({ tenantId: "tenant-1", locationId: "default", employeeId: "employee-1", rangeStart: "2026-08-24T00:00:00.000Z", rangeEnd: "2026-08-25T00:00:00.000Z" }))
      .resolves.toEqual({ ok: false, error: { code: "CALENDAR_NOT_CONNECTED" } });

    const expired = new GoogleCalendarAdapter(calendarResolver("calendar@example.com", "America/Denver"), {
      status: async () => ({ configured: true, connected: true }), accessToken: async () => null,
    } as unknown as GoogleOAuthService);
    await expect(expired.getBusyIntervals({ tenantId: "tenant-1", locationId: "default", employeeId: "employee-1", rangeStart: "2026-08-24T00:00:00.000Z", rangeEnd: "2026-08-25T00:00:00.000Z" }))
      .resolves.toEqual({ ok: false, error: { code: "AUTHORIZATION_REQUIRED" } });
  });

  it("reports a Google event-creation failure instead of returning a successful booking", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: "The calendar is temporarily unavailable" },
    }), { status: 503 }));
    const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "test-access-token" } as unknown as GoogleOAuthService;
    const adapter = new GoogleCalendarAdapter(calendarResolver("yibo-test@example.com", "America/Denver"), oauth, fetcher);

    await expect(adapter.createEvent({
      tenantId: "tenant-1", locationId: "default", appointmentId: "appointment-1", employeeId: "employee-1", title: "Cleaning appointment", serviceName: "Cleaning",
      startAt: "2026-08-24T17:00:00.000Z", endAt: "2026-08-24T17:45:00.000Z", idempotencyKey: "request-1",
    })).resolves.toEqual({ ok: false, error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
  });

  it("resolves the target for create and cancel and logs no calendar credentials or customer data", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ id: "event-safe", etag: "version-1", extendedProperties: { private: { yiboAppointmentId: "appointment-safe" } } }), { status: 200 });
    });
    const resolver: CalendarAssignmentResolver = {
      resolve: async ({ employeeId }) => ({
        ok: true,
        value: {
          calendarId: employeeId === "employee-2" ? "private-calendar@example.com" : "fallback@example.com",
          timezone: "America/Mexico_City",
          source: employeeId === "employee-2" ? "professional" : "location",
        },
      }),
    };
    const oauth = {
      status: async () => ({ configured: true, connected: true }), accessToken: async () => "secret-oauth-token",
    } as unknown as GoogleOAuthService;
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const adapter = new GoogleCalendarAdapter(resolver, oauth, fetcher);

    await adapter.createEvent({
      tenantId: "tenant-1", locationId: "north", employeeId: "employee-2", appointmentId: "appointment-safe",
      title: "Appointment", serviceName: "Private service", patient: { name: "Sensitive Name", phone: "+525512345678" },
      startAt: "2026-09-11T15:00:00.000Z", endAt: "2026-09-11T15:30:00.000Z", idempotencyKey: "safe-request",
    });
    await adapter.cancelEvent({
      tenantId: "tenant-1", locationId: "north", employeeId: "employee-2", appointmentId: "appointment-safe", externalEventId: "event-safe",
    });

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toContain("privateExtendedProperty=yiboOperationId%3D");
    expect(requests.slice(1)).toEqual([
      { url: "https://www.googleapis.com/calendar/v3/calendars/private-calendar%40example.com/events", method: "POST" },
      { url: "https://www.googleapis.com/calendar/v3/calendars/private-calendar%40example.com/events/event-safe", method: "GET" },
      { url: "https://www.googleapis.com/calendar/v3/calendars/private-calendar%40example.com/events/event-safe", method: "DELETE" },
    ]);
    const serializedLogs = logs.mock.calls.flat().join("\n");
    expect(serializedLogs).not.toContain("private-calendar@example.com");
    expect(serializedLogs).not.toContain("secret-oauth-token");
    expect(serializedLogs).not.toContain("Sensitive Name");
    expect(serializedLogs).not.toContain("12345678");
    logs.mockRestore();
  });

  it("reports a live Google event, a missing event, and an unreachable calendar separately", async () => {
    const scripted = new Map<string, number>();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const eventId = decodeURIComponent(url.split("/events/").at(-1) ?? "");
      const status = scripted.get(eventId) ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ error: { message: "calendar status" } }), { status });
      return new Response(JSON.stringify({
        id: eventId,
        status: "confirmed",
        extendedProperties: { private: { yiboAppointmentId: "appointment-inspect", yiboTenantId: "tenant-1" } },
      }), { status: 200 });
    });
    const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "test-access-token" } as unknown as GoogleOAuthService;
    const adapter = new GoogleCalendarAdapter(calendarResolver("yibo-test@example.com", "America/Denver"), oauth, fetcher);
    const command = { tenantId: "tenant-1", locationId: "default", employeeId: "employee-1", appointmentId: "appointment-inspect" };

    const present = await adapter.inspectEvent(command);
    expect(present.ok).toBe(true);
    if (!present.ok || !present.value.externalEventId) throw new Error("Expected the calendar event to be present");
    expect(present.value.present).toBe(true);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/events/");

    scripted.set(present.value.externalEventId, 404);
    await expect(adapter.inspectEvent({ ...command, externalEventId: present.value.externalEventId }))
      .resolves.toEqual({ ok: true, value: { present: false } });

    scripted.set(present.value.externalEventId, 500);
    await expect(adapter.inspectEvent({ ...command, externalEventId: present.value.externalEventId }))
      .resolves.toEqual({ ok: false, error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
  });
});
