import { DEFAULT_AVAILABILITY_SUGGESTIONS } from "../../business/domain/multi-location-business.js";
import { failure, success } from "../../../shared/domain/result.js";
import type { Clock } from "../../../shared/application/system.js";
import type { LocationClosure, OpeningHoursRule, ProfessionalDefinition, TenantServiceDefinition } from "../../business/index.js";
import type { BusinessDirectory } from "../../business/index.js";
import {
  intersects,
  localParts,
  minuteOfDay,
  normalizeDateTimeForTimezone,
  rulesForDay,
  toUtc,
  type LocalDateTimeParts,
} from "../domain/time.js";
import type {
  AvailableSlot,
  FindAvailableSlotsQuery,
  SchedulingError,
  SchedulingService,
  ValidateSlotQuery,
  ValidatedSlot,
} from "./contracts.js";
import type { CalendarPort } from "../ports/calendar-port.js";
import type { ConfirmedAppointmentReader } from "../ports/confirmed-appointment-reader.js";
import type { EmployeeWorkingHoursProvider } from "../ports/employee-working-hours-provider.js";

export class SchedulingServiceImpl implements SchedulingService {
  constructor(
    private readonly businessDirectory: BusinessDirectory,
    private readonly workingHours: EmployeeWorkingHoursProvider,
    private readonly appointments: ConfirmedAppointmentReader,
    private readonly calendar: CalendarPort,
    private readonly clock: Clock,
  ) {}

  async findAvailableSlots(query: FindAvailableSlotsQuery) {
    const requested = await this.findWithinRange(query);
    if (!requested.ok || query.limit === 0) return requested;
    const context = await this.businessDirectory.getLocation(query.tenantId, query.locationId);
    if (!context.ok) return requested;
    const policy = context.value.location.policies.availabilitySuggestions ?? DEFAULT_AVAILABILITY_SUGGESTIONS;
    // An omitted policy preserves the exact-range contract of existing installations.
    if (!policy?.enabled || requested.value.length >= policy.maximumAlternatives) return requested;
    const range = parseRange(query.rangeStart, query.rangeEnd)!;
    // First strategy: search forward from the requested period, bounded by the
    // same booking horizon, hours, closures, capacity and Calendar checks.
    const alternatives = await this.findWithinRange({ ...query,
      rangeStart: range.end.toISOString(),
      rangeEnd: new Date(range.end.valueOf() + policy.expansionDays * 86_400_000).toISOString(),
      limit: policy.maximumAlternatives,
    });
    // Never hide a provider failure or misrepresent an unverified expansion.
    if (!alternatives.ok) return alternatives;
    return success([...requested.value, ...alternatives.value.map(slot => ({ ...slot, outsideRequestedRange: true as const }))]);
  }

  private async findWithinRange(query: FindAvailableSlotsQuery) {
    const range = parseRange(query.rangeStart, query.rangeEnd);
    if (!range) return failure<SchedulingError>({ code: "INVALID_TIME_RANGE" });

    const configuration = await this.configuration(query.tenantId, query.locationId, query.serviceId, query.employeeId);
    if (!configuration.ok) return configuration;
    const { location, service, employees } = configuration.value;
    const policyRange = bookingRange(this.clock.now(), location.policies.minimumLeadTimeMinutes,
      location.policies.maximumBookingHorizonDays);
    const effectiveRange = {
      start: new Date(Math.max(range.start.valueOf(), policyRange.start.valueOf())),
      end: new Date(Math.min(range.end.valueOf(), policyRange.end.valueOf())),
    };
    if (effectiveRange.start >= effectiveRange.end) return success([]);

    const slots: AvailableSlot[] = [];
    for (const employee of employees) {
      const employeeSlots = await this.availableForEmployee({
        tenantId: query.tenantId,
        locationId: query.locationId,
        employee,
        service,
        timezone: location.timezone,
        businessHours: location.openingHours,
        closures: location.closures,
        rangeStart: effectiveRange.start,
        rangeEnd: effectiveRange.end,
        slotIncrementMinutes: location.policies.slotIncrementMinutes,
        concurrentCapacity: location.policies.concurrentCapacity,
      });
      if (!employeeSlots.ok) return employeeSlots;
      slots.push(...employeeSlots.value);
    }

    slots.sort((left, right) => left.startAt.localeCompare(right.startAt));
    const requestedLimit = query.limit === undefined ? location.policies.maximumResults : Math.max(0, query.limit);
    return success(slots.slice(0, Math.min(requestedLimit, location.policies.maximumResults)));
  }

