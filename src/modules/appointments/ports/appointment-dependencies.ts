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

export interface AppointmentLockClaim {
  tenantId: TenantId;
  locationId: LocationId;
  ownerId: string;
  acquiredAt: string;
  /** Process that inserted the claim. Not used to decide whether the lease is live. */
  ownerPid?: number;
  fence?: number;
  /** Unix milliseconds of the last heartbeat. Lease checks use this, not `acquiredAt`. */
  heartbeatMs?: number;
}

export interface AppointmentConcurrencyGuard {
  execute<T>(tenantId: TenantId, locationId: LocationId, employeeId: EmployeeId, operation: () => Promise<T>): Promise<T>;
  listClaims(tenantId: TenantId): AppointmentLockClaim[];
  /** Refreshes the lease only for the owner that still holds this fence. */
  heartbeat(tenantId: TenantId, locationId: LocationId, ownerId: string, fence: number): boolean;
  /** True only while this owner still holds this fence. */
  ownsFence(tenantId: TenantId, locationId: LocationId, ownerId: string, fence: number): boolean;
  /** True while this location's heartbeat is still inside the lease. Recovery must not call Google when this is true. */
  hasLiveLease(tenantId: TenantId, locationId: LocationId): boolean;
  /** True after this process replaced an expired lease at the location. Recovery may repair that location's calendar. */
  hasUnresolvedSteal(tenantId: TenantId, locationId: LocationId): boolean;
  clearSteal(tenantId: TenantId, locationId: LocationId): void;
  /**
   * Kept for older callers. A live lease is not deleted here.
   * The next writer steals an expired lease and increments the fence.
   */
  releaseClaim(tenantId: TenantId, locationId: LocationId, ownerId: string, acquiredAt: string): boolean;
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
    /** Etag stored with the intent. When set, the write uses If-Match and does not read another etag. */
    expectedEtag?: string;
  }): Promise<Result<void, AppointmentCalendarError>>;
  cancelEvent(command: {
    appointmentId: AppointmentId;
    tenantId: TenantId;
    locationId: LocationId;
    employeeId: EmployeeId;
    externalEventId: string;
    /** Etag stored with the intent. When set, the delete uses If-Match and does not read another etag. */
    expectedEtag?: string;
  }): Promise<Result<void, AppointmentCalendarError>>;
  /**
   * Reads whether this appointment still has a live calendar event.
   * `present: false` means the event is gone. A failure means the calendar could not be checked.
   */
  inspectEvent(command: {
    tenantId: TenantId;
    locationId: LocationId;
    employeeId: EmployeeId;
    appointmentId: AppointmentId;
    externalEventId?: string;
  }): Promise<Result<{ present: boolean; externalEventId?: string; startAt?: string; endAt?: string; etag?: string }, AppointmentCalendarError>>;
}

export type AppointmentCalendarError =
  | { code: "CALENDAR_NOT_CONNECTED" }
  | { code: "AUTHORIZATION_REQUIRED" }
  | { code: "RATE_LIMITED"; retryAfterMs?: number }
  | { code: "PROVIDER_UNAVAILABLE"; retryable: boolean }
  | { code: "EVENT_NOT_FOUND" }
  | { code: "VALIDATION_ERROR"; message: string }
  | { code: "NEEDS_RECONCILE" };
