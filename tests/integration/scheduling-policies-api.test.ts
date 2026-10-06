import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../../src/api/index.js";
import { buildApplication } from "../../src/bootstrap/index.js";
import type { LocationSchedulingPolicy } from "../../src/modules/business/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("scheduling policy API", () => {
  it("reads and replaces a validated location policy with optimistic concurrency", async () => {
    const app = buildApplication();
    server = await createApiServer(app);
    const admin = await createAdminTestSession(app, server);
    const current = await server.inject({
      method: "GET", url: "/api/admin/locations/default/scheduling-policy", headers: admin.readHeaders,
    });
    expect(current.statusCode).toBe(200);
    const snapshot = current.json<{ version: number; policy: LocationSchedulingPolicy }>();

    const policy: LocationSchedulingPolicy = {
      ...snapshot.policy,
      slotIncrementMinutes: 10,
      minimumLeadTimeMinutes: 90,
      maximumBookingHorizonDays: 45,
      maximumResults: 6,
      minimumCancellationNoticeMinutes: 180,
      minimumRescheduleNoticeMinutes: 240,
      concurrentCapacity: 2,
    };
    const updated = await server.inject({
      method: "PUT", url: "/api/admin/locations/default/scheduling-policy",
      headers: { ...admin.mutationHeaders, "if-match": `"${snapshot.version}"` }, payload: policy,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ version: 2, locationId: "default", policy });
    await expect(app.adminAudit.listByTenant(app.tenantId)).resolves.toEqual([
      expect.objectContaining({ entityType: "scheduling_policy", entityVersion: "2" }),
    ]);
  });

  it("rejects incomplete, unsupported and cross-catalog policies", async () => {
    const app = buildApplication();
    server = await createApiServer(app);
    const admin = await createAdminTestSession(app, server);
    const invalid = await server.inject({
      method: "PUT", url: "/api/admin/locations/default/scheduling-policy",
      headers: { ...admin.mutationHeaders, "if-match": '"1"' },
      payload: { defaultServiceId: "consultation", slotIncrementMinutes: 7 },
    });
    expect(invalid.statusCode).toBe(400);

    const current = await app.businessCatalog.getLocationPolicy(app.tenantId, "default");
    if (!current.ok) throw new Error("Expected policy");
    const unknownDefault = await server.inject({
      method: "PUT", url: "/api/admin/locations/default/scheduling-policy",
      headers: { ...admin.mutationHeaders, "if-match": '"1"' },
      payload: { ...current.value.policy, defaultServiceId: "other-tenant-service" },
    });
    expect(unknownDefault.statusCode).toBe(422);
    expect(unknownDefault.json<{ error: { code: string } }>().error.code).toBe("BUSINESS_CONFIGURATION_INVALID");
  });
});

it("round-trips expansion settings through existing policy edits and keeps concurrency protection", async () => {
  const app = buildApplication();
  server = await createApiServer(app);
  const admin = await createAdminTestSession(app, server);
  const path = "/api/admin/locations/default/scheduling-policy";
  const current = (await server.inject({ method: "GET", url: path, headers: admin.readHeaders })).json();
  const policy = { ...current.policy, availabilitySuggestions: { enabled: true, expansionDays: 2, maximumAlternatives: 3 } };
  const save = (version: number, body: unknown) => server!.inject({ method: "PUT", url: path, headers: { ...admin.mutationHeaders, "if-match": `"${version}"` }, payload: body as object });
  const added = await save(current.version, policy);
  expect(added.statusCode).toBe(200);
  const latest = (await server.inject({ method: "GET", url: path, headers: admin.readHeaders })).json();
  expect(latest.policy.availabilitySuggestions).toEqual(policy.availabilitySuggestions);
  const edited = await save(latest.version, { ...latest.policy, minimumLeadTimeMinutes: 60 });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().policy.availabilitySuggestions).toEqual(policy.availabilitySuggestions);
  expect((await save(latest.version, policy)).statusCode).toBe(409);
});

it("rejects malformed expansion settings without saving", async () => {
  const app = buildApplication();
  server = await createApiServer(app);
  const admin = await createAdminTestSession(app, server);
  const current = await app.businessCatalog.getLocationPolicy(app.tenantId, "default");
  if (!current.ok) throw new Error("Expected policy");
  for (const availabilitySuggestions of [null, { enabled: true }, { enabled: true, expansionDays: 15, maximumAlternatives: 3 }, { enabled: true, expansionDays: 1, maximumAlternatives: 3, unexpected: true }]) {
    const result = await server.inject({ method: "PUT", url: "/api/admin/locations/default/scheduling-policy", headers: { ...admin.mutationHeaders, "if-match": `"${current.value.version}"` }, payload: { ...current.value.policy, availabilitySuggestions } });
    expect(result.statusCode).toBe(400);
  }
  expect(await app.businessCatalog.getLocationPolicy(app.tenantId, "default")).toEqual(current);
});