  async validateSlot(query: ValidateSlotQuery) {
    const start = new Date(query.startAt);
    if (Number.isNaN(start.valueOf())) return failure<SchedulingError>({ code: "INVALID_TIME_RANGE" });

    const configuration = await this.configuration(query.tenantId, query.locationId, query.serviceId, query.employeeId);
    if (!configuration.ok) return configuration;
    const { location, service, employees } = configuration.value;
    const employee = employees[0]!;
    const end = new Date(start.valueOf() + (service.durationMinutes + service.bufferMinutes) * 60_000);
    const policyRange = bookingRange(this.clock.now(), location.policies.minimumLeadTimeMinutes,
      location.policies.maximumBookingHorizonDays);
    if (start < policyRange.start || end > policyRange.end) {
      return failure<SchedulingError>({ code: "OUTSIDE_BOOKING_WINDOW" });
    }

    const isWithinHours = await this.isWithinHours(
      query.tenantId, query.locationId, employee.id, location.timezone, location.openingHours,
      location.policies.slotIncrementMinutes, start, end,
    );
    if (!isWithinHours) return failure<SchedulingError>({ code: "OUTSIDE_BUSINESS_HOURS" });
    if (intersects(start, end, closureIntervals(location.closures, location.timezone))) {
      return failure<SchedulingError>({ code: "SLOT_CONFLICT" });
    }
    const locationIntervals = await this.appointments.findConfirmedLocationIntervals({
      tenantId: query.tenantId,
      locationId: query.locationId,
      rangeStart: start.toISOString(),
      rangeEnd: end.toISOString(),
    });
    if (overlapCount(start, end, locationIntervals) >= location.policies.concurrentCapacity) {
      return failure<SchedulingError>({ code: "SLOT_CONFLICT" });
    }

    const conflict = await this.hasConflict(query.tenantId, query.locationId, employee.id, start, end);
    if (!conflict.ok) return conflict;
    if (conflict.value) return failure<SchedulingError>({ code: "SLOT_CONFLICT" });

    return success<ValidatedSlot>({
      employeeId: employee.id,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      validatedAt: this.clock.now().toISOString(),
    });
  }

  private async configuration(tenantId: string, locationId: string, serviceId: string, requestedEmployeeId?: string) {
    const businessResult = await this.businessDirectory.getLocation(tenantId, locationId);
    if (!businessResult.ok) return failure<SchedulingError>({ code: "EMPLOYEE_UNAVAILABLE" });
    const { business, location } = businessResult.value;
    const offered = location.services.find((candidate) => candidate.serviceId === serviceId && candidate.active);
    const service = offered ? business.services.find((candidate) => candidate.id === serviceId && candidate.active) : undefined;
    if (!service) return failure<SchedulingError>({ code: "SERVICE_NOT_FOUND" });

    const employees = location.professionals
      .filter((assignment) => assignment.active && assignment.serviceIds.includes(serviceId))
      .map((assignment) => business.professionals.find((candidate) => candidate.id === assignment.professionalId && candidate.active))
      .filter((candidate): candidate is ProfessionalDefinition => Boolean(candidate))
      .filter((employee) => !requestedEmployeeId || employee.id === requestedEmployeeId);
    if (requestedEmployeeId && employees.length === 0) {
      return failure<SchedulingError>({ code: "EMPLOYEE_NOT_FOUND" });
    }
    if (employees.length === 0) return failure<SchedulingError>({ code: "EMPLOYEE_UNAVAILABLE" });
    return success({ location, service, employees });
  }

