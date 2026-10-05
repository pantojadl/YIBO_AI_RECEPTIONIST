import type { AppointmentId, IdempotencyKey, TenantId } from "../../../shared/types/identifiers.js";
import type { Appointment, AppointmentEvent } from "../domain/appointment.js";
import type { AppointmentRepository } from "../ports/appointment-repository.js";
import type { ConfirmedAppointmentQuery, ConfirmedAppointmentReader } from "../../scheduling/index.js";

export class InMemoryAppointmentRepository implements AppointmentRepository, ConfirmedAppointmentReader {
  private readonly appointments = new Map<string, Appointment>();
  private readonly events: AppointmentEvent[] = [];

  async findById(tenantId: TenantId, appointmentId: AppointmentId): Promise<Appointment | null> {
    const value = this.appointments.get(`${tenantId}:${appointmentId}`);
    return value ? { ...value } : null;
  }

  async findByIdempotencyKey(tenantId: TenantId, key: IdempotencyKey): Promise<Appointment | null> {
    const value = [...this.appointments.values()].find(
      (appointment) => appointment.tenantId === tenantId && appointment.idempotencyKey === key,
    );
    return value ? { ...value } : null;
  }

  async findUpcomingByCustomer(query: {
    tenantId: string; locationId: string; customerId: string; startsAtOrAfter: string;
  }): Promise<Appointment[]> {
    return [...this.appointments.values()]
      .filter((appointment) => appointment.tenantId === query.tenantId
        && appointment.locationId === query.locationId
        && appointment.customerId === query.customerId
        && appointment.status === "CONFIRMED"
        && appointment.startAt >= query.startsAtOrAfter)
      .sort((left, right) => left.startAt.localeCompare(right.startAt))
      .map((appointment) => ({ ...appointment }));
  }

  async findInRange(query: { tenantId: string; locationId: string; rangeStart: string; rangeEnd: string }): Promise<Appointment[]> {
    return [...this.appointments.values()]
      .filter(item => item.tenantId === query.tenantId && item.locationId === query.locationId
        && item.startAt < query.rangeEnd && item.endAt > query.rangeStart)
      .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id))
      .map(item => ({ ...item }));
  }

  async findByRange(query: { tenantId: string; locationId: string; rangeStart: string; rangeEnd: string;
    employeeId?: string; serviceId?: string; status?: string }) {
    return [...this.appointments.values()].filter((appointment) => appointment.tenantId === query.tenantId
      && appointment.locationId === query.locationId && appointment.startAt < query.rangeEnd && query.rangeStart < appointment.endAt
      && (!query.employeeId || appointment.employeeId === query.employeeId)
      && (!query.serviceId || appointment.serviceId === query.serviceId)
      && (!query.status || (appointment.outcomeStatus ?? appointment.status) === query.status))
      .sort((a, b) => a.startAt.localeCompare(b.startAt)).map((appointment) => ({ ...appointment }));
  }

  async appendEvent(event: AppointmentEvent): Promise<void> { this.events.push(structuredClone(event)); }

  async findHistoryByCustomer(tenantId: string, customerId: string, limit: number) {
    return [...this.appointments.values()].filter((item) => item.tenantId === tenantId && item.customerId === customerId)
      .sort((a, b) => b.startAt.localeCompare(a.startAt)).slice(0, limit).map((item) => ({ ...item }));
  }

  async findByTenant(tenantId: string, limit: number) {
    return [...this.appointments.values()].filter((item) => item.tenantId === tenantId)
      .sort((a, b) => b.startAt.localeCompare(a.startAt)).slice(0, limit).map((item) => ({ ...item }));
  }

  async listEvents(tenantId: string, appointmentId: string): Promise<AppointmentEvent[]> {
    return this.events.filter((event) => event.tenantId === tenantId && event.appointmentId === appointmentId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).map((event) => structuredClone(event));
  }

  async hasProfessionalReferences(query: { tenantId: TenantId; professionalId: string; locationId?: string }) {
    return [...this.appointments.values()].some((appointment) => appointment.tenantId === query.tenantId
      && appointment.employeeId === query.professionalId
      && (query.locationId === undefined || appointment.locationId === query.locationId));
  }

  async findConfirmedIntervals(query: ConfirmedAppointmentQuery) {
    return [...this.appointments.values()]
      .filter((appointment) => appointment.tenantId === query.tenantId
        && appointment.locationId === query.locationId
        && appointment.employeeId === query.employeeId
        && occupiesSlot(appointment.status)
        && appointment.startAt < query.rangeEnd && query.rangeStart < appointment.endAt)
      .map(({ startAt, endAt }) => ({ startAt, endAt }))
      .sort((left, right) => left.startAt.localeCompare(right.startAt));
  }

  async findConfirmedLocationIntervals(query: { tenantId: TenantId; locationId: string; rangeStart: string; rangeEnd: string }) {
    return [...this.appointments.values()]
      .filter((appointment) => appointment.tenantId === query.tenantId
        && appointment.locationId === query.locationId && occupiesSlot(appointment.status)
        && appointment.startAt < query.rangeEnd && query.rangeStart < appointment.endAt)
      .map(({ startAt, endAt }) => ({ startAt, endAt }))
      .sort((left, right) => left.startAt.localeCompare(right.startAt));
  }

  calendarRouteReferences(tenantId: TenantId) {
    return [...this.appointments.values()]
      .filter(appointment => appointment.tenantId === tenantId && appointment.status !== "CANCELLED")
      .map(({ locationId, employeeId }) => ({ locationId, employeeId }));
  }

  async save(appointment: Appointment): Promise<void> {
    this.appointments.set(`${appointment.tenantId}:${appointment.id}`, { ...appointment });
  }
}

/** A pending write still owns the slot until it is confirmed or explicitly failed. */
const occupiesSlot = (status: Appointment["status"]): boolean =>
  status === "CONFIRMED" || status === "PENDING_CONFIRMATION";
