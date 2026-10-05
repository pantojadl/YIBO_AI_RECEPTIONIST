import { trustedToolScope } from "./trusted-tool-scope.js";
import { operationalLog } from "../../../shared/observability/operational-log.js";
import type { AppointmentService } from "../../appointments/index.js";
import type { SchedulingService } from "../../scheduling/index.js";
import { resolvedAiCapabilities, type BusinessDirectory } from "../../business/index.js";
import type { CustomerService } from "../../customers/index.js";
import type { Clock } from "../../../shared/application/system.js";
import type { HumanTransferPort } from "../ports/agent-dependencies.js";
import type {
  AgentToolCall,
  AgentToolResult,
  ToolExecutionContext,
  ToolExecutor,
} from "./contracts.js";
import { resolveNaturalDateRange } from "../domain/natural-date-range.js";
import { dateTimeInTimezone, normalizeDateTimeForTimezone } from "../../scheduling/domain/time.js";

type Input = Record<string, unknown>;
type ConfirmableAvailability = { requestedStartAt?: string; availableStartAts: string[] };

export class ToolExecutorImpl implements ToolExecutor {
  private readonly confirmableAvailabilityByCall = new Map<string, ConfirmableAvailability>();
  private readonly confirmedContactByCall = new Set<string>();
  private readonly appointmentReferencesByCall = new Map<string, Map<string, { appointmentId: string; version: number }>>();
  private readonly testCustomersByCall = new Map<string, string>();
  private readonly testAppointmentsByCall = new Map<string, string[]>();
  private readonly enabledTestCalls = new Set<string>();

  constructor(
    private readonly scheduling: SchedulingService,
    private readonly appointments: AppointmentService,
    private readonly transfer: HumanTransferPort,
    private readonly businesses?: BusinessDirectory,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly customers?: CustomerService,
    private readonly developerTest?: { scheduling: SchedulingService; appointments: AppointmentService },
  ) {}

  async execute(context: ToolExecutionContext, call: AgentToolCall): Promise<AgentToolResult> {
    if (!isObject(call.arguments)) return invalid(call, "Tool arguments must be an object");
    if (containsTrustedField(call.arguments)) {
      return invalid(call, "Trusted context fields cannot be supplied by the model");
    }
    switch (call.name) {
      case "get_service_information": return this.getServiceInformation(context, call);
      case "list_customer_appointments": return this.listCustomerAppointments(context, call);
      case "check_availability": return this.checkAvailability(context, call);
      case "create_appointment": return this.createAppointment(context, call);
      case "update_customer": return this.updateCustomer(context, call);
      case "cancel_appointment": return this.cancelAppointment(context, call);
      case "reschedule_appointment": return this.rescheduleAppointment(context, call);
      case "transfer_to_human": return this.transferToHuman(context, call);
      case "enable_developer_test_mode": return this.enableDeveloperTestMode(context, call);
      case "delete_test_appointments": return this.deleteTestAppointments(context, call);
    }
  }

  private async getServiceInformation(context: ToolExecutionContext, call: AgentToolCall) {
    const input = call.arguments as Input;
    if (!exactKeys(input, ["service"], []) || (input.service !== undefined && !text(input.service))) {
      return invalid(call, "service must be a non-empty patient-facing name when provided");
    }
    if (!this.businesses) {
      return toolError(call, "BUSINESS_CONTEXT_UNAVAILABLE", "Service information is unavailable right now.", false);
    }
    const result = await this.businesses.getBusinessProfile(context.tenantId);
    if (!result.ok) {
      return toolError(call, result.error.code, "Service information is unavailable right now.", false);
    }
    const requestedName = text(input.service) ? normalizeName(input.service) : undefined;
    const activeLocations = result.value.locations.filter(({ active }) => active);
    const services = result.value.services
      .filter((service) => service.active && (!requestedName || normalizeName(service.name) === requestedName))
      .map((service) => ({
        name: service.name,
        description: service.description,
        durationMinutes: service.durationMinutes,
        locations: activeLocations.flatMap((location) => {
          const offer = location.services.find((candidate) => candidate.active && candidate.serviceId === service.id);
          const capabilities = resolvedAiCapabilities(location);
          return offer ? [{
            name: location.name,
            ...(capabilities.quotePrices ? { price: {
              amountMinor: offer.price.amountMinor,
              currency: offer.price.currency,
              display: formatMoney(offer.price.amountMinor, offer.price.currency, location.locale),
            } } : {}),
          }] : [];
        }),
      }))
      .filter(({ locations }) => locations.length > 0);
    return services.length > 0
      ? { toolCallId: call.toolCallId, ok: true as const, data: { services } }
      : toolError(call, "SERVICE_NOT_FOUND", "No active service with that name is available.", false);
  }

