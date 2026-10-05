import type { DatabaseSync } from "node:sqlite";
import type { Appointment, AppointmentEvent, AppointmentRepository } from "../../modules/appointments/index.js";
import type { ConfirmedAppointmentReader, ConfirmedAppointmentQuery, OccupiedInterval } from "../../modules/scheduling/index.js";
import type { AppointmentId, IdempotencyKey, RegionId, TenantId } from "../../shared/types/identifiers.js";

type AppointmentRow = {
  id: string; tenant_id: string; location_id: string; customer_id: string; service_id: string; employee_id: string;
  service_name_snapshot: string; price_amount_minor: number; price_currency: string;
  start_at: string; end_at: string; status: Appointment["status"]; idempotency_key: string;
  source: Appointment["source"]; source_call_id: string | null; external_calendar_event_id: string | null;
  outcome_status: "COMPLETED" | "NO_SHOW" | null;
  version: number;
};

export class SqliteAppointmentRepository implements AppointmentRepository, ConfirmedAppointmentReader {
  constructor(private readonly database: DatabaseSync, private readonly region: RegionId) {}

  async findById(tenantId: TenantId, appointmentId: AppointmentId): Promise<Appointment | null> {
    return this.row(this.database.prepare(`${SELECT_APPOINTMENT} AND id = ?`)
      .get(this.region, tenantId, appointmentId) as AppointmentRow | undefined);
  }

  async findByIdempotencyKey(tenantId: TenantId, key: IdempotencyKey): Promise<Appointment | null> {
    return this.row(this.database.prepare(`${SELECT_APPOINTMENT} AND idempotency_key = ?`)
      .get(this.region, tenantId, key) as AppointmentRow | undefined);
  }

  async findUpcomingByCustomer(query: {
    tenantId: string; locationId: string; customerId: string; startsAtOrAfter: string;
  }): Promise<Appointment[]> {
    return this.database.prepare(`${SELECT_APPOINTMENT}
      AND location_id = ? AND customer_id = ? AND status = 'CONFIRMED' AND start_at >= ?
      ORDER BY start_at`
    ).all(this.region, query.tenantId, query.locationId, query.customerId, query.startsAtOrAfter)
      .map((row) => this.row(row as AppointmentRow)!);
  }

  async findInRange(query: { tenantId: string; locationId: string; rangeStart: string; rangeEnd: string }): Promise<Appointment[]> {
    return this.database.prepare(`${SELECT_APPOINTMENT}
      AND location_id = ? AND start_at < ? AND end_at > ? ORDER BY start_at, id`)
      .all(this.region, query.tenantId, query.locationId, query.rangeEnd, query.rangeStart)
      .map(row => this.row(row as AppointmentRow)!);
  }

  async findByRange(query: { tenantId: string; locationId: string; rangeStart: string; rangeEnd: string;
    employeeId?: string; serviceId?: string; status?: string }): Promise<Appointment[]> {
    return this.database.prepare(`${SELECT_APPOINTMENT}
      AND location_id = ? AND start_at < ? AND ? < end_at
      AND (? IS NULL OR employee_id = ?) AND (? IS NULL OR service_id = ?)
      AND (? IS NULL OR COALESCE(outcome_status, status) = ?) ORDER BY start_at`)
      .all(this.region, query.tenantId, query.locationId, query.rangeEnd, query.rangeStart,
        query.employeeId ?? null, query.employeeId ?? null, query.serviceId ?? null, query.serviceId ?? null,
        query.status ?? null, query.status ?? null).map((row) => this.row(row as AppointmentRow)!);
  }

