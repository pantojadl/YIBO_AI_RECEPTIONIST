import type {
  AppointmentId,
  CustomerId,
  IdempotencyKey,
  ISODateTime,
  LocationId,
  TenantId,
} from "../../../shared/types/identifiers.js";
import type { Appointment, AppointmentEvent } from "../domain/appointment.js";

export interface AppointmentRepository {
  findById(tenantId: TenantId, appointmentId: AppointmentId): Promise<Appointment | null>;
  findByIdempotencyKey(tenantId: TenantId, key: IdempotencyKey): Promise<Appointment | null>;
  /** All statuses overlapping a bounded calendar period; no upcoming-only filter. */
  findInRange(query: {
    tenantId: TenantId; locationId: LocationId; rangeStart: ISODateTime; rangeEnd: ISODateTime;
  }): Promise<Appointment[]>;
  findUpcomingByCustomer(query: {
    tenantId: TenantId;
    locationId: LocationId;
    customerId: CustomerId;
    startsAtOrAfter: ISODateTime;
  }): Promise<Appointment[]>;
  findByRange(query: { tenantId: TenantId; locationId: LocationId; rangeStart: ISODateTime; rangeEnd: ISODateTime;
    employeeId?: string; serviceId?: string; status?: string }): Promise<Appointment[]>;
  findHistoryByCustomer(tenantId: TenantId, customerId: CustomerId, limit: number): Promise<Appointment[]>;
  findByTenant(tenantId: TenantId, limit: number): Promise<Appointment[]>;
  appendEvent(event: AppointmentEvent): Promise<void>;
  listEvents(tenantId: TenantId, appointmentId: AppointmentId): Promise<AppointmentEvent[]>;
  hasProfessionalReferences(query: {
    tenantId: TenantId;
    professionalId: string;
    locationId?: string;
  }): Promise<boolean>;
  /** Local atomic read used inside configuration persistence; includes uncertain failed bookings. */
  calendarRouteReferences(tenantId: TenantId): Array<{ locationId: string; employeeId: string }>;
  save(appointment: Appointment): Promise<void>;
}