  private async listCustomerAppointments(context: ToolExecutionContext, call: AgentToolCall) {
    const input = call.arguments as Input;
    if (!exactKeys(input, [], [])) return invalid(call, "list_customer_appointments does not accept arguments");
    if (!context.customerId) {
      return toolError(call, "CUSTOMER_REQUIRED", "Verify the caller before listing appointments.", false);
    }
    const business = await this.businesses?.getLocation(context.tenantId, context.locationId);
    if (!business?.ok) {
      return toolError(call, "BUSINESS_CONTEXT_UNAVAILABLE", "Upcoming appointments are unavailable right now.", false);
    }
    const appointmentService = this.enabledTestCalls.has(trustedToolScope(context))
      ? this.developerTest?.appointments ?? this.appointments
      : this.appointments;
    const appointments = await appointmentService.listUpcomingAppointments({
      tenantId: context.tenantId,
      locationId: context.locationId,
      customerId: context.customerId,
    });
    const references = new Map<string, { appointmentId: string; version: number }>();
    const publicAppointments = appointments.map((appointment, index) => {
      const reference = `upcoming-${index + 1}`;
      references.set(reference, { appointmentId: appointment.id, version: appointment.version ?? 1 });
      const professional = business.value.business.professionals
        .find(({ id }) => id === appointment.employeeId)?.displayName;
      return {
        reference,
        service: appointment.serviceNameSnapshot,
        startAt: appointment.startAt,
        endAt: appointment.endAt,
        localStartAt: dateTimeInTimezone(new Date(appointment.startAt), business.value.location.timezone).dateTime,
        localEndAt: dateTimeInTimezone(new Date(appointment.endAt), business.value.location.timezone).dateTime,
        displayStart: formatSpokenDateTime(appointment.startAt, business.value.location.timezone, business.value.location.locale),
        timezone: business.value.location.timezone,
        location: business.value.location.name,
        ...(professional ? { professional } : {}),
        price: {
          amountMinor: appointment.priceAmountMinor,
          currency: appointment.priceCurrency,
          display: formatMoney(appointment.priceAmountMinor, appointment.priceCurrency, business.value.location.locale),
        },
      };
    });
    this.appointmentReferencesByCall.set(trustedToolScope(context), references);
    return { toolCallId: call.toolCallId, ok: true as const, data: { appointments: publicAppointments } };
  }

  private async updateCustomer(context: ToolExecutionContext, call: AgentToolCall) {
    if (!context.customerId) return toolError(call, "CUSTOMER_REQUIRED", "Ask for the caller's name and phone number before booking.", false);
    const input = call.arguments as Input;
    if (!exactKeys(input, ["name", "phone", "email", "preferredLanguage"], ["name"])
      || !text(input.name) || !hasFirstAndLastName(input.name) || !this.customers) {
      return invalid(call, "A first and last name and at least one allowed contact field are required.");
    }
    const location = await this.businesses?.getLocation(context.tenantId, context.locationId);
    if (!location?.ok) return toolError(call, "BUSINESS_CONTEXT_UNAVAILABLE", "Contact information cannot be saved right now.", false);
    const capabilities = resolvedAiCapabilities(location.value.location);
    if (capabilities.collectPhone && !text(input.phone)) {
      return invalid(call, "Repeat the callback number to the caller, obtain confirmation, and provide phone together with the full name.");
    }
    if (input.phone !== undefined && (!capabilities.collectPhone || !text(input.phone))) return invalid(call, "Phone collection is not allowed.");
    if (input.email !== undefined && (!capabilities.collectEmail || !text(input.email))) return invalid(call, "Email collection is not allowed.");
    const updated = await this.customers.updateCustomer({ tenantId: context.tenantId, customerId: context.customerId,
      name: input.name, ...(text(input.phone) ? { phone: input.phone } : {}), ...(text(input.email) ? { email: input.email } : {}),
      ...(text(input.preferredLanguage) ? { preferredLanguage: input.preferredLanguage } : {}) });
    if (!updated.ok) return toolError(call, updated.error.code, "The contact information could not be saved. Ask for the phone number again.", false);
    this.confirmedContactByCall.add(trustedToolScope(context));
    return { toolCallId: call.toolCallId, ok: true as const, data: { saved: true, contactConfirmedForBooking: true } };
  }

