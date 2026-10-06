import type { AgentToolDefinition } from "./contracts.js";

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "get_service_information",
    description: "List active patient-facing services with their descriptions, duration, prices, and the branch names where each is offered. Optionally filter by an exact service name. Never expose or ask for internal IDs.",
    presentation: { title: "Service information", help: "Reads public service, price, and branch information without exposing internal identifiers.", route: "BusinessDirectory", icon: "ⓘ", kind: "consult" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        service: { type: "string", minLength: 1, description: "Optional patient-facing service name." },
      },
    },
  },
  {
    name: "list_customer_appointments",
    description: "List upcoming confirmed appointments for the verified customer at the branch reached by this call. Returns opaque conversational references instead of internal appointment IDs.",
    presentation: { title: "Upcoming appointments", help: "Reads the verified caller's upcoming appointments at this branch without exposing database IDs.", route: "Appointments", icon: "◷", kind: "consult" },
    inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    name: "check_availability",
    description: "Find real clinic-calendar appointment slots. Always supply dateExpression or both rangeStart and rangeEnd, even when requestedStartAt is given. service is an optional patient-facing choice such as Cleaning or Consultation; omit it to use the clinic's configured default appointment type. Never ask for or expose an internal service ID. When the caller asks about an exact time, also include requestedStartAt as an ISO datetime. Results are verified, privacy-safe, and sorted earliest first. Speak displayStart/localStartAt only; startAt is the original UTC instant to pass unchanged to the booking tool.",
    presentation: { title: "Check availability", help: "Reviews services, professionals, and available times. It does not change data.", route: "Scheduling", icon: "⌕", kind: "consult" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        service: { type: "string", minLength: 1, description: "Optional patient-facing service choice, for example Cleaning or Consultation." },
        employeeId: { type: "string", minLength: 1, description: "Optional opaque professional reference supplied by verified business or availability data. Copy it unchanged; never invent or speak it." },
        dateExpression: { type: "string", minLength: 1, description: "Use YYYY-MM-DD for an explicit calendar date. Otherwise use only: today, tomorrow, this week, next week, or an English weekday optionally prefixed with this/next. Do not include a time or a spelled-out month. Use either dateExpression or rangeStart/rangeEnd, never both." },
        rangeStart: { type: "string", format: "date-time" },
        rangeEnd: { type: "string", format: "date-time" },
        requestedStartAt: { type: "string", format: "date-time", description: "Optional exact appointment time. Copy a returned slot's startAt unchanged whenever possible. If constructing from a caller saying 3 PM, send 2026-09-02T15:00 without Z; never label a local clock time as UTC." },
      },
    },
  },
  {
    name: "create_appointment",
    description: "Request creation of an appointment for the verified customer in this call. Use a verified slot and patient-facing service name. Backend validation and any configured confirmation gate retain authority; only a successful public result confirms the booking.",
    presentation: { title: "Create appointments", help: "Requests a booking; YIBO validates identity, availability, and idempotency.", route: "Appointments", icon: "+", kind: "mutate" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["employeeId", "startAt"],
      properties: {
        service: { type: "string", minLength: 1, description: "Patient-facing service choice: Cleaning or Consultation. Omit only when the clinic default was already selected." },
        employeeId: { type: "string", minLength: 1, description: "Optional opaque professional reference supplied by verified business or availability data. Copy it unchanged; never invent or speak it." },
        startAt: { type: "string", format: "date-time", description: "Copy the accepted calendar slot's startAt exactly. Never reconstruct it as UTC or use the server timezone." },
        confirmationToken: { type: "string", minLength: 1, description: "Opaque token returned by a prior confirmation request for these exact arguments." },
      },
    },
  },
  {
    name: "update_customer",
    description: "Save approved contact details for the verified caller before booking. Collect the full name and callback number, repeat the number digit by digit, wait for the caller to confirm it, then call this tool. Success is the only authority that the details were saved.",
    presentation: { title: "Update customer", help: "Saves the verified caller's name and callback number without returning personal data to the model.", route: "Customers", icon: "✎", kind: "mutate" },
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: {
      name: { type: "string", minLength: 3 }, phone: { type: "string", minLength: 7 },
      email: { type: "string", format: "email" }, preferredLanguage: { type: "string", minLength: 2 },
      confirmationToken: { type: "string", minLength: 1, description: "Opaque token returned by a prior confirmation request for these exact arguments." },
    } },
  },
  {
    name: "cancel_appointment",
    description: "Request cancellation of an appointment owned by the verified customer using an opaque appointmentReference returned by list_customer_appointments in this call. Only success authorizes saying it was cancelled.",
    presentation: { title: "Cancel appointments", help: "Uses a same-call public reference and rechecks that the appointment belongs to the verified customer.", route: "Appointments", icon: "×", kind: "mutate" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["appointmentReference"],
      properties: {
        appointmentReference: { type: "string", minLength: 1, description: "Opaque reference returned by list_customer_appointments." },
        confirmationToken: { type: "string", minLength: 1, description: "Opaque token returned by a prior confirmation request for these exact arguments." },
      },
    },
  },
  {
    name: "reschedule_appointment",
    description: "Request rescheduling an appointment owned by the verified customer. Use an opaque appointmentReference returned in this call and an exact verified slot. Backend success is authoritative; never reconstruct a local time as UTC.",
    presentation: { title: "Reschedule appointments", help: "Uses a same-call public reference, checks the new time, and updates the calendar only when the change succeeds.", route: "Appointments", icon: "↺", kind: "mutate" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["appointmentReference", "startAt"],
      properties: {
        appointmentReference: { type: "string", minLength: 1, description: "Opaque reference returned by list_customer_appointments." },
        startAt: { type: "string", format: "date-time", description: "Copy the accepted availability slot startAt unchanged." },
        confirmationToken: { type: "string", minLength: 1, description: "Opaque token returned by a prior confirmation request for these exact arguments." },
      },
    },
  },
  {
    name: "transfer_to_human",
    description: "Request transfer of this call to the business's server-configured human destination. The model cannot choose the destination and may claim transfer only after success.",
    presentation: { title: "Transfer to a person", help: "Requests a transfer to the business's configured destination.", route: "HumanTransferPort", icon: "↗", kind: "external" },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "enable_developer_test_mode",
    description: "Enable local Developer Test Mode. This is only available to a server-authorized local developer session; never claim it is enabled unless this tool succeeds.",
    presentation: { title: "Enable test mode", help: "Enables isolated local fixtures for an authorized developer session.", route: "DeveloperTest", icon: "⚙", kind: "mutate" },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "delete_test_appointments",
    description: "Delete only test appointments created during this authorized Developer Test Mode session. Never use this for normal patient appointments.",
    presentation: { title: "Delete test appointments", help: "Removes only appointments created by the current isolated test session.", route: "DeveloperTest", icon: "⌫", kind: "mutate" },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

export const isDeveloperTestTool = (name: string): boolean =>
  name === "enable_developer_test_mode" || name === "delete_test_appointments";

export const PUBLIC_AGENT_TOOL_DEFINITIONS = AGENT_TOOL_DEFINITIONS
  .filter(({ name }) => !isDeveloperTestTool(name));
