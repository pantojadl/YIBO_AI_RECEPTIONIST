import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarAdapter, type GoogleOAuthService } from "../../src/modules/integrations/index.js";

const command = {
  tenantId: "tenant-1", locationId: "north", employeeId: "professional-1", appointmentId: "appointment-20260915x",
  title: "Consultation", serviceName: "Consultation", startAt: "2026-09-15T16:00:00.000Z",
  endAt: "2026-09-15T16:30:00.000Z", idempotencyKey: "booking-1",
};
function fixture() {
  const events = new Map<string, any>();
  let revision = 0;
  let rejectUpdate = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const id = method === "POST" ? body.id : url.split("/").at(-1)!;
    if (method === "POST") {
      if (events.has(id)) return new Response(null, { status: 409 });
      events.set(id, { ...body, etag: String(++revision) });
    } else if (!events.has(id)) return new Response(null, { status: 404 });
    else if (method === "PATCH" || method === "DELETE") {
      if (rejectUpdate || new Headers(init?.headers).get("if-match") !== events.get(id).etag) {
        return new Response(null, { status: 412 });
      }
      if (method === "DELETE") { events.delete(id); return new Response(null, { status: 204 }); }
      events.set(id, { ...events.get(id), ...body, etag: String(++revision) });
    }
    return new Response(JSON.stringify(events.get(id)));
  });
  const resolver = { resolve: vi.fn(async () => ({ ok: true as const, value: {
    calendarId: "professional@example.com", timezone: "America/Denver", source: "professional" as const,
  } })) };
  const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "test" } as unknown as GoogleOAuthService;
  const adapter = new GoogleCalendarAdapter(resolver, oauth, fetcher);
  return { adapter, events, fetcher, resolver, conflict: () => { rejectUpdate = true; } };
}
async function book(value: ReturnType<typeof fixture>, input = command) {
  const created = await value.adapter.createEvent(input);
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return created.value.externalEventId;
}

describe("Google event identity across rescheduling", () => {
  it("distinguishes IDs that the old hexadecimal filter collapsed and scopes them by tenant", async () => {
    const value = fixture();
    const ids = ["appointment-20260915x", "appointment-20260915y", "appointment-20260915z"];
    expect(new Set(ids.map((id) => id.replace(/[^0-9a-f]/gi, ""))).size).toBe(1);
    for (const appointmentId of ids) await book(value, { ...command, appointmentId });
    await book(value, { ...command, tenantId: "tenant-2" });
    expect(value.events.size).toBe(4);
    for (const id of value.events.keys()) expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("reschedules the selected event repeatedly among similar bookings and cancels that same ID", async () => {
    const value = fixture();
    const original = await book(value);
    const neighbor = await book(value, { ...command, appointmentId: "appointment-20260915y", idempotencyKey: "booking-2" });
    const untouched = structuredClone(value.events.get(neighbor));
    for (const day of [16, 17, 18]) {
      const startAt = `2026-09-${day}T17:00:00.000Z`;
      const endAt = `2026-09-${day}T17:30:00.000Z`;
      await expect(value.adapter.rescheduleEvent({ ...command, externalEventId: original, startAt, endAt }))
        .resolves.toEqual({ ok: true, value: undefined });
      expect(value.events.size).toBe(2);
      expect(value.events.get(original).id).toBe(original);
      expect(Date.parse(value.events.get(original).start.dateTime)).toBe(Date.parse(startAt));
      expect(value.events.get(original).start.timeZone).toBe("America/Denver");
      expect(value.events.get(neighbor)).toEqual(untouched);
    }
    expect(value.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(value.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    await expect(value.adapter.cancelEvent({ ...command, externalEventId: original })).resolves.toEqual({ ok: true, value: undefined });
    expect([...value.events.keys()]).toEqual([neighbor]);
    expect(value.resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ locationId: "north", employeeId: "professional-1" }));
    expect(value.fetcher.mock.calls.every(([url]) => String(url).includes("professional%40example.com"))).toBe(true);
  });

  it("does not treat duplicate creation at a different time as success", async () => {
    const value = fixture();
    const id = await book(value);
    const before = structuredClone(value.events.get(id));
    await expect(value.adapter.createEvent({ ...command, startAt: "2026-09-16T16:00:00.000Z", endAt: "2026-09-16T16:30:00.000Z" }))
      .resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(value.events.get(id)).toEqual(before);
  });

  it("accepts a genuine create retry only after verifying ownership and time", async () => {
    const value = fixture();
    const id = await book(value);
    expect(await book(value)).toBe(id);
    expect(value.events.size).toBe(1);
  });

  it.each(["rescheduleEvent", "cancelEvent"] as const)("rejects a mismatched appointment before %s mutates anything", async (operation) => {
    const value = fixture();
    const id = await book(value);
    await expect(value.adapter[operation]({ ...command, appointmentId: "wrong-appointment", externalEventId: id }))
      .resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(value.fetcher.mock.calls.some(([, init]) => ["PATCH", "DELETE"].includes(init?.method ?? ""))).toBe(false);
    expect(value.events.size).toBe(1);
  });

  it("preserves legacy stored IDs while checking the legacy appointment marker", async () => {
    const value = fixture();
    value.events.set("legacy123", { id: "legacy123", etag: "old", extendedProperties: { private: { yiboAppointmentId: command.appointmentId } } });
    await expect(value.adapter.rescheduleEvent({ ...command, externalEventId: "legacy123" })).resolves.toEqual({ ok: true, value: undefined });
    expect([...value.events.keys()]).toEqual(["legacy123"]);
  });

  it("rejects concurrent provider edits without replacing or deleting the event", async () => {
    const value = fixture();
    const id = await book(value);
    const before = structuredClone(value.events.get(id));
    value.conflict();
    await expect(value.adapter.rescheduleEvent({ ...command, externalEventId: id }))
      .resolves.toMatchObject({ ok: false, error: { code: "NEEDS_RECONCILE" } });
    expect(value.events.get(id)).toEqual(before);
  });
});