  private async checkAvailability(context: ToolExecutionContext, call: AgentToolCall) {
    const input = call.arguments as Input;
    if (!exactKeys(input, ["service", "employeeId", "dateExpression", "rangeStart", "rangeEnd", "requestedStartAt"], []) ||
        (input.service !== undefined && !text(input.service)) ||
        (input.employeeId !== undefined && !text(input.employeeId)) ||
        (input.requestedStartAt !== undefined && !dateTime(input.requestedStartAt))) {
      return invalid(call, "A patient-facing service and either dateExpression or rangeStart/rangeEnd are required");
    }
    const serviceId = await this.resolveServiceId(context.tenantId, context.locationId, input.service);
    if (!serviceId) return toolError(call, "SERVICE_NOT_FOUND", "Ask the caller whether this is for a cleaning or a consultation.", false);
    const testMode = this.enabledTestCalls.has(trustedToolScope(context));
    const scheduling = testMode ? this.developerTest?.scheduling ?? this.scheduling : this.scheduling;
    const employeeId = input.employeeId as string | undefined ?? (testMode
      ? await this.defaultTestEmployeeId(context.tenantId, context.locationId, serviceId)
      : undefined);
    const absoluteRange = dateTime(input.rangeStart) && dateTime(input.rangeEnd)
      ? await this.normalizeRange(context.tenantId, context.locationId, input.rangeStart, input.rangeEnd)
      : undefined;
    const naturalRange = text(input.dateExpression) ? await this.resolveDateExpression(context.tenantId, context.locationId, input.dateExpression) : undefined;
    if ((absoluteRange && naturalRange) || (!absoluteRange && !naturalRange)) {
      return invalid(call, "Provide either a valid dateExpression or valid rangeStart and rangeEnd");
    }
    const range = naturalRange ?? absoluteRange!;
    const business = await this.businesses?.getLocation(context.tenantId, context.locationId);
    calendarLog("calendar.availability.started", { tenantId: context.tenantId, locationId: context.locationId, serviceId, dateExpression: input.dateExpression });
    calendarLog("calendar.trace.availability.query", {
      tenantId: context.tenantId,
      locationId: context.locationId,
      clinicTimezone: business?.ok ? business.value.location.timezone : undefined,
      rangeStart: await this.traceDateTime(context.tenantId, context.locationId, range.rangeStart),
      rangeEnd: await this.traceDateTime(context.tenantId, context.locationId, range.rangeEnd),
    });
    const result = await scheduling.findAvailableSlots({
      tenantId: context.tenantId,
      locationId: context.locationId,
      serviceId,
      ...(employeeId ? { employeeId } : {}),
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
    });
    if (!result.ok) {
      calendarLog("calendar.availability.failed", { tenantId: context.tenantId, code: result.error.code });
      return toolError(call, result.error.code, availabilityMessage(result.error.code), result.error.code === "EXTERNAL_CALENDAR_UNAVAILABLE" && result.error.retryable);
    }
    // Operations may further restrict Product UX suggestions for this caller.
    const visibleSlots = business?.ok && !resolvedAiCapabilities(business.value.location).offerAlternatives
      ? result.value.filter(slot => !slot.outsideRequestedRange).slice(0, 1)
      : result.value;
    calendarLog("calendar.availability.completed", { tenantId: context.tenantId, slotCount: visibleSlots.length });
    calendarLog("calendar.trace.availability.slots", {
      tenantId: context.tenantId,
      slots: await Promise.all(visibleSlots.map(async (slot) => ({
        employeeId: slot.employeeId,
        startAt: await this.traceDateTime(context.tenantId, context.locationId, slot.startAt),
        endAt: await this.traceDateTime(context.tenantId, context.locationId, slot.endAt),
      }))),
    });
    if (visibleSlots[0]) {
      const selected = await this.normalizeDateTime(context.tenantId, context.locationId, visibleSlots[0].startAt);
      calendarLog("calendar.slot.selected", {
        tenantId: context.tenantId,
        employeeId: visibleSlots[0].employeeId,
        selectedAvailabilitySlot: visibleSlots[0].startAt,
        clinicTimezone: selected?.timeZone,
        selectedLocalDateTime: selected?.dateTime,
      });
    }
    const requestedStartAt = text(input.requestedStartAt)
      ? await this.normalizeDateTime(context.tenantId, context.locationId, input.requestedStartAt)
      : undefined;
    if (text(input.requestedStartAt) && !requestedStartAt) return invalid(call, "requestedStartAt must be a valid clinic-local or offset-aware datetime");
    const requested = requestedStartAt
      ? await scheduling.validateSlot({ tenantId: context.tenantId, locationId: context.locationId, serviceId, employeeId: employeeId ?? visibleSlots[0]?.employeeId ?? "", startAt: requestedStartAt.instant })
      : undefined;
    if (requestedStartAt) {
      calendarLog("calendar.requested_time.parsed", {
        tenantId: context.tenantId,
        userRequestedLocalTime: input.requestedStartAt,
        clinicIanaTimezone: requestedStartAt.timeZone,
        parsedLocalDateTime: requestedStartAt.dateTime,
        parsedUtcDateTime: requestedStartAt.instant,
      });
    }
    this.confirmableAvailabilityByCall.set(trustedToolScope(context), {
      ...(requested?.ok ? { requestedStartAt: requestedStartAt?.instant } : {}),
      availableStartAts: visibleSlots.map((slot) => slot.startAt),
    });
    const businessLocale = business?.ok ? business.value.location.locale : "en";
    const publicSlots = await Promise.all(visibleSlots.map(async (slot) => {
      const localStart = await this.normalizeDateTime(context.tenantId, context.locationId, slot.startAt);
      const localEnd = await this.normalizeDateTime(context.tenantId, context.locationId, slot.endAt);
      const professional = business?.ok
        ? business.value.business.professionals.find(({ id }) => id === slot.employeeId)?.displayName
        : undefined;
      return {
        ...slot,
        ...(localStart ? { localStartAt: localStart.dateTime, displayStart: formatSpokenDateTime(slot.startAt, localStart.timeZone, businessLocale) } : {}),
        ...(localEnd ? { localEndAt: localEnd.dateTime } : {}),
        ...(professional ? { professional } : {}),
        ...(business?.ok ? { timezone: business.value.location.timezone } : {}),
      };
    }));
    return {
      toolCallId: call.toolCallId,
      ok: true as const,
      data: {
        success: true,
        requestedPeriod: { startAt: range.rangeStart, endAt: range.rangeEnd, ...(naturalRange ? { label: naturalRange.label } : {}) },
        availableSlots: publicSlots,
        // Kept temporarily for existing clients while Realtime uses the clearer names above.
        slots: publicSlots,
        earliestSlot: publicSlots[0] ?? null,
        ...(naturalRange ? { resolvedDate: naturalRange.label } : {}),
        ...(requestedStartAt ? { requestedStartAt: requestedStartAt.instant, requestedTimeAvailable: requested?.ok ?? false } : {}),
      },
    };
  }

