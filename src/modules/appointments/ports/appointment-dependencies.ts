import type { Result } from "../../../shared/domain/result.js";
import type {
  AppointmentId,
  CustomerId,
  EmployeeId,
  IdempotencyKey,
  ISODateTime,
  LocationId,
  TenantId,
} from "../../../shared/types/identifiers.js";

export interface CustomerReader {
  exists(tenantId: TenantId, customerId: CustomerId): Promise<boolean>;
  get(tenantId: TenantId, customerId: CustomerId): Promise<{ name?: string; phone: string } | null>;
}

/** A durable guard rejects busy locations instead of waiting on an unbounded external call. */
export class AppointmentOperationInProgressError extends Error {
  constructor() { super("An appointment operation is already in progress at this location."); }
}

export interface AppointmentConcurrencyGuard {
  execute<T>(tenantId: TenantId, locationId: LocationId, employeeId: EmployeeId, operation: () => Promise<T>): Promise<T>;
}

export interface AppointmentCalendarPort {
  createEvent(command: {
    tenantId: TenantId;
    locationId: LocationId;
    appointmentId: AppointmentId;
    employeeId: EmployeeId;
    title: string;
    serviceName: string;
    patient?: { name?: string; phone: string };
    startAt: ISODateTime;
    endAt: ISODateTime;
    idempotencyKey: IdempotencyKey;
  }): Promise<Result<{ provider: string; externalEventId: string }, AppointmentCalendarError>>;
  rescheduleEvent(command: {
    tenantId: TenantId;
    locationId: LocationId;
    appointmentId: AppointmentId;
    employeeId: EmployeeId;
    externalEventId: string;
    startAt: ISODateTime;
    endAt: ISODateTime;
  }): Promise<Result<void, AppointmentCalendarError>>;
  cancelEvent(command: {
    appointmentId: AppointmentId;
    tenantId: TenantId;
    locationId: LocationId;
    employeeId: EmployeeId;
    externalEventId: string;
  }): Promise<Result<void, AppointmentCalendarError>>;
}

export type AppointmentCalendarError =
  | { code: "CALENDAR_NOT_CONNECTED" }
  | { code: "AUTHORIZATION_REQUIRED" }
  | { code: "RATE_LIMITED"; retryAfterMs?: number }
  | { code: "PROVIDER_UNAVAILABLE"; retryable: boolean }
  | { code: "EVENT_NOT_FOUND" }
  | { code: "VALIDATION_ERROR"; message: string };
