import { describe, expect, it, vi } from "vitest";
import { phoneOperations, tool, booking, available, confirmContact } from "../helpers/phone-operations.js";

const blocked = { ok: false, error: { code: "CALENDAR_ROUTE_IN_USE" } };
describe("booked calendar routing through phone and Google boundaries", () => {
  it("rejects rerouting among several bookings, reschedules twice, cancels, then routes new bookings to the new calendar", async () => {
    const f = phoneOperations(50400);
    try {
      const first = await f.start();
      // Launch candidate: a voice booking before contact confirmation must not create a calendar event.
      expect(await tool(first, "create_appointment", booking)).toMatchObject({ ok: false, error: { code: "CONTACT_CONFIRMATION_REQUIRED" } });
      expect(f.events.size).toBe(0);
      expect(await confirmContact(first)).toMatchObject({ ok: true });
      // Main hardening: book only a slot that check_availability just verified.
      expect(await available(first)).toMatchObject({ ok: true });
      expect(await tool(first, "create_appointment", booking)).toMatchObject({ ok: true });
      const originalId = [...f.events.keys()][0]!;
      const second = await f.start("caller-2", "+12025550102");
      expect(await confirmContact(second, "02")).toMatchObject({ ok: true });
      expect(await available(second, "2026-09-21T18:00:00Z")).toMatchObject({ ok: true });
      expect(await tool(second, "create_appointment", { ...booking, startAt: "2026-09-21T18:00:00Z" })).toMatchObject({ ok: true });
      const neighbor = structuredClone([...f.events.values()].find(event => event.id !== originalId)!);
      const change = () => f.app.businessCatalog.updateLocationDefaultCalendar(f.app.tenantId, "default", "new@example.test", 1);
      expect(await change()).toEqual(blocked);
      expect(await tool(first, "list_customer_appointments")).toMatchObject({ ok: true });
      for (const startAt of ["2026-09-21T16:30:00Z", "2026-09-21T17:00:00Z"]) {
        expect(await tool(first, "reschedule_appointment", { appointmentReference: "upcoming-1", startAt })).toMatchObject({ ok: true });
        expect(f.events.size).toBe(2);
        expect(f.events.get(neighbor.id)).toEqual(neighbor);
        expect(Date.parse(f.events.get(originalId)!.start.dateTime)).toBe(Date.parse(startAt));
        const stored = await f.appointments.findById(f.app.tenantId, (f.events.get(originalId)!.extendedProperties as { private: { yiboAppointmentId: string } }).private.yiboAppointmentId);
        expect(stored?.externalCalendarEventId).toBe(originalId);
      }
      expect(await tool(first, "cancel_appointment", { appointmentReference: "upcoming-1" })).toMatchObject({ ok: true });
      expect(await change()).toEqual(blocked);
      expect(await tool(second, "list_customer_appointments")).toMatchObject({ ok: true });
      expect(await tool(second, "cancel_appointment", { appointmentReference: "upcoming-1" })).toMatchObject({ ok: true });
      expect(f.events.size).toBe(0);
      expect(await change()).toMatchObject({ ok: true, value: { version: 2 } });
      // Re-verify the new instant. An earlier check_availability stores requestedStartAt for this call
      // and would otherwise override this later booking.
      expect(await available(first, "2026-09-21T19:00:00Z")).toMatchObject({ ok: true });
      expect(await tool(first, "create_appointment", { ...booking, startAt: "2026-09-21T19:00:00Z" })).toMatchObject({ ok: true });
      expect(f.events.size).toBe(1);
      const createdId = [...f.events.keys()][0]!;
      expect(Date.parse(f.events.get(createdId)!.start.dateTime)).toBe(Date.parse("2026-09-21T19:00:00Z"));
      expect(f.eventCalendars.get(createdId)).toBe("new@example.test");
      expect(f.fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/events") && init?.method === "POST")).toHaveLength(3);
    } finally { await f.close(); }
  });

  it("blocks a mapping change while Google's create is in flight", async () => {
    const f = phoneOperations(50400);
    let release!: () => void;
    f.controls.holdCreate = new Promise<void>(resolve => { release = resolve; });
    try {
      const session = await f.start();
      expect(await confirmContact(session)).toMatchObject({ ok: true });
      expect(await available(session)).toMatchObject({ ok: true });
      const pending = tool(session, "create_appointment", booking);
      await vi.waitFor(() => expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/events"))).toBe(true));
      expect(await f.app.businessCatalog.updateProfessionalCalendar(f.app.tenantId, "default", "employee-us-1", "other@example.test", 1)).toEqual(blocked);
      release();
      expect(await pending).toMatchObject({ ok: true });
      expect(f.events.size).toBe(1);
      expect([...f.eventCalendars.values()]).toEqual(["operations@example.test"]);
    } finally { release(); await f.close(); }
  });
});