  private async resolveDateExpression(tenantId: string, locationId: string, expression: string) {
    const business = await this.businesses?.getLocation(tenantId, locationId);
    if (!business?.ok) return undefined;
    return resolveNaturalDateRange(expression, this.clock.now(), business.value.location.timezone) ?? undefined;
  }

  private async normalizeRange(tenantId: string, locationId: string, rangeStart: string, rangeEnd: string) {
    const start = await this.normalizeDateTime(tenantId, locationId, rangeStart);
    const end = await this.normalizeDateTime(tenantId, locationId, rangeEnd);
    return start && end && start.instant < end.instant
      ? { rangeStart: start.instant, rangeEnd: end.instant }
      : undefined;
  }

  private async normalizeDateTime(tenantId: string, locationId: string, value: string) {
    const business = await this.businesses?.getLocation(tenantId, locationId);
    if (!business?.ok) return undefined;
    const instant = normalizeDateTimeForTimezone(value, business.value.location.timezone);
    if (!instant) return undefined;
    const normalized = dateTimeInTimezone(instant, business.value.location.timezone);
    return { instant: instant.toISOString(), ...normalized };
  }

  private async traceDateTime(tenantId: string, locationId: string, value: string) {
    const normalized = await this.normalizeDateTime(tenantId, locationId, value);
    return normalized
      ? { input: value, iso: normalized.instant, local: normalized.dateTime, timeZone: normalized.timeZone }
      : { input: value, invalid: true };
  }

