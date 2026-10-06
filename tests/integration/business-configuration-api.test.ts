import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../../src/api/index.js";
import { buildApplication } from "../../src/bootstrap/index.js";
import type { EditableBusinessConfiguration } from "../../src/modules/business/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("business configuration API", () => {
  it("requires tenant-admin access and an explicit optimistic version", async () => {
    const app = buildApplication();
    server = await createApiServer(app);
    const operator = await createAdminTestSession(app, server, ["operator"]);
    const admin = await createAdminTestSession(app, server);

    const forbidden = await server.inject({
      method: "GET", url: "/api/admin/business-configuration", headers: operator.readHeaders,
    });
    expect(forbidden.statusCode).toBe(403);

    const current = await server.inject({
      method: "GET", url: "/api/admin/business-configuration", headers: admin.readHeaders,
    });
    expect(current.statusCode).toBe(200);
    expect(current.headers.etag).toBe('"1"');
    const document = current.json<{ version: number; configuration: EditableBusinessConfiguration }>();
    expect(document).toMatchObject({ version: 1, region: "MX", configuration: { name: "YIBO Demo Clinic" } });
    expect(document.configuration).not.toHaveProperty("tenantId");

    const missingPrecondition = await server.inject({
      method: "PUT",
      url: "/api/admin/business-configuration",
      headers: admin.mutationHeaders,
      payload: { configuration: document.configuration },
    });
    expect(missingPrecondition.statusCode).toBe(428);
    expect(missingPrecondition.json()).toEqual({ error: { code: "IF_MATCH_REQUIRED" } });

    const injectedTenant = await server.inject({
      method: "PUT",
      url: "/api/admin/business-configuration",
      headers: { ...admin.mutationHeaders, "if-match": '"1"' },
      payload: { configuration: { ...document.configuration, tenantId: "tenant-attacker" } },
    });
    expect(injectedTenant.statusCode).toBe(400);
    expect(injectedTenant.json()).toEqual({ error: { code: "UNTRUSTED_TENANT_SELECTOR" } });
  });

  it("updates once, audits it and rejects a stale writer without overwriting", async () => {
    const app = buildApplication();
    server = await createApiServer(app);
    const admin = await createAdminTestSession(app, server);
    const current = await server.inject({
      method: "GET", url: "/api/admin/business-configuration", headers: admin.readHeaders,
    });
    const document = current.json<{ version: number; configuration: EditableBusinessConfiguration }>();
    const configuration = {
      ...document.configuration,
      name: "YIBO Multi-location",
      businessId: "business-cannot-be-overwritten",
    };

    const updated = await server.inject({
      method: "PUT",
      url: "/api/admin/business-configuration",
      headers: { ...admin.mutationHeaders, "if-match": `"${document.version}"` },
      payload: { configuration },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(updated.json()).toMatchObject({
      version: 2,
      businessId: "business-yibo-demo",
      configuration: { name: "YIBO Multi-location" },
    });

    const stale = await server.inject({
      method: "PUT",
      url: "/api/admin/business-configuration",
      headers: { ...admin.mutationHeaders, "if-match": `"${document.version}"` },
      payload: { configuration: { ...configuration, name: "Stale overwrite" } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: { code: "CONFIGURATION_VERSION_CONFLICT", currentVersion: 2 },
    });

    const after = await app.business.getBusinessConfiguration(app.tenantId);
    expect(after).toMatchObject({
      ok: true,
      value: { version: 2, configuration: { name: "YIBO Multi-location" } },
    });
    await expect(app.adminAudit.listByTenant(app.tenantId)).resolves.toEqual([
      expect.objectContaining({ action: "replace_configuration", entityVersion: "2" }),
    ]);
  });
});

it("persists availability suggestions and the AI tool consumes the location policy", async () => {
  const app = buildApplication({ clock: { now: () => new Date("2026-08-01T00:00:00Z") } });
  server = await createApiServer(app);
  const admin = await createAdminTestSession(app, server);
  const current = await server.inject({ method: "GET", url: "/api/admin/business-configuration", headers: admin.readHeaders });
  const document = current.json<{ version: number; configuration: EditableBusinessConfiguration }>();
  const location = document.configuration.locations[0]!;
  location.policies.availabilitySuggestions = { enabled: true, expansionDays: 1, maximumAlternatives: 2 };
  location.openingHours = [{ dayOfWeek: 1, startTime: "09:00", endTime: "12:00" }];
  location.professionals.forEach(p => { p.openingHours = []; });
  const saved = await server.inject({ method: "PUT", url: "/api/admin/business-configuration", headers: { ...admin.mutationHeaders, "if-match": `"${document.version}"` }, payload: { configuration: document.configuration } });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().configuration.locations[0].policies.availabilitySuggestions).toEqual(location.policies.availabilitySuggestions);
  const result = await app.tools.execute({ tenantId: app.tenantId, locationId: location.id, callId: "suggestions-call", turnSequence: 1 }, { toolCallId: "suggestions", name: "check_availability", arguments: { rangeStart: "2026-08-10T08:00:00", rangeEnd: "2026-08-10T09:00:00" } });
  expect(result.ok).toBe(true); if (!result.ok) return;
  const data = result.data as { availableSlots: Array<{ outsideRequestedRange?: boolean; startAt: string }>; requestedPeriod: { endAt: string } };
  expect(data.availableSlots).toHaveLength(2);
  expect(data.availableSlots.every(s => s.outsideRequestedRange && s.startAt >= data.requestedPeriod.endAt)).toBe(true);
  const stale = await server.inject({ method: "PUT", url: "/api/admin/business-configuration", headers: { ...admin.mutationHeaders, "if-match": `"${document.version}"` }, payload: { configuration: document.configuration } });
  expect(stale.statusCode).toBe(409);
});
