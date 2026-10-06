import { isAvailabilitySuggestionsPolicy } from "../../modules/business/domain/multi-location-business.js";
import type { FastifyInstance } from "fastify";
import type { YiboApplication } from "../../bootstrap/index.js";
import {
  SLOT_INCREMENT_MINUTES,
  type LocationSchedulingPolicy,
} from "../../modules/business/index.js";
import { adminPrincipalFor, createAdminGuard } from "../admin-guard.js";
import { requireVersion, sendCatalogError } from "./business-services.js";

export async function registerSchedulingPolicyRoutes(server: FastifyInstance, app: YiboApplication): Promise<void> {
  server.get<{ Params: { locationId: string } }>(
    "/api/admin/locations/:locationId/scheduling-policy",
    { preHandler: createAdminGuard(app, "tenant_admin") },
    async (request, reply) => {
      const result = await app.businessCatalog.getLocationPolicy(app.tenantId, request.params.locationId);
      return result.ok
        ? reply.header("etag", `"${result.value.version}"`).send(result.value)
        : sendCatalogError(reply, result.error);
    },
  );

  server.put<{ Params: { locationId: string }; Body: unknown }>(
    "/api/admin/locations/:locationId/scheduling-policy",
    { preHandler: createAdminGuard(app, "tenant_admin") },
    async (request, reply) => {
      const version = requireVersion(request.headers["if-match"], reply);
      if (version === null) return;
      const policy = parsePolicy(request.body);
      if (!policy) return reply.code(400).send({ error: { code: "INVALID_SCHEDULING_POLICY" } });
      const before = await app.businessCatalog.getLocationPolicy(app.tenantId, request.params.locationId);
      const result = await app.businessCatalog.updateLocationPolicy(
        app.tenantId, request.params.locationId, policy, version,
      );
      if (!result.ok) return sendCatalogError(reply, result.error);
      await app.adminAudit.recordMutation({
        principal: adminPrincipalFor(request), entityType: "scheduling_policy", entityId: request.params.locationId,
        action: "update", entityVersion: result.value.version,
        before: before.ok ? before.value.policy : undefined, after: result.value.policy,
      });
      return reply.header("etag", `"${result.value.version}"`).send(result.value);
    },
  );
}

const parsePolicy = (value: unknown): LocationSchedulingPolicy | null => {
  if (!isRecord(value)) return null;
  const keys: Array<keyof LocationSchedulingPolicy> = [
    "defaultServiceId", "slotIncrementMinutes", "minimumLeadTimeMinutes", "maximumBookingHorizonDays",
    "maximumResults", "minimumCancellationNoticeMinutes", "minimumRescheduleNoticeMinutes", "concurrentCapacity",
  ];
  const suggestions = value.availabilitySuggestions;
  if (suggestions !== undefined && !isAvailabilitySuggestionsPolicy(suggestions)) return null;
  if (keys.some(key => !(key in value)) || Object.keys(value).some((key) => key !== "availabilitySuggestions" && !keys.includes(key as keyof LocationSchedulingPolicy))
    || typeof value.defaultServiceId !== "string" || !value.defaultServiceId.trim()
    || !(SLOT_INCREMENT_MINUTES as readonly unknown[]).includes(value.slotIncrementMinutes)) return null;
  for (const key of keys.slice(2) as Array<Exclude<keyof LocationSchedulingPolicy, "defaultServiceId" | "slotIncrementMinutes">>) {
    const minimum = ["maximumBookingHorizonDays", "maximumResults", "concurrentCapacity"].includes(key) ? 1 : 0;
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < minimum) return null;
  }
  return {
    ...(suggestions === undefined ? {} : { availabilitySuggestions: suggestions }),
    defaultServiceId: value.defaultServiceId.trim(),
    slotIncrementMinutes: value.slotIncrementMinutes as LocationSchedulingPolicy["slotIncrementMinutes"],
    minimumLeadTimeMinutes: Number(value.minimumLeadTimeMinutes),
    maximumBookingHorizonDays: Number(value.maximumBookingHorizonDays),
    maximumResults: Number(value.maximumResults),
    minimumCancellationNoticeMinutes: Number(value.minimumCancellationNoticeMinutes),
    minimumRescheduleNoticeMinutes: Number(value.minimumRescheduleNoticeMinutes),
    concurrentCapacity: Number(value.concurrentCapacity),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
