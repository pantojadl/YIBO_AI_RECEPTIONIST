import type { Result } from "../../../shared/domain/result.js";
import type { EmployeeId, LocationId, ServiceId, TenantId } from "../../../shared/types/identifiers.js";

export interface SchedulingService {
  findAvailableSlots(
    query: FindAvailableSlotsQuery,
  ): Promise<Result<AvailableSlot[], SchedulingError>>;
  validateSlot(
    query: ValidateSlotQuery,
  ): Promise<Result<ValidatedSlot, SchedulingError>>;
}

export interface FindAvailableSlotsQuery {
  tenantId: TenantId;
  locationId: LocationId;
  serviceId: ServiceId;
  employeeId?: EmployeeId;
  rangeStart: string;
  rangeEnd: string;
  limit?: number;
}

export interface ValidateSlotQuery {
  tenantId: TenantId;
  locationId: LocationId;
  serviceId: ServiceId;
  employeeId: EmployeeId;
  startAt: string;
}

export interface AvailableSlot {
  /** Only expanded results carry this marker; the requested range remains unchanged. */
  outsideRequestedRange?: true;
  employeeId: EmployeeId;
  startAt: string;
  endAt: string;
}

export interface ValidatedSlot extends AvailableSlot {
  validatedAt: string;
}

export type SchedulingError =
  | { code: "SERVICE_NOT_FOUND" }
  | { code: "EMPLOYEE_NOT_FOUND" }
  | { code: "OUTSIDE_BUSINESS_HOURS" }
  | { code: "OUTSIDE_BOOKING_WINDOW" }
  | { code: "EMPLOYEE_UNAVAILABLE" }
  | { code: "SLOT_CONFLICT" }
  | { code: "INVALID_TIME_RANGE" }
  | { code: "CALENDAR_NOT_CONNECTED" }
  | { code: "CALENDAR_AUTHORIZATION_REQUIRED" }
  | { code: "CALENDAR_RATE_LIMITED" }
  | { code: "EXTERNAL_CALENDAR_UNAVAILABLE"; retryable: boolean };