  private async resolveServiceId(tenantId: string, locationId: string, value: unknown): Promise<string | undefined> {
    const business = await this.businesses?.getLocation(tenantId, locationId);
    if (!business?.ok) return undefined;
    const offeredIds = new Set(business.value.location.services.filter(({ active }) => active).map(({ serviceId }) => serviceId));
    if (text(value)) {
      const normalized = value.trim().toLocaleLowerCase();
      // IDs remain internal: matching them here supports clinics whose configured
      // display language differs from the caller's patient-facing choice.
      return business.value.business.services.find((service) => offeredIds.has(service.id) && (
        service.name.trim().toLocaleLowerCase() === normalized
        || service.id.trim().toLocaleLowerCase() === normalized),
      )?.id;
    }
    // The default is explicit location policy; catalog ordering never grants a
    // service implicit priority.
    return business.value.location.policies.defaultServiceId;
  }

  private async defaultTestEmployeeId(tenantId: string, locationId: string, serviceId: string): Promise<string | undefined> {
    const business = await this.businesses?.getLocation(tenantId, locationId);
    if (!business?.ok) return undefined;
    const assignment = business.value.location.professionals.find((professional) =>
      professional.active && professional.serviceIds.includes(serviceId));
    return business.value.business.professionals.find((employee) => employee.active && employee.id === assignment?.professionalId)?.id;
  }

  private async createAppointment(context: ToolExecutionContext, call: AgentToolCall) {
    const testMode = this.enabledTestCalls.has(trustedToolScope(context));
    const customerId = testMode ? this.testCustomersByCall.get(trustedToolScope(context)) : context.customerId;
    if (!customerId) return toolError(call, "CUSTOMER_REQUIRED", "Verify the caller before creating an appointment.", false);
    const supportsCustomerLookup = this.customers && typeof this.customers.getCustomer === "function";
    if (!testMode && supportsCustomerLookup && !this.confirmedContactByCall.has(trustedToolScope(context))) {
      return toolError(call, "CONTACT_CONFIRMATION_REQUIRED", "Before booking, collect the caller's full name and callback number, read back the number using the configured phoneReadback style for confirmation, save both with update_customer, then retry this exact verified slot.", false);
    }
    const input = call.arguments as Input;
    if (!exactKeys(input, ["service", "employeeId", "startAt"], ["employeeId", "startAt"]) ||
        (input.service !== undefined && !text(input.service)) || !text(input.employeeId) || !dateTime(input.startAt)) {
      return invalid(call, "A patient-facing service, employeeId and a valid startAt are required");
    }
    const serviceId = await this.resolveServiceId(context.tenantId, context.locationId, input.service);
    if (!serviceId) return toolError(call, "SERVICE_NOT_FOUND", "Ask the caller whether this is for a cleaning or a consultation.", false);
    const normalizedStartAt = await this.normalizeDateTime(context.tenantId, context.locationId, input.startAt);
    if (!normalizedStartAt) return invalid(call, "startAt must be a valid clinic-local or offset-aware datetime");
    const availability = this.confirmableAvailabilityByCall.get(trustedToolScope(context));
    const confirmedStartAt = availability?.requestedStartAt ?? normalizedStartAt.instant;
    // A time returned by calendar availability is an authoritative instant. If the
    // model rebuilds it (for example, by adding Z to a local 3 PM), never turn that
    // different instant into an appointment.
    if (!availability?.requestedStartAt && availability?.availableStartAts.length && !availability.availableStartAts.includes(confirmedStartAt)) {
      return toolError(call, "SLOT_NOT_REVALIDATED", "The selected time must be checked again before booking. Call check_availability for that exact time.", false);
    }
    calendarLog("calendar.trace.user_confirmation", {
      tenantId: context.tenantId,
      appointmentToolArguments: { employeeId: input.employeeId, startAt: input.startAt },
      confirmedSlot: await this.traceDateTime(context.tenantId, context.locationId, confirmedStartAt),
    });
    calendarLog("calendar.appointment.requested", {
      tenantId: context.tenantId,
      bookingStartAtReceived: input.startAt,
      clinicTimezone: normalizedStartAt.timeZone,
      normalizedLocalDateTime: normalizedStartAt.dateTime,
      bookingStartAtUsed: confirmedStartAt,
    });
    const appointments = testMode ? this.developerTest?.appointments ?? this.appointments : this.appointments;
    const result = await appointments.createAppointment({
      tenantId: context.tenantId,
      locationId: context.locationId,
      customerId,
      serviceId,
      employeeId: input.employeeId,
      startAt: confirmedStartAt,
      idempotencyKey: `${context.callId}:${call.toolCallId}`,
      source: testMode ? "DEVELOPER_TEST" : "AI_CALL",
      sourceCallId: context.callId,
    });
    if (!result.ok) {
      const retryable = result.error.code === "CALENDAR_SYNC_FAILED" && result.error.retryable;
      const message = result.error.code === "SLOT_NO_LONGER_AVAILABLE"
        ? "That time is no longer available. Offer the caller alternative slots."
        : "The appointment could not be confirmed. Do not tell the caller it was booked.";
      return toolError(call, result.error.code, message, retryable);
    }
    if (result.value.status !== "CONFIRMED") {
      return toolError(call, "APPOINTMENT_NOT_CONFIRMED", "The appointment is not confirmed. Do not present it as booked.", false);
    }
    if (testMode) this.testAppointmentsByCall.set(trustedToolScope(context), [...(this.testAppointmentsByCall.get(trustedToolScope(context)) ?? []), result.value.id]);
    const business = await this.businesses?.getLocation(context.tenantId, context.locationId);
    const locale = business?.ok ? business.value.location.locale : "en";
    const professional = business?.ok
      ? business.value.business.professionals.find(({ id }) => id === result.value.employeeId)?.displayName
      : undefined;
    const localStart = business?.ok
      ? dateTimeInTimezone(new Date(result.value.startAt), business.value.location.timezone)
      : undefined;
    const localEnd = business?.ok
      ? dateTimeInTimezone(new Date(result.value.endAt), business.value.location.timezone)
      : undefined;
    const address = business?.ok ? formatAddress(business.value.location.address) : undefined;
    return {
      toolCallId: call.toolCallId,
      ok: true as const,
      data: {
        confirmed: true,
        service: result.value.serviceNameSnapshot,
        startAt: result.value.startAt,
        endAt: result.value.endAt,
        ...(localStart ? {
          localStartAt: localStart.dateTime,
          localEndAt: localEnd?.dateTime,
          displayStart: formatSpokenDateTime(result.value.startAt, localStart.timeZone, locale),
        } : {}),
        ...(professional ? { professional } : {}),
        ...(business?.ok ? {
          timezone: business.value.location.timezone,
          location: business.value.location.name,
          ...(address ? { address } : {}),
        } : {}),
        nextStep: address
          ? "State the local appointment time and professional name, then ask whether the caller needs the location address."
          : "State the local appointment time and professional name. Do not invent an address because this location has none configured.",
        price: {
          amountMinor: result.value.priceAmountMinor,
          currency: result.value.priceCurrency,
          display: formatMoney(result.value.priceAmountMinor, result.value.priceCurrency, locale),
        },
      },
    };
  }

