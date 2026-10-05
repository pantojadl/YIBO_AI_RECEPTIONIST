import { describe, expect, it, vi } from "vitest";
import { success } from "../../src/shared/domain/result.js";
import type { Appointment, AppointmentService } from "../../src/modules/appointments/index.js";
import type { SchedulingService } from "../../src/modules/scheduling/index.js";
import type { CustomerService } from "../../src/modules/customers/index.js";
import {
  BusinessDirectoryService,
  InMemoryBusinessRepository,
  type BusinessProfile,
  type VersionedBusinessProfile,
} from "../../src/modules/business/index.js";
import { DEVELOPMENT_BUSINESS } from "../../src/app/development-fixtures.js";
import {
  ToolExecutorImpl,
  type HumanTransferPort,
} from "../../src/modules/agents/index.js";

const confirmedAppointment: Appointment = {
  id: "appointment-1",
  tenantId: "tenant-a",
  locationId: "default",
  customerId: "customer-1",
  serviceId: "service-1",
  serviceNameSnapshot: "Consultation",
  priceAmountMinor: 0,
  priceCurrency: "USD",
  employeeId: "employee-1",
  startAt: "2026-08-10T15:00:00.000Z",
  endAt: "2026-08-10T15:30:00.000Z",
  status: "CONFIRMED",
  idempotencyKey: "call-1:tool-1",
  source: "AI_CALL",
  sourceCallId: "call-1",
  externalCalendarEventId: "event-1",
};

function fixture(businessProfiles: VersionedBusinessProfile[] = [business]) {
  const findAvailableSlots = vi.fn(async () => success([{
    employeeId: "employee-1",
    startAt: "2026-08-10T15:00:00.000Z",
    endAt: "2026-08-10T15:30:00.000Z",
  }]));
  const scheduling = {
    findAvailableSlots,
    validateSlot: vi.fn(),
  } as unknown as SchedulingService;
  const createAppointment = vi.fn(async () => success(confirmedAppointment));
  const getAppointment = vi.fn(async () => success(confirmedAppointment));
  const cancelAppointment = vi.fn(async () => success({ ...confirmedAppointment, status: "CANCELLED" as const }));
  const rescheduleAppointment = vi.fn(async () => success({ ...confirmedAppointment, startAt: "2026-08-11T21:00:00.000Z", endAt: "2026-08-11T21:30:00.000Z" }));
  const listUpcomingAppointments = vi.fn(async () => [confirmedAppointment]);
  const appointments = {
    createAppointment,
    getAppointment,
    cancelAppointment,
    rescheduleAppointment,
    listUpcomingAppointments,
  } as unknown as AppointmentService;
  const transferToConfiguredDestination = vi.fn(async () => success(undefined));
  const transfer: HumanTransferPort = { transferToConfiguredDestination };
  const updateCustomer = vi.fn(async () => success({ id: "customer-1", tenantId: "tenant-a", name: "John Smith", phone: "9155551234" }));
  const customers = { updateCustomer, findOrCreateByPhone: vi.fn(async () => success({ id: "test-customer", tenantId: "tenant-a", name: "YIBO Test Patient", phone: "+15550000000" })) } as unknown as CustomerService;
  const businesses = new BusinessDirectoryService(new InMemoryBusinessRepository(businessProfiles));
  return {
    appointments,
    createAppointment,
    cancelAppointment,
    rescheduleAppointment,
    findAvailableSlots,
    getAppointment,
    listUpcomingAppointments,
    updateCustomer,
    customers,
    transferToConfiguredDestination,
    executor: new ToolExecutorImpl(scheduling, appointments, transfer, businesses, undefined, customers),
  };
}

const context = { tenantId: "tenant-a", locationId: "default", callId: "call-1", customerId: "customer-1", turnSequence: 1 };
const business: BusinessProfile = {
  region: "US", tenantId: "tenant-a", businessId: "business-a", name: "YIBO Dental", timezone: "America/Denver", locale: "en-US", active: true,
  calledNumbers: ["+19155550123"], employees: [{ id: "employee-1", displayName: "Dr. Alex", active: true }],
  services: [
    { id: "service-1", name: "Consultation", durationMinutes: 30, bufferMinutes: 0, eligibleEmployeeIds: ["employee-1"] },
    { id: "cleaning-1", name: "Cleaning", durationMinutes: 45, bufferMinutes: 0, eligibleEmployeeIds: ["employee-1"] },
  ],
  openingHours: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
};