  async appendEvent(event: AppointmentEvent): Promise<void> {
    this.database.prepare(`INSERT INTO appointment_events(region_id, tenant_id, appointment_id, id,
      event_type, occurred_at, actor_type, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.region, event.tenantId, event.appointmentId, event.id, event.type, event.occurredAt,
        event.actorType, JSON.stringify(event.metadata ?? {}));
  }

  async findHistoryByCustomer(tenantId: string, customerId: string, limit: number): Promise<Appointment[]> {
    return this.database.prepare(`${SELECT_APPOINTMENT} AND customer_id = ? ORDER BY start_at DESC LIMIT ?`)
      .all(this.region, tenantId, customerId, limit).map((row) => this.row(row as AppointmentRow)!);
  }

  async findByTenant(tenantId: string, limit: number): Promise<Appointment[]> {
    return this.database.prepare(`${SELECT_APPOINTMENT} ORDER BY start_at DESC LIMIT ?`)
      .all(this.region, tenantId, limit).map((row) => this.row(row as AppointmentRow)!);
  }

  async listEvents(tenantId: string, appointmentId: string): Promise<AppointmentEvent[]> {
    return this.database.prepare(`SELECT id, appointment_id, event_type, occurred_at, actor_type, metadata_json
      FROM appointment_events WHERE region_id = ? AND tenant_id = ? AND appointment_id = ? ORDER BY occurred_at`)
      .all(this.region, tenantId, appointmentId).map((row) => {
        const value = row as { id: string; appointment_id: string; event_type: AppointmentEvent["type"];
          occurred_at: string; actor_type: AppointmentEvent["actorType"]; metadata_json: string };
        return { id: value.id, tenantId, appointmentId: value.appointment_id, type: value.event_type,
          occurredAt: value.occurred_at, actorType: value.actor_type, metadata: JSON.parse(value.metadata_json) };
      });
  }

  async hasProfessionalReferences(query: { tenantId: TenantId; professionalId: string; locationId?: string }) {
    const row = this.database.prepare(`SELECT 1 AS found FROM appointments
      WHERE region_id = ? AND tenant_id = ? AND employee_id = ?
        AND (? IS NULL OR location_id = ?) LIMIT 1`
    ).get(this.region, query.tenantId, query.professionalId,
      query.locationId ?? null, query.locationId ?? null) as { found: number } | undefined;
    return row?.found === 1;
  }

  calendarRouteReferences(tenantId: TenantId): Array<{ locationId: string; employeeId: string }> {
    return this.database.prepare(`SELECT DISTINCT location_id AS locationId, employee_id AS employeeId
      FROM appointments WHERE region_id = ? AND tenant_id = ? AND status != 'CANCELLED'`)
      .all(this.region, tenantId) as Array<{ locationId: string; employeeId: string }>;
  }

  async save(value: Appointment): Promise<void> {
    this.database.prepare(`
      INSERT INTO appointments(
        region_id, tenant_id, location_id, id, customer_id, service_id, service_name_snapshot,
        price_amount_minor, price_currency, employee_id, start_at, end_at, status, idempotency_key,
        source, source_call_id, external_calendar_event_id, outcome_status, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(region_id, tenant_id, id) DO UPDATE SET
        location_id = excluded.location_id, customer_id = excluded.customer_id, service_id = excluded.service_id,
        service_name_snapshot = excluded.service_name_snapshot, price_amount_minor = excluded.price_amount_minor,
        price_currency = excluded.price_currency, employee_id = excluded.employee_id,
        start_at = excluded.start_at, end_at = excluded.end_at,
        status = excluded.status, idempotency_key = excluded.idempotency_key, source = excluded.source,
        source_call_id = excluded.source_call_id, external_calendar_event_id = excluded.external_calendar_event_id,
        outcome_status = excluded.outcome_status, version = excluded.version
    `).run(
      this.region, value.tenantId, value.locationId, value.id, value.customerId, value.serviceId,
      value.serviceNameSnapshot, value.priceAmountMinor, value.priceCurrency, value.employeeId,
      value.startAt, value.endAt, value.status, value.idempotencyKey, value.source,
      value.sourceCallId ?? null, value.externalCalendarEventId ?? null, value.outcomeStatus ?? null, value.version ?? 1,
    );
  }

  async findConfirmedIntervals(query: ConfirmedAppointmentQuery): Promise<OccupiedInterval[]> {
    return this.database.prepare(`
      SELECT start_at, end_at FROM appointments
      WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND employee_id = ? AND status IN ('CONFIRMED', 'PENDING_CONFIRMATION')
        AND start_at < ? AND ? < end_at
      ORDER BY start_at
    `).all(this.region, query.tenantId, query.locationId, query.employeeId, query.rangeEnd, query.rangeStart)
      .map((row) => {
        const value = row as { start_at: string; end_at: string };
        return { startAt: value.start_at, endAt: value.end_at };
      });
  }

  async findConfirmedLocationIntervals(query: { tenantId: string; locationId: string; rangeStart: string; rangeEnd: string }) {
    return this.database.prepare(`SELECT start_at, end_at FROM appointments
      WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND status IN ('CONFIRMED', 'PENDING_CONFIRMATION')
        AND start_at < ? AND ? < end_at ORDER BY start_at`
    ).all(this.region, query.tenantId, query.locationId, query.rangeEnd, query.rangeStart)
      .map((row) => {
        const value = row as { start_at: string; end_at: string };
        return { startAt: value.start_at, endAt: value.end_at };
      });
  }

  private row(value: AppointmentRow | undefined): Appointment | null {
    if (!value) return null;
    return {
      version: value.version, id: value.id, tenantId: value.tenant_id, locationId: value.location_id, customerId: value.customer_id,
      serviceId: value.service_id, employeeId: value.employee_id, startAt: value.start_at,
      serviceNameSnapshot: value.service_name_snapshot, priceAmountMinor: value.price_amount_minor,
      priceCurrency: value.price_currency,
      endAt: value.end_at, status: value.status, idempotencyKey: value.idempotency_key,
      source: value.source,
      ...(value.source_call_id ? { sourceCallId: value.source_call_id } : {}),
      ...(value.external_calendar_event_id ? { externalCalendarEventId: value.external_calendar_event_id } : {}),
      ...(value.outcome_status ? { outcomeStatus: value.outcome_status } : {}),
    };
  }
}

const SELECT_APPOINTMENT = `
  SELECT id, tenant_id, location_id, customer_id, service_id, service_name_snapshot,
    price_amount_minor, price_currency, employee_id, start_at, end_at, status,
    idempotency_key, source, source_call_id, external_calendar_event_id, outcome_status, version
  FROM appointments WHERE region_id = ? AND tenant_id = ?
`;