  private async enableDeveloperTestMode(context: ToolExecutionContext, call: AgentToolCall) {
    if (!exactKeys(call.arguments as Input, [], [])) return invalid(call, "This tool does not accept arguments");
    if (!context.developerTestModeAuthorized) return toolError(call, "TEST_MODE_NOT_AUTHORIZED", "Developer Test Mode is not available in this session.", false);
    if (!this.customers) return toolError(call, "TEST_MODE_UNAVAILABLE", "Developer Test Mode is unavailable.", false);
    const customer = await this.customers.findOrCreateByPhone({ tenantId: context.tenantId, phone: "+15550000000", name: "YIBO Test Patient" });
    if (!customer.ok) return toolError(call, "TEST_MODE_UNAVAILABLE", "Developer Test Mode could not be initialized.", false);
    this.testCustomersByCall.set(trustedToolScope(context), customer.value.id);
    this.enabledTestCalls.add(trustedToolScope(context));
    calendarLog("developer.test_mode.enabled", { tenantId: context.tenantId, callId: context.callId });
    return { toolCallId: call.toolCallId, ok: true as const, data: { enabled: true, message: "Test mode enabled." } };
  }

  private async deleteTestAppointments(context: ToolExecutionContext, call: AgentToolCall) {
    if (!exactKeys(call.arguments as Input, [], [])) return invalid(call, "This tool does not accept arguments");
    if (!context.developerTestModeAuthorized || !this.enabledTestCalls.has(trustedToolScope(context))) return toolError(call, "TEST_MODE_NOT_AUTHORIZED", "Developer Test Mode is not enabled in this session.", false);
    const appointments = this.testAppointmentsByCall.get(trustedToolScope(context)) ?? [];
    const appointmentService = this.developerTest?.appointments ?? this.appointments;
    let deleted = 0;
    for (const appointmentId of appointments) {
      const result = await appointmentService.cancelAppointment({ tenantId: context.tenantId, locationId: context.locationId, appointmentId });
      if (result.ok) deleted += 1;
    }
    this.testAppointmentsByCall.delete(trustedToolScope(context));
    return { toolCallId: call.toolCallId, ok: true as const, data: { deleted } };
  }