describe("ToolExecutorImpl", () => {
  it.each([
    { tenantId: "tenant-other" }, { locationId: "south" },
    { customerId: "customer-other" }, { developerTestModeAuthorized: true as const },
  ])("does not reuse appointment references under changed scope %j", async (changed) => {
    const { executor, getAppointment } = fixture();
    await executor.execute(context, { toolCallId: "list", name: "list_customer_appointments", arguments: {} });
    await expect(executor.execute({ ...context, ...changed }, {
      toolCallId: "cancel", name: "cancel_appointment", arguments: { appointmentReference: "upcoming-1" },
    })).resolves.toMatchObject({ ok: false, error: { code: "APPOINTMENT_REFERENCE_NOT_FOUND" } });
    expect(getAppointment).not.toHaveBeenCalled();
    await expect(executor.execute(context, {
      toolCallId: "cancel-original", name: "cancel_appointment", arguments: { appointmentReference: "upcoming-1" },
    })).resolves.toMatchObject({ ok: true });
  });

  it("does not borrow another customer's cached availability with a reused call ID", async () => {
    const { executor, createAppointment } = fixture();
    await executor.execute(context, { toolCallId: "availability", name: "check_availability", arguments: {
      service: "Consultation", rangeStart: "2026-08-10T00:00:00Z", rangeEnd: "2026-08-11T00:00:00Z",
    } });
    await expect(executor.execute({ ...context, customerId: "customer-other" }, {
      toolCallId: "book-other", name: "create_appointment", arguments: {
        service: "Consultation", employeeId: "employee-1", startAt: "2026-08-10T16:00:00Z",
      },
    })).resolves.toMatchObject({ ok: true });
    expect(createAppointment).toHaveBeenCalledWith(expect.objectContaining({ customerId: "customer-other", startAt: "2026-08-10T16:00:00.000Z" }));
  });

  it("does not carry developer mode into an unauthorized context with the same call ID", async () => {
    const { executor, createAppointment } = fixture();
    await executor.execute({ ...context, developerTestModeAuthorized: true }, {
      toolCallId: "enable", name: "enable_developer_test_mode", arguments: {},
    });
    await executor.execute(context, { toolCallId: "book", name: "create_appointment",
      arguments: { service: "Consultation", employeeId: "employee-1", startAt: confirmedAppointment.startAt } });
    expect(createAppointment).toHaveBeenCalledWith(expect.objectContaining({ customerId: context.customerId, source: "AI_CALL" }));
  });

  it.each(["regionId", "developerTestModeAuthorized", "turnSequence", "calendarId", "unexpected"])("rejects hostile developer-tool argument %s", async (key) => {
    const { executor } = fixture();
    for (const name of ["enable_developer_test_mode", "delete_test_appointments"] as const) {
      await expect(executor.execute({ ...context, developerTestModeAuthorized: true }, {
        toolCallId: "hostile", name, arguments: { [key]: "caller-controlled" },
      })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_ARGUMENTS" } });
    }
  });

  it.each([
    "get_service_information", "list_customer_appointments", "check_availability", "create_appointment",
    "update_customer", "cancel_appointment", "reschedule_appointment", "transfer_to_human",
    "enable_developer_test_mode", "delete_test_appointments",
  ] as const)("rejects model-supplied context on %s before side effects", async (name) => {
    const fixtureValue = fixture();
    for (const key of ["tenantId", "locationId", "callId", "customerId", "idempotencyKey", "regionId", "turnSequence", "developerTestModeAuthorized"]) {
      for (const argumentsValue of [{ [key]: "hostile" }, { nested: [{ [key]: "hostile" }] }]) {
        await expect(fixtureValue.executor.execute({ ...context, developerTestModeAuthorized: true }, {
          toolCallId: "hostile", name, arguments: argumentsValue,
        })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_ARGUMENTS" } });
      }
    }
    for (const method of [fixtureValue.createAppointment, fixtureValue.cancelAppointment,
      fixtureValue.rescheduleAppointment, fixtureValue.findAvailableSlots, fixtureValue.getAppointment,
      fixtureValue.listUpcomingAppointments, fixtureValue.updateCustomer, fixtureValue.transferToConfiguredDestination]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("lists only public upcoming-appointment fields using trusted scope", async () => {
    const { executor, listUpcomingAppointments } = fixture();

    const result = await executor.execute(context, {
      toolCallId: "list-upcoming",
      name: "list_customer_appointments",
      arguments: {},
    });

    expect(listUpcomingAppointments).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      locationId: "default",
      customerId: "customer-1",
    });
    expect(result).toEqual({
      toolCallId: "list-upcoming",
      ok: true,
      data: { appointments: [{
        reference: "upcoming-1",
        service: "Consultation",
        startAt: "2026-08-10T15:00:00.000Z",
        endAt: "2026-08-10T15:30:00.000Z",
        localStartAt: "2026-08-10T09:00:00-06:00",
        localEndAt: "2026-08-10T09:30:00-06:00",
        displayStart: expect.stringContaining("9:00 AM"),
        timezone: "America/Denver",
        location: "YIBO Dental",
        professional: "Dr. Alex",
        price: { amountMinor: 0, currency: "USD", display: expect.any(String) },
      }] },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("appointment-1");
    expect(serialized).not.toContain("employee-1");
    expect(serialized).not.toContain("service-1");
  });

  it("requires a verified customer before listing appointments", async () => {
    const { executor, listUpcomingAppointments } = fixture();
    const result = await executor.execute(
      { tenantId: "tenant-a", locationId: "default", callId: "anonymous-call", turnSequence: 1 },
      { toolCallId: "list-anonymous", name: "list_customer_appointments", arguments: {} },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "CUSTOMER_REQUIRED" } });
    expect(listUpcomingAppointments).not.toHaveBeenCalled();
  });

  it("returns public service, price, and branch information without internal IDs", async () => {
    const profile = structuredClone(DEVELOPMENT_BUSINESS);
    profile.tenantId = "tenant-a";
    profile.businessId = "business-public-catalog";
    profile.locations[0]!.name = "Centro Norte";
    profile.locations[0]!.services[0]!.price.amountMinor = 12_500;
    profile.locations.push({
      ...structuredClone(profile.locations[0]!),
      id: "south-internal-id",
      name: "Centro Sur",
      calledNumbers: ["+529991000099"],
      services: profile.locations[0]!.services.map((offer) => ({
        ...offer,
        price: { ...offer.price, amountMinor: offer.serviceId === "consultation" ? 15_000 : offer.price.amountMinor },
      })),
    });
    const { executor } = fixture([profile]);

    const result = await executor.execute(context, {
      toolCallId: "service-info",
      name: "get_service_information",
      arguments: { service: "Consulta" },
    });

    expect(result).toEqual({
      toolCallId: "service-info",
      ok: true,
      data: {
        services: [{
          name: "Consulta",
          description: "Consulta general",
          durationMinutes: 30,
          locations: [
            { name: "Centro Norte", price: { amountMinor: 12_500, currency: "MXN", display: expect.any(String) } },
            { name: "Centro Sur", price: { amountMinor: 15_000, currency: "MXN", display: expect.any(String) } },
          ],
        }],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("south-internal-id");
    expect(serialized).not.toContain("employee-1");
    expect(serialized).not.toContain('"consultation"');
    expect(serialized).not.toContain('"default"');
  });

  it("allows Developer Test Mode only from server-authorized local contexts", async () => {
    const { executor } = fixture();
    const denied = await executor.execute(context, { toolCallId: "test-denied", name: "enable_developer_test_mode", arguments: {} });
    const allowed = await executor.execute({ ...context, callId: "developer-call", developerTestModeAuthorized: true }, { toolCallId: "test-enabled", name: "enable_developer_test_mode", arguments: {} });

    expect(denied).toMatchObject({ ok: false, error: { code: "TEST_MODE_NOT_AUTHORIZED" } });
    expect(allowed).toMatchObject({ ok: true, data: { enabled: true } });
  });

  it("creates and deletes only appointments created during the authorized test session", async () => {
    const { executor, createAppointment, cancelAppointment } = fixture();
    const developerContext = { ...context, callId: "developer-call", developerTestModeAuthorized: true as const };

    await executor.execute(developerContext, { toolCallId: "enable-test", name: "enable_developer_test_mode", arguments: {} });
    await executor.execute(developerContext, {
      toolCallId: "create-test", name: "create_appointment",
      arguments: { service: "Consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z" },
    });
    const deleted = await executor.execute(developerContext, { toolCallId: "delete-test", name: "delete_test_appointments", arguments: {} });

    expect(createAppointment).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "test-customer", source: "DEVELOPER_TEST", sourceCallId: "developer-call",
    }));
    expect(deleted).toEqual({ toolCallId: "delete-test", ok: true, data: { deleted: 1 } });
    expect(cancelAppointment).toHaveBeenCalledWith({ tenantId: "tenant-a", locationId: "default", appointmentId: "appointment-1" });
  });

  it("cannot delete normal appointments through a public session", async () => {
    const { executor, cancelAppointment } = fixture();
    const result = await executor.execute(context, { toolCallId: "delete-public", name: "delete_test_appointments", arguments: {} });

    expect(result).toMatchObject({ ok: false, error: { code: "TEST_MODE_NOT_AUTHORIZED" } });
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it("uses the trusted tenant when checking availability", async () => {
    const { executor, findAvailableSlots } = fixture();
    const result = await executor.execute(context, {
      toolCallId: "tool-1",
      name: "check_availability",
      arguments: {
        service: "Consultation",
        rangeStart: "2026-08-10T00:00:00.000Z",
        rangeEnd: "2026-08-11T00:00:00.000Z",
      },
    });

    expect(result.ok).toBe(true);
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a", locationId: "default",
    }));
  });

  it("automatically selects the clinic default service for a natural date and returns the earliest slot", async () => {
    const { findAvailableSlots } = fixture();
    // The production executor receives the business directory and clock from bootstrap.
    const scheduling = { findAvailableSlots, validateSlot: vi.fn() } as unknown as SchedulingService;
    const datedExecutor = new ToolExecutorImpl(
      scheduling,
      {} as AppointmentService,
      { transferToConfiguredDestination: vi.fn() },
      new BusinessDirectoryService(new InMemoryBusinessRepository([business])),
      { now: () => new Date("2026-08-30T18:00:00.000Z") },
    );
    const result = await datedExecutor.execute(context, {
      toolCallId: "tool-date", name: "check_availability", arguments: { dateExpression: "this week" },
    });

    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: "service-1",
      rangeStart: "2026-08-31T06:00:00.000Z", rangeEnd: "2026-09-07T06:00:00.000Z",
    }));
    expect(result).toMatchObject({ ok: true, data: { earliestSlot: { startAt: "2026-08-10T15:00:00.000Z" }, resolvedDate: "this week" } });
  });

  it("rejects model attempts to override trusted context", async () => {
    const { executor, findAvailableSlots } = fixture();
    const result = await executor.execute(context, {
      toolCallId: "tool-1",
      name: "check_availability",
      arguments: {
        tenantId: "tenant-b",
        locationId: "other-location",
        service: "Consultation",
        rangeStart: "2026-08-10T00:00:00.000Z",
        rangeEnd: "2026-08-11T00:00:00.000Z",
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_ARGUMENTS" } });
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });

  it("builds appointment commands only from validated arguments and trusted session fields", async () => {
    const { createAppointment, executor } = fixture();
    const result = await executor.execute(context, {
      toolCallId: "tool-42",
      name: "create_appointment",
      arguments: {
        service: "Consultation",
        employeeId: "employee-1",
        startAt: "2026-08-10T15:00:00.000Z",
      },
    });

    expect(result.ok).toBe(true);
    expect(result).toEqual({
      toolCallId: "tool-42",
      ok: true,
      data: {
        confirmed: true,
        service: "Consultation",
        startAt: "2026-08-10T15:00:00.000Z",
        endAt: "2026-08-10T15:30:00.000Z",
        localStartAt: "2026-08-10T09:00:00-06:00",
        localEndAt: "2026-08-10T09:30:00-06:00",
        displayStart: expect.stringContaining("9:00 AM"),
        timezone: "America/Denver",
        location: "YIBO Dental",
        professional: "Dr. Alex",
        nextStep: expect.stringContaining("professional name"),
        price: { amountMinor: 0, currency: "USD", display: expect.any(String) },
      },
    });
    expect(JSON.stringify(result)).not.toContain("appointment-1");
    expect(JSON.stringify(result)).not.toContain("customer-1");
    expect(JSON.stringify(result)).not.toContain("employee-1");
    expect(JSON.stringify(result)).not.toContain("service-1");
    expect(createAppointment).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      locationId: "default",
      customerId: "customer-1",
      serviceId: "service-1",
      employeeId: "employee-1",
      startAt: "2026-08-10T15:00:00.000Z",
      idempotencyKey: "call-1:tool-42",
      source: "AI_CALL",
      sourceCallId: "call-1",
    });
  });

  it("normalizes a caller's bare local time in the clinic timezone before booking", async () => {
    const { createAppointment, executor } = fixture();
    await executor.execute(context, {
      toolCallId: "tool-local-time",
      name: "create_appointment",
      arguments: { service: "Consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00" },
    });

    expect(createAppointment).toHaveBeenCalledWith(expect.objectContaining({
      startAt: "2026-08-10T21:00:00.000Z",
    }));
  });

  it("books the verified 3:00 PM availability instant instead of a reconstructed 3:00 PM UTC value", async () => {
    const { appointments, createAppointment, findAvailableSlots } = fixture();
    const validateSlot = vi.fn(async (query: { startAt: string; employeeId: string }) => success({
      employeeId: query.employeeId,
      startAt: query.startAt,
      endAt: "2026-08-10T21:30:00.000Z",
      validatedAt: "2026-08-10T00:00:00.000Z",
    }));
    const executor = new ToolExecutorImpl(
      { findAvailableSlots, validateSlot } as unknown as SchedulingService,
      appointments,
      { transferToConfiguredDestination: vi.fn() },
      new BusinessDirectoryService(new InMemoryBusinessRepository([business])),
      { now: () => new Date("2026-08-10T12:00:00.000Z") },
    );

    await executor.execute(context, {
      toolCallId: "tool-check-3pm",
      name: "check_availability",
      arguments: {
        service: "Consultation", employeeId: "employee-1",
        rangeStart: "2026-08-10T00:00", rangeEnd: "2026-08-11T00:00",
        requestedStartAt: "2026-08-10T15:00",
      },
    });
    await executor.execute(context, {
      toolCallId: "tool-book-3pm",
      name: "create_appointment",
      // This simulates the original failure mode: the model incorrectly labels 3 PM as UTC.
      arguments: { service: "Consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z" },
    });

    expect(createAppointment).toHaveBeenCalledWith(expect.objectContaining({
      startAt: "2026-08-10T21:00:00.000Z",
    }));
  });

  it("does not book a rebuilt UTC time that is not one of the available slots", async () => {
    const { appointments, createAppointment, executor, findAvailableSlots } = fixture();
    findAvailableSlots.mockResolvedValueOnce(success([{
      employeeId: "employee-1",
      startAt: "2026-08-10T21:00:00.000Z",
      endAt: "2026-08-10T21:30:00.000Z",
    }]));

    await executor.execute(context, {
      toolCallId: "tool-check-slots",
      name: "check_availability",
      arguments: {
        service: "Consultation", employeeId: "employee-1",
        rangeStart: "2026-08-10T00:00", rangeEnd: "2026-08-11T00:00",
      },
    });
    const result = await executor.execute(context, {
      toolCallId: "tool-book-rebuilt-utc",
      name: "create_appointment",
      // 3 PM local incorrectly rebuilt as 3 PM UTC would be 9 AM in Denver.
      arguments: { service: "Consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "SLOT_NOT_REVALIDATED" } });
    expect(createAppointment).not.toHaveBeenCalled();
    expect(appointments.createAppointment).not.toHaveBeenCalled();
  });

  it("does not create an appointment without a verified customer", async () => {
    const { createAppointment, executor } = fixture();
    const result = await executor.execute({ tenantId: "tenant-a", locationId: "default", callId: "call-1", turnSequence: 1 }, {
      toolCallId: "tool-1",
      name: "create_appointment",
      arguments: { service: "Consultation", employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CUSTOMER_REQUIRED" } });
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("verifies appointment ownership before cancellation", async () => {
    const { cancelAppointment, executor, getAppointment } = fixture();
    await executor.execute(context, {
      toolCallId: "list-before-cancel", name: "list_customer_appointments", arguments: {},
    });
    getAppointment.mockResolvedValueOnce(success({ ...confirmedAppointment, customerId: "customer-2" }));
    const result = await executor.execute(context, {
      toolCallId: "tool-1",
      name: "cancel_appointment",
      arguments: { appointmentReference: "upcoming-1" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "APPOINTMENT_NOT_FOUND" } });
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it("reschedules only an appointment owned by the verified caller using the clinic timezone", async () => {
    const { executor, rescheduleAppointment } = fixture();
    await executor.execute(context, {
      toolCallId: "list-before-reschedule", name: "list_customer_appointments", arguments: {},
    });
    const result = await executor.execute(context, {
      toolCallId: "tool-reschedule", name: "reschedule_appointment",
      arguments: { appointmentReference: "upcoming-1", startAt: "2026-08-11T15:00" },
    });

    expect(rescheduleAppointment).toHaveBeenCalledWith({
      tenantId: "tenant-a", locationId: "default", appointmentId: "appointment-1", startAt: "2026-08-11T21:00:00.000Z", expectedVersion: 1,
    });
    expect(result).toEqual({
      toolCallId: "tool-reschedule",
      ok: true,
      data: {
        rescheduled: true,
        reference: "upcoming-1",
        startAt: "2026-08-11T21:00:00.000Z",
        endAt: "2026-08-11T21:30:00.000Z",
      },
    });
    expect(JSON.stringify(result)).not.toContain("appointment-1");
  });

  it("rejects internal IDs and references issued to another call", async () => {
    const { cancelAppointment, executor } = fixture();
    await executor.execute(context, {
      toolCallId: "list-reference", name: "list_customer_appointments", arguments: {},
    });

    const internalId = await executor.execute(context, {
      toolCallId: "cancel-internal-id", name: "cancel_appointment",
      arguments: { appointmentId: "appointment-1" },
    });
    const otherCall = await executor.execute({ ...context, callId: "call-2" }, {
      toolCallId: "cancel-other-call", name: "cancel_appointment",
      arguments: { appointmentReference: "upcoming-1" },
    });

    expect(internalId).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_ARGUMENTS" } });
    expect(otherCall).toMatchObject({ ok: false, error: { code: "APPOINTMENT_REFERENCE_NOT_FOUND" } });
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it("maps a patient-facing service and saves contact details without returning them", async () => {
    const { createAppointment, executor, updateCustomer } = fixture();
    const contactResult = await executor.execute(context, {
      toolCallId: "tool-contact", name: "update_customer", arguments: { name: "John Smith", phone: "915-555-1234" },
    });
    const appointmentResult = await executor.execute(context, {
      toolCallId: "tool-cleaning", name: "create_appointment", arguments: { service: "Cleaning", employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z" },
    });

    expect(updateCustomer).toHaveBeenCalledWith({ tenantId: "tenant-a", customerId: "customer-1", name: "John Smith", phone: "915-555-1234" });
    expect(contactResult).toEqual({ toolCallId: "tool-contact", ok: true, data: { saved: true, contactConfirmedForBooking: true } });
    expect(JSON.stringify(contactResult)).not.toContain("John Smith");
    expect(JSON.stringify(contactResult)).not.toContain("915-555-1234");
    expect(createAppointment).toHaveBeenCalledWith(expect.objectContaining({ serviceId: "cleaning-1" }));
    expect(appointmentResult.ok).toBe(true);
  });

  it("requires a first and last name before saving customer details", async () => {
    const { executor, updateCustomer } = fixture();
    const result = await executor.execute(context, {
      toolCallId: "tool-contact", name: "update_customer", arguments: { name: "John", phone: "915-555-1234" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_ARGUMENTS" } });
    expect(updateCustomer).not.toHaveBeenCalled();
  });

  it("requires contact confirmation in the current call before a real booking", async () => {
    const value = fixture();
    value.customers.getCustomer = vi.fn(async () => success({
      id: "customer-1", tenantId: "tenant-a", phone: "9155551234",
    }));
    const appointment = { toolCallId: "book", name: "create_appointment" as const,
      arguments: { service: "Consultation", employeeId: "employee-1", startAt: confirmedAppointment.startAt } };

    await expect(value.executor.execute(context, appointment)).resolves.toMatchObject({
      ok: false, error: { code: "CONTACT_CONFIRMATION_REQUIRED" },
    });
    await value.executor.execute(context, {
      toolCallId: "contact", name: "update_customer", arguments: { name: "John Smith", phone: "915-555-1234" },
    });
    await expect(value.executor.execute(context, appointment)).resolves.toMatchObject({ ok: true });
  });

  it("does not accept an arbitrary transfer destination", async () => {
    const { executor, transferToConfiguredDestination } = fixture();
    const result = await executor.execute(context, {
      toolCallId: "tool-1",
      name: "transfer_to_human",
      arguments: { destination: "sip:attacker@example.com" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_ARGUMENTS" } });
    expect(transferToConfiguredDestination).not.toHaveBeenCalled();
  });

  it("transfers using only the tenant-configured destination port", async () => {
    const { executor, transferToConfiguredDestination } = fixture();
    const result = await executor.execute(context, {
      toolCallId: "tool-1",
      name: "transfer_to_human",
      arguments: {},
    });

    expect(result).toEqual({ toolCallId: "tool-1", ok: true, data: { transferred: true } });
    expect(transferToConfiguredDestination).toHaveBeenCalledWith({ tenantId: "tenant-a", locationId: "default", callId: "call-1" });
  });
});
