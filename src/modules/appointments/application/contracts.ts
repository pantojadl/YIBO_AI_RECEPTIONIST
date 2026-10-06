import type { Result } from "../../../shared/domain/result.js";
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
import type { Appointment, AppointmentEvent } from "../domain/appointment.js";

export interface CreateAppointmentCommand {
  tenantId: TenantId;
  locationId: LocationId;
  customerId: CustomerId;
  serviceId: ServiceId;
  employeeId: EmployeeId;
  startAt: ISODateTime;
  idempotencyKey: IdempotencyKey;
  source: "AI_CALL" | "DASHBOARD" | "API" | "DEVELOPER_TEST";
  sourceCallId?: CallId;
}

export interface CancelAppointmentCommand {
  expectedVersion?: number;
  tenantId: TenantId;
  locationId: LocationId;
  appointmentId: AppointmentId;
  /** Stable across retries of this cancel. A missing key is rejected. */
  idempotencyKey: IdempotencyKey;
}

export interface RescheduleAppointmentCommand {
  expectedVersion?: number;
  tenantId: TenantId;
  locationId: LocationId;
  appointmentId: AppointmentId;
  startAt: ISODateTime;
  /** Stable across retries of this move. A missing key is rejected. */
  idempotencyKey: IdempotencyKey;
}

export interface GetAppointmentQuery {
  tenantId: TenantId;
  locationId: LocationId;
  appointmentId: AppointmentId;
}

export interface ListUpcomingAppointmentsQuery {
  tenantId: TenantId;
  locationId: LocationId;
  customerId: CustomerId;
}
export interface ListAppointmentsQuery { tenantId: TenantId; locationId: LocationId; rangeStart: ISODateTime; rangeEnd: ISODateTime;
  employeeId?: EmployeeId; serviceId?: ServiceId; status?: string }
export interface MarkAppointmentOutcomeCommand { tenantId: TenantId; locationId: LocationId; appointmentId: AppointmentId;
  outcome: "COMPLETED" | "NO_SHOW"; expectedVersion?: number }

export interface AppointmentCalendarQuery {
  tenantId: TenantId;
  locationId: LocationId;
  rangeStart: ISODateTime;
  rangeEnd: ISODateTime;
}

/** Office-facing read projection; customer/profile storage stays with Customers. */
export interface AppointmentCalendarEntry extends Appointment {
  customerName?: string;
  customerPhone?: string;
  professionalName: string;
}

export type AppointmentEditConflict =
  | { code: "APPOINTMENT_VERSION_CONFLICT" }
  | { code: "APPOINTMENT_OPERATION_IN_PROGRESS" };

export type CreateAppointmentError =
  | AppointmentEditConflict
  | { code: "SLOT_NO_LONGER_AVAILABLE" }
  | { code: "CUSTOMER_NOT_FOUND" }
  | { code: "SERVICE_NOT_FOUND" }
  | { code: "EMPLOYEE_NOT_FOUND" }
  | { code: "CALENDAR_SYNC_FAILED"; retryable: boolean }
  | { code: "IDEMPOTENCY_CONFLICT" }
  | { code: "CALL_ENDED" }
  | { code: "VALIDATION_ERROR"; message: string };

export type CancelAppointmentError =
  | AppointmentEditConflict
  | { code: "APPOINTMENT_NOT_FOUND" }
  | { code: "APPOINTMENT_ALREADY_CANCELLED" }
  | { code: "CANCELLATION_NOTICE_NOT_MET" }
  | { code: "CALENDAR_SYNC_FAILED"; retryable: boolean }
  | { code: "NEEDS_RECONCILE" }
  | { code: "IDEMPOTENCY_CONFLICT" }
  | { code: "VALIDATION_ERROR"; message: string };

export type RescheduleAppointmentError =
  | AppointmentEditConflict
  | { code: "APPOINTMENT_NOT_FOUND" }
  | { code: "APPOINTMENT_NOT_CONFIRMED" }
  | { code: "RESCHEDULE_NOTICE_NOT_MET" }
  | { code: "SLOT_NO_LONGER_AVAILABLE" }
  | { code: "CALENDAR_SYNC_FAILED"; retryable: boolean }
  | { code: "NEEDS_RECONCILE" }
  | { code: "IDEMPOTENCY_CONFLICT" }
  | { code: "VALIDATION_ERROR"; message: string };

export type AppointmentLookupError = { code: "APPOINTMENT_NOT_FOUND" };

export interface AppointmentService {
  createAppointment(
    command: CreateAppointmentCommand,
  ): Promise<Result<Appointment, CreateAppointmentError>>;
  cancelAppointment(
    command: CancelAppointmentCommand,
  ): Promise<Result<Appointment, CancelAppointmentError>>;
  rescheduleAppointment(
    command: RescheduleAppointmentCommand,
  ): Promise<Result<Appointment, RescheduleAppointmentError>>;
  getAppointment(
    query: GetAppointmentQuery,
  ): Promise<Result<Appointment, AppointmentLookupError>>;
  listUpcomingAppointments(query: ListUpcomingAppointmentsQuery): Promise<Appointment[]>;
  listCalendarAppointments(query: AppointmentCalendarQuery): Promise<Result<
    AppointmentCalendarEntry[], { code: "VALIDATION_ERROR"; message: string }
  >>;
  listAppointments(query: ListAppointmentsQuery): Promise<Appointment[]>;
  listAppointmentEvents(query: GetAppointmentQuery): Promise<AppointmentEvent[]>;
  markAppointmentOutcome(command: MarkAppointmentOutcomeCommand): Promise<Result<Appointment, AppointmentLookupError | AppointmentEditConflict>>;
  listCustomerHistory(tenantId: TenantId, customerId: CustomerId, limit?: number): Promise<Appointment[]>;
  listTenantHistory(tenantId: TenantId, limit?: number): Promise<Appointment[]>;
  /**
   * Checks the calendar for pending rows. Confirms a row whose event exists and has no
   * compensation flag. Releases a compensation row only after the event is proven gone.
   * A timeout or unknown calendar result stays pending. Location locks are not deleted
   * by age; the next writer steals a lease only after missed heartbeats.
   */
  reconcileUnconfirmedBookings(tenantId: TenantId): Promise<{ released: string[]; confirmed: string[]; held: string[] }>;
  recoverStuckBookings(tenantId: TenantId): Promise<{ released: string[]; confirmed: string[]; held: string[]; releasedLocks: string[] }>;
}
