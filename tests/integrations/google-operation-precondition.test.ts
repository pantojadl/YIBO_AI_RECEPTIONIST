import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarAdapter, type GoogleOAuthService } from "../../src/modules/integrations/index.js";

const oauth = {
  status: async () => ({ configured: true, connected: true }),
  accessToken: async () => "test-access-token",
} as unknown as GoogleOAuthService;

const resolver = {
  resolve: async () => ({ ok: true as const, value: { calendarId: "clinic@example.com", timezone: "UTC", source: "location" as const } }),
};

const operationId = (tenantId: string, idempotencyKey: string) =>
  createHash("sha256").update(JSON.stringify(["op", tenantId, idempotencyKey])).digest("hex");

describe("Google If-Match and create operation id", () => {
  it("stores no second read when the caller passes the intent etag, and 412 is NEEDS_RECONCILE", async () => {
    const events = new Map<string, { id: string; etag: string; start: { dateTime: string }; end: { dateTime: string }; extendedProperties: unknown }>();
    events.set("event-1", {
      id: "event-1", etag: "original",
      start: { dateTime: "2026-08-10T15:00:00.000Z" }, end: { dateTime: "2026-08-10T15:30:00.000Z" },
      extendedProperties: { private: { yiboAppointmentId: "appointment-1", yiboTenantId: "tenant-a" } },
    });
    const gets: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        gets.push(String(input));
        return new Response(JSON.stringify(events.get("event-1")), { status: 200 });
      }
      const match = new Headers(init?.headers).get("if-match");
      if (match !== events.get("event-1")?.etag) return new Response(null, { status: 412 });
      return new Response(JSON.stringify({ ...events.get("event-1"), ...JSON.parse(String(init?.body)) }), { status: 200 });
    });
    const adapter = new GoogleCalendarAdapter(resolver, oauth, fetcher);
    const command = {
      tenantId: "tenant-a", locationId: "default", employeeId: "employee-1", appointmentId: "appointment-1",
      externalEventId: "event-1", startAt: "2026-08-11T16:00:00.000Z", endAt: "2026-08-11T16:30:00.000Z",
      expectedEtag: "original",
    };
    await expect(adapter.rescheduleEvent(command)).resolves.toEqual({ ok: true, value: undefined });
    expect(gets).toEqual([]);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("if-match")).toBe("original");

    events.set("event-1", { ...events.get("event-1")!, etag: "replaced" });
    await expect(adapter.rescheduleEvent(command)).resolves.toEqual({ ok: false, error: { code: "NEEDS_RECONCILE" } });
    expect(gets).toEqual([]);
    expect(events.get("event-1")?.etag).toBe("replaced");
  });

  it("deduplicates create by the private operation id", async () => {
    const events = new Map<string, Record<string, unknown>>();
    const posts: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      const query = url.searchParams.get("privateExtendedProperty");
      if (method === "GET" && query?.startsWith("yiboOperationId=")) {
        const id = query.slice("yiboOperationId=".length);
        const found = [...events.values()].filter((event) =>
          (event.extendedProperties as { private?: { yiboOperationId?: string } } | undefined)?.private?.yiboOperationId === id);
        return new Response(JSON.stringify({ items: found }), { status: 200 });
      }
      if (method === "POST" && body) {
        posts.push(String(body.id));
        events.set(String(body.id), { ...body, id: body.id, etag: "1", status: "confirmed" });
        return new Response(JSON.stringify(events.get(String(body.id))), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = new GoogleCalendarAdapter(resolver, oauth, fetcher);
    const first = {
      tenantId: "tenant-a", locationId: "default", employeeId: "employee-1", appointmentId: "appointment-1",
      title: "Consultation", serviceName: "Consultation", startAt: "2026-08-10T15:00:00.000Z",
      endAt: "2026-08-10T15:30:00.000Z", idempotencyKey: "book-1",
    };
    const created = await adapter.createEvent(first);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const replay = await adapter.createEvent({ ...first, appointmentId: "appointment-2" });
    expect(replay).toEqual(created);
    expect(posts).toHaveLength(1);
    const stored = [...events.values()][0] as { extendedProperties?: { private?: { yiboOperationId?: string } } };
    expect(stored.extendedProperties?.private?.yiboOperationId).toBe(operationId("tenant-a", "book-1"));
  });
});