  private async availableForEmployee(input: {
    tenantId: string;
    locationId: string;
    employee: ProfessionalDefinition;
    service: TenantServiceDefinition;
    timezone: string;
    businessHours: OpeningHoursRule[];
    closures: LocationClosure[];
    rangeStart: Date;
    rangeEnd: Date;
    slotIncrementMinutes: number;
    concurrentCapacity: number;
  }) {
    const employeeHours = await this.workingHours.getWorkingHours({
      tenantId: input.tenantId,
      locationId: input.locationId,
      employeeId: input.employee.id,
    });
    const effectiveEmployeeHours = employeeHours.length > 0 ? employeeHours : input.businessHours;

    const conflict = await this.conflictIntervals(input.tenantId, input.locationId, input.employee.id, input.rangeStart, input.rangeEnd);
    if (!conflict.ok) return conflict;
    const locationIntervals = await this.appointments.findConfirmedLocationIntervals({
      tenantId: input.tenantId,
      locationId: input.locationId,
      rangeStart: input.rangeStart.toISOString(),
      rangeEnd: input.rangeEnd.toISOString(),
    });
    const result: AvailableSlot[] = [];
    const firstDay = localParts(input.rangeStart, input.timezone);
    const lastDay = localParts(input.rangeEnd, input.timezone);
    let cursor = new Date(Date.UTC(firstDay.year, firstDay.month - 1, firstDay.day));
    const finalDay = Date.UTC(lastDay.year, lastDay.month - 1, lastDay.day);

    while (cursor.valueOf() <= finalDay) {
      const day: LocalDateTimeParts = {
        year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate(), hour: 0, minute: 0,
      };
      const weekday = cursor.getUTCDay();
      for (const businessRule of rulesForDay(input.businessHours, weekday)) {
        for (const employeeRule of rulesForDay(effectiveEmployeeHours, weekday)) {
          const startMinute = Math.max(minuteOfDay(businessRule.startTime), minuteOfDay(employeeRule.startTime));
          const endMinute = Math.min(minuteOfDay(businessRule.endTime), minuteOfDay(employeeRule.endTime));
          for (let minute = startMinute; minute + input.service.durationMinutes + input.service.bufferMinutes <= endMinute; minute += input.slotIncrementMinutes) {
            const start = toUtc({ ...day, hour: Math.floor(minute / 60), minute: minute % 60 }, input.timezone);
            const end = new Date(start.valueOf() + (input.service.durationMinutes + input.service.bufferMinutes) * 60_000);
            if (start < input.rangeStart || end > input.rangeEnd
              || intersects(start, end, closureIntervals(input.closures, input.timezone))
              || overlapCount(start, end, locationIntervals) >= input.concurrentCapacity
              || intersects(start, end, conflict.value)) continue;
            result.push({ employeeId: input.employee.id, startAt: start.toISOString(), endAt: end.toISOString() });
          }
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return success(result);
  }

  private async isWithinHours(
    tenantId: string, locationId: string, employeeId: string, timezone: string,
    businessHours: OpeningHoursRule[], slotIncrementMinutes: number, start: Date, end: Date,
  ): Promise<boolean> {
    const employeeHours = await this.workingHours.getWorkingHours({ tenantId, locationId, employeeId });
    const effectiveEmployeeHours = employeeHours.length > 0 ? employeeHours : businessHours;
    const localStart = localParts(start, timezone);
    const localEnd = localParts(end, timezone);
    if (localStart.year !== localEnd.year || localStart.month !== localEnd.month || localStart.day !== localEnd.day) return false;
    const weekday = new Date(Date.UTC(localStart.year, localStart.month - 1, localStart.day)).getUTCDay();
    const startMinute = localStart.hour * 60 + localStart.minute;
    const endMinute = localEnd.hour * 60 + localEnd.minute;
    return rulesForDay(businessHours, weekday).some((businessRule) =>
      rulesForDay(effectiveEmployeeHours, weekday).some((employeeRule) => {
        const intersectionStart = Math.max(minuteOfDay(businessRule.startTime), minuteOfDay(employeeRule.startTime));
        const intersectionEnd = Math.min(minuteOfDay(businessRule.endTime), minuteOfDay(employeeRule.endTime));
        return intersectionStart <= startMinute && endMinute <= intersectionEnd
          && (startMinute - intersectionStart) % slotIncrementMinutes === 0;
      }));
  }

  private async hasConflict(tenantId: string, locationId: string, employeeId: string, start: Date, end: Date) {
    const intervals = await this.conflictIntervals(tenantId, locationId, employeeId, start, end);
    if (!intervals.ok) return intervals;
    return success(intersects(start, end, intervals.value));
  }

  private async conflictIntervals(tenantId: string, locationId: string, employeeId: string, rangeStart: Date, rangeEnd: Date) {
    const query = { tenantId, locationId, employeeId, rangeStart: rangeStart.toISOString(), rangeEnd: rangeEnd.toISOString() };
    const [localIntervals, externalIntervals] = await Promise.all([
      this.appointments.findConfirmedIntervals(query),
      this.calendar.getBusyIntervals(query),
    ]);
    if (!externalIntervals.ok) {
      if (externalIntervals.error.code === "CALENDAR_NOT_CONNECTED") return failure<SchedulingError>({ code: "CALENDAR_NOT_CONNECTED" });
      if (externalIntervals.error.code === "AUTHORIZATION_REQUIRED") return failure<SchedulingError>({ code: "CALENDAR_AUTHORIZATION_REQUIRED" });
      if (externalIntervals.error.code === "RATE_LIMITED") return failure<SchedulingError>({ code: "CALENDAR_RATE_LIMITED" });
      return failure<SchedulingError>({
        code: "EXTERNAL_CALENDAR_UNAVAILABLE",
        retryable: externalIntervals.error.code === "PROVIDER_UNAVAILABLE" ? externalIntervals.error.retryable : false,
      });
    }
    return success([...localIntervals, ...externalIntervals.value]);
  }
}

const parseRange = (rangeStart: string, rangeEnd: string): { start: Date; end: Date } | null => {
  const start = new Date(rangeStart);
  const end = new Date(rangeEnd);
  return Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start >= end ? null : { start, end };
};

const bookingRange = (now: Date, minimumLeadTimeMinutes: number, maximumBookingHorizonDays: number) => ({
  start: new Date(now.valueOf() + minimumLeadTimeMinutes * 60_000),
  end: new Date(now.valueOf() + maximumBookingHorizonDays * 24 * 60 * 60_000),
});

const closureIntervals = (closures: LocationClosure[], timezone: string) => closures.flatMap((closure) => {
  const start = normalizeDateTimeForTimezone(closure.startLocal, timezone);
  const end = normalizeDateTimeForTimezone(closure.endLocal, timezone);
  return start && end && start < end ? [{ startAt: start.toISOString(), endAt: end.toISOString() }] : [];
});

const overlapCount = (
  start: Date,
  end: Date,
  intervals: Array<{ startAt: string; endAt: string }>,
): number => intervals.filter((interval) => new Date(interval.startAt) < end && start < new Date(interval.endAt)).length;
