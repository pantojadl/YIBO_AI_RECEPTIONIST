import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../../src/api/index.js";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("admin authentication API", () => {
  it("logs in with an HttpOnly session, returns the principal and revokes it", async () => {
    const app = buildApplication({ adminSessionSecret: "a-development-test-secret-that-is-long-enough" });
    await app.adminAuth.credentials.create({
      tenantId: app.tenantId,
      email: "admin@yibo.example",
      password: "a-secure-password",
      roles: ["tenant_admin"],
    });
    server = await createApiServer(app);

    const login = await server.inject({
      method: "POST", url: "/api/auth/login",
      headers: { origin: app.config.dashboardOrigin },
      payload: { email: "admin@yibo.example", password: "a-secure-password" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ principal: {
      tenantId: app.tenantId,
      roles: ["tenant_admin"],
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
    } });
    const cookie = login.headers["set-cookie"];
    expect(cookie).toContain("yibo_admin_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const me = await server.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ principal: {
      tenantId: app.tenantId,
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
    } });

    const logout = await server.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { cookie, origin: app.config.dashboardOrigin },
    });
    expect(logout.statusCode).toBe(200);
    const rejected = await server.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(rejected.statusCode).toBe(401);
  });

  it("returns the same safe error for unknown users and wrong passwords", async () => {
    const app = buildApplication();
    server = await createApiServer(app);
    for (const email of ["missing@yibo.example", "admin@yibo.example"]) {
      const response = await server.inject({
        method: "POST", url: "/api/auth/login",
        headers: { origin: app.config.dashboardOrigin },
        payload: { email, password: "wrong-password-value" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "INVALID_CREDENTIALS" } });
    }
  });

  it("rejects untrusted origins and tenant selectors before a protected mutation", async () => {
    const app = buildApplication({ adminSessionSecret: "a-development-test-secret-that-is-long-enough" });
    const identity = await app.adminAuth.credentials.create({
      tenantId: app.tenantId,
      email: "operator@yibo.example",
      password: "a-secure-password",
      roles: ["operator"],
    });
    server = await createApiServer(app);

    const wrongOrigin = await server.inject({
      method: "POST", url: "/api/auth/login",
      headers: { origin: "https://attacker.example" },
      payload: { email: identity.email, password: "a-secure-password" },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const login = await server.inject({
      method: "POST", url: "/api/auth/login",
      headers: { origin: app.config.dashboardOrigin },
      payload: { email: identity.email, password: "a-secure-password" },
    });
    const cookie = login.headers["set-cookie"];
    const missingOrigin = await server.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json()).toEqual({ error: { code: "ORIGIN_NOT_ALLOWED" } });

    const selectedTenant = await server.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { cookie, origin: app.config.dashboardOrigin },
      payload: { tenantId: "tenant-other" },
    });
    expect(selectedTenant.statusCode).toBe(400);
    expect(selectedTenant.json()).toEqual({ error: { code: "UNTRUSTED_TENANT_SELECTOR" } });
  });

  it("rejects nested tenant/region selectors without revoking the valid session", async () => {
    const app = buildApplication();
    server = await createApiServer(app);
    const session = await createAdminTestSession(app, server, ["tenant_admin"]);
    for (const key of ["tenantId", "tenant_id", "regionId", "region_id"]) {
      const response = await server.inject({ method: "POST", url: "/api/auth/logout",
        headers: session.mutationHeaders, payload: { nested: [{ [key]: "foreign" }] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: "UNTRUSTED_TENANT_SELECTOR" } });
    }
    expect((await server.inject({ method: "GET", url: "/api/auth/me", headers: session.readHeaders })).statusCode).toBe(200);
  });

  it("rejects a valid session issued for another tenant", async () => {
    const app = buildApplication({ adminSessionSecret: "a-development-test-secret-that-is-long-enough" });
    server = await createApiServer(app);
    const now = new Date();
    const token = await app.adminAuth.sessions.issue({
      subject: "other-admin", tenantId: "tenant-other", roles: ["tenant_admin"], now,
      expiresAt: new Date(now.valueOf() + 60_000),
    });
    const response = await server.inject({
      method: "POST", url: "/api/auth/logout",
      headers: {
        origin: app.config.dashboardOrigin,
        cookie: `yibo_admin_session=${encodeURIComponent(token)}`,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: "TENANT_ACCESS_DENIED" } });
  });

  it("does not return a booked appointment to a session from another business", async () => {
    const app = buildApplication({
      clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
      adminSessionSecret: "a-development-test-secret-that-is-long-enough",
    });
    server = await createApiServer(app);
    const operator = await createAdminTestSession(app, server, ["operator"]);
    const customer = await server.inject({
      method: "POST", url: "/api/customers", headers: operator.mutationHeaders,
      payload: { phone: "+15555550123", name: "Owner Patient" },
    });
    expect(customer.statusCode).toBe(200);
    const availability = await server.inject({
      method: "GET",
      url: "/api/availability?serviceId=consultation&employeeId=employee-1&rangeStart=2026-08-10T00%3A00%3A00.000Z&rangeEnd=2026-08-11T00%3A00%3A00.000Z",
      headers: operator.readHeaders,
    });
    const slot = availability.json<{ slots: Array<{ startAt: string; employeeId: string }> }>().slots[0];
    if (!slot) throw new Error("Expected an available slot");
    const booked = await server.inject({
      method: "POST", url: "/api/appointments",
      headers: { ...operator.mutationHeaders, "idempotency-key": "tenant-a-book" },
      payload: {
        customerId: customer.json<{ id: string }>().id,
        serviceId: "consultation",
        employeeId: slot.employeeId,
        startAt: slot.startAt,
      },
    });
    expect(booked.statusCode).toBe(201);
    const appointmentId = booked.json<{ id: string }>().id;
    const now = new Date();
    const foreign = await app.adminAuth.sessions.issue({
      subject: "other-admin", tenantId: "tenant-other", roles: ["operator"], now,
      expiresAt: new Date(now.valueOf() + 60_000),
    });
    const response = await server.inject({
      method: "GET", url: `/api/appointments/${appointmentId}`,
      headers: { cookie: `yibo_admin_session=${encodeURIComponent(foreign)}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: "TENANT_ACCESS_DENIED" } });
    expect(JSON.stringify(response.json())).not.toContain(appointmentId);
  });

  it("enforces tenant-admin configuration and operator workflow permissions", async () => {
    const app = buildApplication();
    server = await createApiServer(app);
    const operator = await createAdminTestSession(app, server, ["operator"]);

    const operationalRead = await server.inject({
      method: "GET", url: "/api/business", headers: operator.readHeaders,
    });
    expect(operationalRead.statusCode).toBe(200);

    const configuration = await server.inject({
      method: "GET", url: "/api/configuration", headers: operator.readHeaders,
    });
    expect(configuration.statusCode).toBe(403);
    expect(configuration.json()).toEqual({ error: { code: "ROLE_REQUIRED" } });

    const businessMutation = await server.inject({
      method: "PUT",
      url: "/api/business/timezone",
      headers: operator.mutationHeaders,
      payload: { timezone: "America/Mexico_City" },
    });
    expect(businessMutation.statusCode).toBe(403);

    const unauthenticated = await server.inject({ method: "GET", url: "/api/business" });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
