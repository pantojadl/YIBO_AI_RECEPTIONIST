import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../../src/api/index.js";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("local API flow", () => {
  it("stores a valid business timezone through the dashboard API", async () => {
    const app = buildApplication();
    server = await createApiServer(app);
    const session = await createAdminTestSession(app, server);

    const updated = await server.inject({
      method: "PUT",
      url: "/api/business/timezone",
      headers: session.mutationHeaders,
      payload: { timezone: "America/Denver" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ timezone: "America/Denver" });

    const invalid = await server.inject({
      method: "PUT",
      url: "/api/business/timezone",
      headers: session.mutationHeaders,
      payload: { timezone: "Not/A-Timezone" },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("supports health, customer, availability, booking, refresh, conflict, and lookup", async () => {
    const app = buildApplication({ clock: { now: () => new Date("2026-08-01T00:00:00.000Z") } });
    server = await createApiServer(app);
    const session = await createAdminTestSession(app, server, ["operator"]);

    const health = await server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const customerResponse = await server.inject({
      method: "POST",
      url: "/api/customers",
      headers: session.mutationHeaders,
      payload: { phone: "+529991234567", name: "María Demo" },
    });
    expect(customerResponse.statusCode).toBe(200);
    const customer = customerResponse.json<{ id: string }>();

    const availabilityUrl = "/api/availability?serviceId=consultation&employeeId=employee-1" +
      "&rangeStart=2026-08-10T00%3A00%3A00.000Z&rangeEnd=2026-08-11T00%3A00%3A00.000Z";
    const availability = await server.inject({ method: "GET", url: availabilityUrl, headers: session.readHeaders });
    expect(availability.statusCode).toBe(200);
    const selected = availability.json<{ slots: Array<{ startAt: string; employeeId: string }> }>().slots[0];
    if (!selected) throw new Error("Expected an available slot");

    const appointmentResponse = await server.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { ...session.mutationHeaders, "idempotency-key": "api-flow-1" },
      payload: {
        customerId: customer.id,
        serviceId: "consultation",
        employeeId: selected.employeeId,
        startAt: selected.startAt,
      },
    });
    expect(appointmentResponse.statusCode).toBe(201);
    const appointment = appointmentResponse.json<{ id: string; status: string }>();
    expect(appointment.status).toBe("CONFIRMED");

    const replay = await server.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { ...session.mutationHeaders, "idempotency-key": "api-flow-1" },
      payload: {
        customerId: customer.id,
        serviceId: "consultation",
        employeeId: selected.employeeId,
        startAt: selected.startAt,
      },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ id: appointment.id, status: "CONFIRMED" });

    const refreshed = await server.inject({ method: "GET", url: availabilityUrl, headers: session.readHeaders });
    expect(refreshed.json<{ slots: Array<{ startAt: string }> }>().slots)
      .not.toContainEqual(expect.objectContaining({ startAt: selected.startAt }));

    const conflict = await server.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { ...session.mutationHeaders, "idempotency-key": "api-flow-conflict" },
      payload: {
        customerId: customer.id,
        serviceId: "consultation",
        employeeId: selected.employeeId,
        startAt: selected.startAt,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: { code: "SLOT_NO_LONGER_AVAILABLE" } });

    const lookup = await server.inject({
      method: "GET", url: `/api/appointments/${appointment.id}`, headers: session.readHeaders,
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ id: appointment.id, status: "CONFIRMED" });
  });

  it("requires a stable idempotency key for create, cancel, and reschedule and replays the stored change", async () => {
    const app = buildApplication({ clock: { now: () => new Date("2026-08-01T00:00:00.000Z") } });
    server = await createApiServer(app);
    const session = await createAdminTestSession(app, server, ["operator"]);
    const cancelEvents = vi.spyOn(app.calendar, "cancelEvent");
    const moveEvents = vi.spyOn(app.calendar, "rescheduleEvent");

    const missingCreate = await server.inject({
      method: "POST", url: "/api/appointments", headers: session.mutationHeaders,
      payload: { customerId: "unused", serviceId: "consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z" },
    });
    expect(missingCreate.statusCode).toBe(400);
    expect(missingCreate.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "An idempotency key is required" } });

    const customer = (await server.inject({
      method: "POST", url: "/api/customers", headers: session.mutationHeaders,
      payload: { phone: "+529991112233", name: "Idempotent Demo" },
    })).json<{ id: string }>();
    const availabilityUrl = "/api/availability?serviceId=consultation&employeeId=employee-1" +
      "&rangeStart=2026-08-10T00%3A00%3A00.000Z&rangeEnd=2026-08-11T00%3A00%3A00.000Z";
    const slots = (await server.inject({ method: "GET", url: availabilityUrl, headers: session.readHeaders }))
      .json<{ slots: Array<{ startAt: string; endAt: string; employeeId: string }> }>().slots;
    const selected = slots[0];
    const moved = slots.find((slot) => selected && (slot.endAt <= selected.startAt || slot.startAt >= selected.endAt));
    if (!selected || !moved) throw new Error("Expected a non-overlapping slot");

    const booked = await server.inject({
      method: "POST", url: "/api/appointments",
      headers: { ...session.mutationHeaders, "idempotency-key": "office-book-1" },
      payload: { customerId: customer.id, serviceId: "consultation", employeeId: selected.employeeId, startAt: selected.startAt },
    });
    expect(booked.statusCode).toBe(201);
    const appointment = booked.json<{ id: string; locationId: string }>();
    const cancelUrl = `/api/locations/${appointment.locationId}/appointments/${appointment.id}/cancel`;
    const moveUrl = `/api/locations/${appointment.locationId}/appointments/${appointment.id}/reschedule`;

    const missingCancel = await server.inject({ method: "POST", url: cancelUrl, headers: session.mutationHeaders, payload: {} });
    expect(missingCancel.statusCode).toBe(400);
    expect(missingCancel.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "An idempotency key is required" } });
    const missingMove = await server.inject({
      method: "POST", url: moveUrl, headers: session.mutationHeaders, payload: { startAt: moved.startAt },
    });
    expect(missingMove.statusCode).toBe(400);
    expect(missingMove.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "An idempotency key is required" } });

    const firstMove = await server.inject({
      method: "POST", url: moveUrl, headers: { ...session.mutationHeaders, "idempotency-key": "office-move-1" },
      payload: { startAt: moved.startAt },
    });
    expect(firstMove.statusCode).toBe(200);
    const movedAppointment = firstMove.json<{ id: string; startAt: string; version: number }>();
    const replayMove = await server.inject({
      method: "POST", url: moveUrl, headers: { ...session.mutationHeaders, "idempotency-key": "office-move-1" },
      payload: { startAt: moved.startAt },
    });
    expect(replayMove.statusCode).toBe(200);
    expect(replayMove.json()).toMatchObject({ id: movedAppointment.id, startAt: movedAppointment.startAt, version: movedAppointment.version });
    const conflictingMove = await server.inject({
      method: "POST", url: moveUrl, headers: { ...session.mutationHeaders, "idempotency-key": "office-move-1" },
      payload: { startAt: selected.startAt },
    });
    expect(conflictingMove.statusCode).toBe(409);
    expect(conflictingMove.json()).toEqual({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(moveEvents).toHaveBeenCalledTimes(1);

    const firstCancel = await server.inject({
      method: "POST", url: cancelUrl, headers: { ...session.mutationHeaders, "idempotency-key": "office-cancel-1" }, payload: {},
    });
    expect(firstCancel.statusCode).toBe(200);
    expect(firstCancel.json()).toMatchObject({ id: appointment.id, status: "CANCELLED" });
    const replayCancel = await server.inject({
      method: "POST", url: cancelUrl, headers: { ...session.mutationHeaders, "idempotency-key": "office-cancel-1", "if-match": "1" },
      payload: {},
    });
    expect(replayCancel.statusCode).toBe(200);
    expect(replayCancel.json()).toMatchObject({ id: appointment.id, status: "CANCELLED" });
    expect(cancelEvents).toHaveBeenCalledTimes(1);
  });
});