  private async cancelAppointment(context: ToolExecutionContext, call: AgentToolCall) {
    const testMode = this.enabledTestCalls.has(trustedToolScope(context));
    const customerId = testMode ? this.testCustomersByCall.get(trustedToolScope(context)) : context.customerId;
    if (!customerId) return toolError(call, "CUSTOMER_REQUIRED", "Verify the caller before cancelling an appointment.", false);
    const appointments = testMode ? this.developerTest?.appointments ?? this.appointments : this.appointments;
    const input = call.arguments as Input;
    if (!exactKeys(input, ["appointmentReference"], ["appointmentReference"]) || !text(input.appointmentReference)) {
      return invalid(call, "appointmentReference from list_customer_appointments is required");
    }
    const reference = this.appointmentReferencesByCall.get(trustedToolScope(context))?.get(input.appointmentReference);
    const appointmentId = reference?.appointmentId;
    if (!appointmentId) return toolError(call, "APPOINTMENT_REFERENCE_NOT_FOUND", "List upcoming appointments again and use one of the returned references.", false);
    const lookup = await appointments.getAppointment({
      tenantId: context.tenantId,
      locationId: context.locationId,
      appointmentId,
    });
    if (!lookup.ok || lookup.value.customerId !== customerId) {
      return toolError(call, "APPOINTMENT_NOT_FOUND", "No cancellable appointment was found for this verified caller.", false);
    }
    const result = await appointments.cancelAppointment({
      tenantId: context.tenantId,
      locationId: context.locationId,
      appointmentId,
      expectedVersion: reference!.version,
    });
    if (!result.ok) {
      const retryable = result.error.code === "CALENDAR_SYNC_FAILED" && result.error.retryable;
      return toolError(call, result.error.code,
        appointmentConflictMessage(result.error.code) ?? "The appointment could not be cancelled. Do not claim it was cancelled.", retryable);
    }
    this.appointmentReferencesByCall.get(trustedToolScope(context))?.delete(input.appointmentReference);
    return { toolCallId: call.toolCallId, ok: true as const, data: { cancelled: true, reference: input.appointmentReference } };
  }

  private async rescheduleAppointment(context: ToolExecutionContext, call: AgentToolCall) {
    const testMode = this.enabledTestCalls.has(trustedToolScope(context));
    const customerId = testMode ? this.testCustomersByCall.get(trustedToolScope(context)) : context.customerId;
    if (!customerId) return toolError(call, "CUSTOMER_REQUIRED", "Verify the caller before rescheduling an appointment.", false);
    const appointments = testMode ? this.developerTest?.appointments ?? this.appointments : this.appointments;
    const input = call.arguments as Input;
    if (!exactKeys(input, ["appointmentReference", "startAt"], ["appointmentReference", "startAt"])
      || !text(input.appointmentReference) || !dateTime(input.startAt)) {
      return invalid(call, "appointmentReference and a valid startAt are required");
    }
    const reference = this.appointmentReferencesByCall.get(trustedToolScope(context))?.get(input.appointmentReference);
    const appointmentId = reference?.appointmentId;
    if (!appointmentId) return toolError(call, "APPOINTMENT_REFERENCE_NOT_FOUND", "List upcoming appointments again and use one of the returned references.", false);
    const lookup = await appointments.getAppointment({ tenantId: context.tenantId, locationId: context.locationId, appointmentId });
    if (!lookup.ok || lookup.value.customerId !== customerId) {
      return toolError(call, "APPOINTMENT_NOT_FOUND", "No reschedulable appointment was found for this verified caller.", false);
    }
    const normalizedStartAt = await this.normalizeDateTime(context.tenantId, context.locationId, input.startAt);
    if (!normalizedStartAt) return invalid(call, "startAt must be a valid clinic-local or offset-aware datetime");
    calendarLog("calendar.appointment.reschedule_requested", {
      tenantId: context.tenantId,
      locationId: context.locationId,
      appointmentId,
      bookingStartAtReceived: input.startAt,
      clinicTimezone: normalizedStartAt.timeZone,
      normalizedLocalDateTime: normalizedStartAt.dateTime,
    });
    const result = await appointments.rescheduleAppointment({
      tenantId: context.tenantId,
      locationId: context.locationId,
      appointmentId,
      startAt: normalizedStartAt.instant,
      expectedVersion: reference!.version,
    });
    if (!result.ok) {
      const retryable = result.error.code === "CALENDAR_SYNC_FAILED" && result.error.retryable;
      const message = result.error.code === "SLOT_NO_LONGER_AVAILABLE"
        ? "That new time is no longer available. Offer a verified alternative."
        : appointmentConflictMessage(result.error.code) ?? "The appointment could not be rescheduled. Do not claim it was changed.";
      return toolError(call, result.error.code, message, retryable);
    }
    reference!.version = result.value.version ?? reference!.version + 1;
    calendarLog("calendar.appointment.reschedule_completed", {
      tenantId: context.tenantId, appointmentId: result.value.id, startAt: result.value.startAt,
    });
    return {
      toolCallId: call.toolCallId,
      ok: true as const,
      data: {
        rescheduled: true,
        reference: input.appointmentReference,
        startAt: result.value.startAt,
        endAt: result.value.endAt,
      },
    };
  }

