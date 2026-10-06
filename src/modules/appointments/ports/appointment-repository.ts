import type {
  AppointmentId,
  CustomerId,
  IdempotencyKey,
  ISODateTime,
  LocationId,
  TenantId,
} from "../../../shared/types/identifiers.js";
import type { Appointment, AppointmentEvent } from "../domain/appointment.js";

/** The appointment row changed after it was read. Nothing in the commit was saved. */
export class StaleAppointmentWriteError extends Error {
  constructor() { super("The appointment changed before its update was saved."); }
}

/** Appointment row, replay receipt, and history event saved as one commit. */
export interface AppointmentCommit {
  appointment: Appointment;
  expectedVersion: number;
  /** When set, the update matches only this status as well as the version. */
  expectedStatus?: Appointment["status"];
  receipt: AppointmentMutationReceipt;
  event: AppointmentEvent;
}

export interface AppointmentMutationReceipt {
  idempotencyKey: IdempotencyKey;
  action: "cancel" | "reschedule";
  appointmentId: AppointmentId;
  fingerprint: string;
  appointment: Appointment;
}

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
  /**
   * Writes only when the stored revision is still `expectedVersion`.
   * `expectedStatus` adds a compare-and-swap on status in the same update.
   */
  saveIfVersion(appointment: Appointment, expectedVersion: number, expectedStatus?: Appointment["status"]): Promise<boolean>;
  /**
   * Saves the appointment, its replay receipt, and its history event together.
   * A failure leaves all three unchanged.
   */
  commitChange(change: AppointmentCommit): Promise<void>;
  findMutation(tenantId: TenantId, key: IdempotencyKey): Promise<AppointmentMutationReceipt | null>;
  saveMutation(tenantId: TenantId, receipt: AppointmentMutationReceipt): Promise<void>;
}
