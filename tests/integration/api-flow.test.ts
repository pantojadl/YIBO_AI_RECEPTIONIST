import { afterEach, describe, expect, it } from "vitest";
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
});