  private async transferToHuman(context: ToolExecutionContext, call: AgentToolCall) {
    const input = call.arguments as Input;
    if (!exactKeys(input, [], [])) return invalid(call, "transfer_to_human does not accept a destination");
    const result = await this.transfer.transferToConfiguredDestination({
      tenantId: context.tenantId,
      locationId: context.locationId,
      callId: context.callId,
    });
    return result.ok
      ? { toolCallId: call.toolCallId, ok: true as const, data: { transferred: true } }
      : toolError(call, result.error.code, "The transfer could not be completed. Continue assisting the caller.", result.error.retryable);
  }
}

const isObject = (value: unknown): value is Input => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const dateTime = (value: unknown): value is string => text(value) && !Number.isNaN(new Date(value).valueOf());
const containsTrustedField = (input: Input): boolean => ["tenantId", "locationId", "callId", "customerId", "idempotencyKey"].some((key) => key in input);
const exactKeys = (input: Input, allowed: string[], required: string[]): boolean =>
  Object.keys(input).every((key) => allowed.includes(key)) && required.every((key) => key in input);
const invalid = (call: AgentToolCall, message: string) => toolError(call, "INVALID_TOOL_ARGUMENTS", message, false);
const toolError = (call: AgentToolCall, code: string, messageForAgent: string, retryable: boolean): AgentToolResult => ({
  toolCallId: call.toolCallId,
  ok: false,
  error: { code, messageForAgent, retryable },
});

const availabilityMessage = (code: string): string => {
  if (code === "CALENDAR_NOT_CONNECTED") return "The clinic calendar is not connected. Ask the caller to try again after it is connected.";
  if (code === "CALENDAR_AUTHORIZATION_REQUIRED") return "The clinic calendar needs to be reconnected. Do not offer an appointment time.";
  if (code === "CALENDAR_RATE_LIMITED") return "The calendar is temporarily busy. Ask the caller to try again shortly.";
  return "The calendar could not be reached right now. Do not invent availability or offer a time.";
};

const calendarLog = operationalLog;
const hasFirstAndLastName = (value: string): boolean => value.trim().split(/\s+/).length >= 2;
const normalizeName = (value: string): string => value.trim().toLocaleLowerCase();
const formatMoney = (amountMinor: number, currency: string, locale: string): string => {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / (10 ** fractionDigits));
};

const formatSpokenDateTime = (instant: string, timeZone: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instant));

const formatAddress = (address: { line1: string; line2?: string; city: string; administrativeArea?: string; postalCode?: string; countryCode: string }): string | undefined => {
  if ([address.line1, address.city].some((part) => part.trim().toLocaleLowerCase() === "pending configuration")) return undefined;
  return [address.line1, address.line2, address.city, address.administrativeArea, address.postalCode, address.countryCode]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
};

function appointmentConflictMessage(code: string): string | undefined {
  if (code === "APPOINTMENT_VERSION_CONFLICT") return "This appointment changed since it was listed. List upcoming appointments again and verify the current details with the caller before another change. Do not claim success.";
  if (code === "APPOINTMENT_OPERATION_IN_PROGRESS") return "Another appointment operation is in progress. Do not retry automatically or claim success. Check the current appointment again before continuing.";
  return undefined;
}
