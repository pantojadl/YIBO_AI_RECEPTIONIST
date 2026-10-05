import type {
  AppointmentId,
  CallId,
  CustomerId,
  EmployeeId,
  IdempotencyKey,
  ISODateTime,
  LocationId,
  ServiceId,
  TenantId,
} from "../../../shared/types/identifiers.js";

export type AppointmentStatus =
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "CANCELLED"
  | "FAILED";

export interface Appointment {
  /** Persisted edit revision. Older/custom repository records start at 1. */
  version?: number;
  id: AppointmentId;
  tenantId: TenantId;
  locationId: LocationId;
  customerId: CustomerId;
  serviceId: ServiceId;
  serviceNameSnapshot: string;
  priceAmountMinor: number;
  priceCurrency: string;
  employeeId: EmployeeId;
  startAt: ISODateTime;
  endAt: ISODateTime;
  status: AppointmentStatus;
  idempotencyKey: IdempotencyKey;
  source: "AI_CALL" | "DASHBOARD" | "API" | "DEVELOPER_TEST";
  sourceCallId?: CallId;
  externalCalendarEventId?: string;
  outcomeStatus?: "COMPLETED" | "NO_SHOW";
}

export interface AppointmentEvent {
  id: string;
  tenantId: TenantId;
  appointmentId: AppointmentId;
  type: "CREATED" | "RESCHEDULED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";
  occurredAt: ISODateTime;
  actorType: "AI" | "OFFICE" | "SYSTEM";
  metadata?: Record<string, string>;
}
