import { parseIfMatch } from "../optimistic-version.js";
import type { FastifyInstance } from "fastify";
import type { YiboApplication } from "../../bootstrap/index.js";
import { adminPrincipalFor, createAdminGuard } from "../admin-guard.js";
import { toHttpError } from "../http-errors.js";
import { DEFAULT_AVAILABILITY_SUGGESTIONS } from "../../modules/business/domain/multi-location-business.js";

interface AppointmentBody {
  locationId?: unknown;
  customerId?: unknown;
  serviceId?: unknown;
  employeeId?: unknown;
  startAt?: unknown;
}

export async function registerAppointmentRoutes(server: FastifyInstance, app: YiboApplication): Promise<void> {
  server.get<{ Querystring: { locationId?: string; rangeStart?: string; rangeEnd?: string; employeeId?: string;
    serviceId?: string; status?: string } }>("/api/office/schedule", { preHandler: createAdminGuard(app, "operator") },
    async (request, reply) => {
      const { locationId, rangeStart, rangeEnd, employeeId, serviceId, status } = request.query;
      if (!locationId || !rangeStart || !rangeEnd || Number.isNaN(Date.parse(rangeStart))
        || Number.isNaN(Date.parse(rangeEnd)) || rangeStart >= rangeEnd) {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      }
      const appointments = await app.appointments.listAppointments({ tenantId: app.tenantId, locationId,
        rangeStart, rangeEnd, ...(employeeId ? { employeeId } : {}), ...(serviceId ? { serviceId } : {}),
        ...(status ? { status } : {}) });
      let slots: Array<{ employeeId: string; startAt: string; endAt: string }> = [];
      if (serviceId) {
        const available = await app.scheduling.findAvailableSlots({ tenantId: app.tenantId, locationId,
          serviceId, ...(employeeId ? { employeeId } : {}), rangeStart, rangeEnd, limit: 500 });
        if (available.ok) slots = available.value;
      }
      return { appointments, slots };
    });
  // Operator-safe metadata, using the same tenant-owned configuration as scheduling.
  server.get("/api/appointment-locations", { preHandler: createAdminGuard(app, "operator") }, async (_request, reply) => {
    const result = await app.business.getBusinessConfiguration(app.tenantId);
    if (!result.ok) { const error = toHttpError(result.error); return reply.code(error.statusCode).send(error.payload); }
    const configuration = result.value.configuration;
    return { locations: configuration.locations.map(location => ({
      id: location.id, name: location.name, active: location.active, timezone: location.timezone,
      minimumCancellationNoticeMinutes: location.policies.minimumCancellationNoticeMinutes,
      minimumRescheduleNoticeMinutes: location.policies.minimumRescheduleNoticeMinutes,
      cancellationAllowed: location.policies.cancellationAllowed !== false,
      reschedulingAllowed: location.policies.reschedulingAllowed !== false,
      staffOverrideAllowed: location.policies.staffOverrideAllowed === true,
      // Explicit operator-safe projection; never expose calendar IDs, phone routes or closure reasons.
      services: configuration.services.filter(service => service.active
        && location.services.some(offering => offering.active && offering.serviceId === service.id))
        .map(service => ({ id: service.id, name: service.name, durationMinutes: service.durationMinutes,
          bufferMinutes: service.bufferMinutes,
          eligibleEmployeeIds: location.professionals.filter(assignment => assignment.active
            && assignment.serviceIds.includes(service.id)
            && configuration.professionals.some(professional => professional.active && professional.id === assignment.professionalId))
            .map(assignment => assignment.professionalId),
        })),
      professionals: configuration.professionals.filter(professional => professional.active
        && location.professionals.some(assignment => assignment.active && assignment.professionalId === professional.id))
        .map(professional => ({ id: professional.id, displayName: professional.displayName,
          name: professional.displayName,
          serviceIds: location.professionals.find(assignment => assignment.professionalId === professional.id)!.serviceIds,
        })),
      availabilitySuggestions: location.policies.availabilitySuggestions ?? DEFAULT_AVAILABILITY_SUGGESTIONS,
    })) };
  });

  server.get<{ Params: { locationId: string }; Querystring: { rangeStart?: unknown; rangeEnd?: unknown } }>(
    "/api/locations/:locationId/appointment-calendar", { preHandler: createAdminGuard(app, "operator") }, async (request, reply) => {
      const { rangeStart, rangeEnd } = request.query;
      if (typeof rangeStart !== "string" || typeof rangeEnd !== "string"
        || Object.keys(request.query).some(key => !["rangeStart", "rangeEnd"].includes(key))) {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      }
      const result = await app.appointments.listCalendarAppointments({
        tenantId: app.tenantId, locationId: request.params.locationId, rangeStart, rangeEnd,
      });
      if (!result.ok) { const error = toHttpError(result.error); return reply.code(error.statusCode).send(error.payload); }
      return { appointments: result.value };
    },
  );

  server.get<{ Params: { locationId: string }; Querystring: { customerId?: string } }>(
    "/api/locations/:locationId/appointments", { preHandler: createAdminGuard(app, "operator") }, async (request, reply) => {
      if (typeof request.query.customerId !== "string" || !request.query.customerId.trim()) return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      return { appointments: await app.appointments.listUpcomingAppointments({ tenantId: app.tenantId,
        locationId: request.params.locationId, customerId: request.query.customerId.trim() }) };
    },
  );
  server.get<{ Params: { locationId: string; appointmentId: string } }>(
    "/api/locations/:locationId/appointments/:appointmentId", { preHandler: createAdminGuard(app, "operator") }, async (request, reply) => {
      const result = await app.appointments.getAppointment({ tenantId: app.tenantId, ...request.params });
      if (!result.ok) { const error = toHttpError(result.error); return reply.code(error.statusCode).send(error.payload); }
      return result.value;
    },
  );
  for (const action of ["cancel", "reschedule"] as const) {
    server.post<{ Params: { locationId: string; appointmentId: string }; Body: unknown }>(
      `/api/locations/:locationId/appointments/:appointmentId/${action}`,
      { preHandler: createAdminGuard(app, "operator") }, async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some(key => action !== "reschedule" || key !== "startAt")
          || (action === "reschedule" && (!("startAt" in body) || typeof body.startAt !== "string" || !body.startAt.trim()))) {
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
        }
        const expectedVersion = parseIfMatch(request.headers["if-match"]);
        if (request.headers["if-match"] !== undefined && expectedVersion === null) {
          return reply.code(400).send({ error: { code: "INVALID_IF_MATCH" } });
        }
        const context = { tenantId: app.tenantId, ...request.params,
          ...(expectedVersion === null ? {} : { expectedVersion }) };
        const before = await app.appointments.getAppointment(context);
        const result = action === "cancel" ? await app.appointments.cancelAppointment(context)
          : await app.appointments.rescheduleAppointment({ ...context, startAt: (body as { startAt: string }).startAt });
        if (!result.ok) { const error = toHttpError(result.error); return reply.code(error.statusCode).send(error.payload); }
        await app.adminAudit.recordMutation({ principal: adminPrincipalFor(request), entityType: "appointment",
          entityId: result.value.id, action, before: before.ok ? before.value : null, after: result.value });
        return result.value;
      },
    );
  }

  server.post<{ Body: AppointmentBody }>(
    "/api/appointments",
    { preHandler: createAdminGuard(app, "operator") },
    async (request, reply) => {
    const { locationId, customerId, serviceId, employeeId, startAt } = request.body ?? {};
    if (![customerId, serviceId, employeeId, startAt].every((value) => typeof value === "string" && value.length > 0)
      || (locationId !== undefined && (typeof locationId !== "string" || !locationId.trim()))) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
    }
    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotencyKey = typeof idempotencyHeader === "string" && idempotencyHeader.trim()
      ? idempotencyHeader.trim()
      : `dashboard:${app.ids.generate("idempotency")}`;
    const result = await app.appointments.createAppointment({
      tenantId: app.tenantId,
      locationId: (locationId as string | undefined) ?? "default",
      customerId: customerId as string,
      serviceId: serviceId as string,
      employeeId: employeeId as string,
      startAt: startAt as string,
      idempotencyKey,
      source: "DASHBOARD",
    });
    if (!result.ok) {
      const mapped = toHttpError(result.error);
      return reply.code(mapped.statusCode).send(mapped.payload);
    }
    await app.adminAudit.recordMutation({
      principal: adminPrincipalFor(request),
      entityType: "appointment",
      entityId: result.value.id,
      action: "create",
      before: null,
      after: result.value,
    });
    return reply.code(201).send(result.value);
    },
  );

  server.get<{ Params: { locationId: string; appointmentId: string } }>(
    "/api/locations/:locationId/appointments/:appointmentId/events",
    { preHandler: createAdminGuard(app, "operator") },
    async (request, reply) => {
      const appointment = await app.appointments.getAppointment({ tenantId: app.tenantId, ...request.params });
      if (!appointment.ok) { const error = toHttpError(appointment.error); return reply.code(error.statusCode).send(error.payload); }
      return {
        events: await app.appointments.listAppointmentEvents({ tenantId: app.tenantId, ...request.params }),
        notifications: app.notifications ? await app.notifications.list(app.tenantId, appointment.value.id) : [],
      };
    },
  );

  server.post<{ Params: { locationId: string; appointmentId: string }; Body: { outcome?: unknown } }>(
    "/api/locations/:locationId/appointments/:appointmentId/outcome",
    { preHandler: createAdminGuard(app, "operator") },
    async (request, reply) => {
      if (request.body?.outcome !== "COMPLETED" && request.body?.outcome !== "NO_SHOW") {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
      }
      const expectedVersion = parseIfMatch(request.headers["if-match"]);
      if (request.headers["if-match"] !== undefined && expectedVersion === null) {
        return reply.code(400).send({ error: { code: "INVALID_IF_MATCH" } });
      }
      const before = await app.appointments.getAppointment({ tenantId: app.tenantId, ...request.params });
      const result = await app.appointments.markAppointmentOutcome({ tenantId: app.tenantId, ...request.params,
        outcome: request.body.outcome, ...(expectedVersion === null ? {} : { expectedVersion }) });
      if (!result.ok) { const error = toHttpError(result.error); return reply.code(error.statusCode).send(error.payload); }
      await app.adminAudit.recordMutation({ principal: adminPrincipalFor(request), entityType: "appointment",
        entityId: result.value.id, action: request.body.outcome.toLowerCase(), before: before.ok ? before.value : null,
        after: result.value });
      return result.value;
    },
  );

  server.get<{ Params: { appointmentId: string } }>(
    "/api/appointments/:appointmentId",
    { preHandler: createAdminGuard(app, "operator") },
    async (request, reply) => {
    const result = await app.appointments.getAppointment({
      tenantId: app.tenantId,
      locationId: "default",
      appointmentId: request.params.appointmentId,
    });
    if (!result.ok) {
      const mapped = toHttpError(result.error);
      return reply.code(mapped.statusCode).send(mapped.payload);
    }
    return result.value;
    },
  );
}
