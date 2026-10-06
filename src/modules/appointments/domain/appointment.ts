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

/** Local marker written before a provider call. OUTCOME_UNKNOWN is not a success receipt. */
export type AppointmentOperationIntent = "CANCELLING" | "RESCHEDULING" | "OUTCOME_UNKNOWN";

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
  /** Last local write. Missing values are treated as already stale by recovery. */
  updatedAt?: ISODateTime;
  /** A calendar cancel was required and did not succeed. Recovery must finish it. */
  compensationRequired?: boolean;
  /** Set before the provider call so a crash cannot look like a plain confirmed booking. */
  operationIntent?: AppointmentOperationIntent;
  intentKey?: IdempotencyKey;
  intentFingerprint?: string;
  /** Calendar etag observed when the intent was written. Later writes use this value and do not read a newer one. */
  intentEtag?: string;
  /** Fence held by the writer that last committed this row. Stored for the lock check, not returned on reads. */
  writeFence?: number;
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
