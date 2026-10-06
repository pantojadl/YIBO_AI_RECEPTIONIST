import type { LocationCalendarSnapshot } from "../../../src/modules/business/index.js";
import type { GoogleCalendarAccessStatus } from "../../../src/modules/integrations/index.js";
import type { EditableBusinessConfiguration, VersionedBusinessConfiguration, TenantServiceDefinition, ProfessionalDefinition, LocationProfessionalAssignment } from "../../../src/modules/business/index.js";
import type { AvailableSlot } from "../../../src/modules/scheduling/index.js";
import type { AvailabilitySuggestionsPolicy } from "../../../src/modules/business/domain/multi-location-business.js";

export interface ServiceDefinition {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  eligibleEmployeeIds: string[];
}

export interface EmployeeDefinition { id: string; displayName: string; active: boolean }
export interface OpeningHoursRule { dayOfWeek: number; startTime: string; endTime: string }

export interface Business {
  region: "MX" | "US";
  name: string;
  timezone: string;
  locale: string;
  services: ServiceDefinition[];
  employees: EmployeeDefinition[];
  openingHours: OpeningHoursRule[];
}

export interface Customer { id: string; tenantId: string; phone: string; name?: string; email?: string;
  preferredLanguage?: string; emailOptIn?: boolean; source?: string; createdAt?: string; updatedAt?: string }
export interface DirectoryCustomer extends Customer { appointmentCount: number; professionalIds: string[];
  nextAppointmentAt?: string; lastAppointmentAt?: string }
export interface DirectoryProfessional { id: string; name: string; active: boolean; patientIds: string[] }
export type Slot = AvailableSlot;
export interface AppointmentLocation { id: string; name: string; active: boolean; timezone: string;
  minimumCancellationNoticeMinutes: number; minimumRescheduleNoticeMinutes: number;
  cancellationAllowed?: boolean; reschedulingAllowed?: boolean; staffOverrideAllowed?: boolean;
  services: ServiceDefinition[];
  professionals: Array<{ id: string; displayName: string; name: string; serviceIds: string[] }>;
  availabilitySuggestions: AvailabilitySuggestionsPolicy;
}
export type AvailabilityLocation = AppointmentLocation;

export interface Appointment {
  version?: number;
  locationId: string;
  serviceNameSnapshot: string;
  priceAmountMinor: number;
  priceCurrency: string;
  id: string;
  customerId: string;
  serviceId: string;
  employeeId: string;
  startAt: string;
  endAt: string;
  status: string;
  externalCalendarEventId?: string;
  outcomeStatus?: "COMPLETED" | "NO_SHOW";
}
export interface AppointmentCalendarEntry extends Appointment {
  customerName?: string;
  customerPhone?: string;
  professionalName: string;
}
export interface AppointmentEvent { id: string; appointmentId: string; type: string; occurredAt: string; actorType: string; metadata?: Record<string, string> }
export interface NotificationDelivery { id: string; kind: string; status: string; destinationMasked: string; createdAt: string; errorCode?: string }
export interface GoogleCalendarStatus { configured: boolean; connected: boolean }
export interface Readiness { ready: boolean; blockers: string[]; providers: Record<string, boolean>;
  locations: Array<{ id: string; name: string; ready: boolean; issues: string[] }> }
export type AdminRole = "owner" | "office_manager" | "secretary" | "read_only" | "tenant_admin" | "operator";
export interface AdminPrincipal {
  subject: string;
  tenantId: string;
  roles: AdminRole[];
  issuedAt: string;
  expiresAt: string;
}

export type AgentToolName = "get_service_information" | "list_customer_appointments" | "check_availability" | "create_appointment" | "update_customer" | "cancel_appointment" | "reschedule_appointment" | "transfer_to_human";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";
export type TurnDetectionMode = "server_vad" | "semantic_vad" | "manual";

export type AgentTurnDetection =
  | { type: "server_vad"; threshold?: number; prefixPaddingMs?: number; silenceDurationMs?: number; idleTimeoutMs?: number | null; createResponse: boolean; interruptResponse: boolean }
  | { type: "semantic_vad"; eagerness: "auto" | "low" | "medium" | "high"; createResponse: boolean; interruptResponse: boolean }
  | { type: "manual" };

export interface AgentConfiguration {
  schemaVersion: 4;
  identity: { instructions: string; locale: string };
  enabledTools: AgentToolName[];
  conversation: {
    model: string;
    maxOutputTokens: number;
    reasoningEffort: ReasoningEffort;
    tracing: "disabled" | "auto";
    truncation: { mode: "auto" | "disabled" } | { mode: "retention_ratio"; retentionRatio: number; postInstructionsTokens?: number };
  };
  audio: { voice: string; noiseReduction: "disabled" | "near_field" | "far_field"; turnDetection: AgentTurnDetection };
  behavior: {
    greeting: { mode: "wait_for_caller" } | { mode: "automatic"; message: string };
    responseStyle: { brevity: "brief" | "balanced" | "detailed"; tone: "warm" | "professional" | "direct"; pace: "slow" | "balanced" | "fast" };
    silence: { message: string; maxPrompts: number };
    allowPriceDisclosure?: boolean;
    phoneReadback?: "natural_grouped" | "digit_by_digit";
    slotOffering: { maximumOptions: number; strategy: "earliest_first" | "spread_across_day" | "match_requested_time" };
    dataCollectionOrder: Array<"full_name" | "phone_number" | "service">;
  };
  toolPolicies: {
    channels: Record<"phone" | "voice_lab", { enabledTools: AgentToolName[]; toolChoice: "auto" | "required" | "none"; parallelToolCalls: boolean }>;
    limits: { totalPerCall: number; perTool: Partial<Record<AgentToolName, number>> };
    externalRetryAttempts: number;
    automaticTransfer: { onLimitReached: boolean; onRetryableFailure: boolean };
    confirmations: { requiredFor: AgentToolName[] };
  };
}

export interface RealtimeModelCapability {
  id: string;
  label: string;
  badge: string;
  description: string;
  voices: string[];
  pricing: RealtimeModelPricing;
  limits: {
    contextWindowTokens: number;
    modelMaxOutputTokens: number;
    responseOutputTokens: { minimum: number; maximum: number; uiMinimum: number; step: number };
  };
  controls: {
    reasoningEfforts: ReasoningEffort[];
    turnDetectionModes: TurnDetectionMode[];
    semanticVadEagerness: Array<"auto" | "low" | "medium" | "high">;
    noiseReductionModes: Array<"disabled" | "near_field" | "far_field">;
    serverVad: {
      threshold: { minimum: number; maximum: number };
      prefixPaddingMs: { minimum: number; maximum: number };
      silenceDurationMs: { minimum: number; maximum: number };
    };
    idleTimeoutMs: { minimum: number; maximum: number };
    automaticResponse: boolean;
    responseInterruption: boolean;
    parallelToolCalls: boolean;
    toolChoice: boolean;
    tracing: boolean;
    truncation: boolean;
  };
}

export interface RealtimeModelPricing {
  currency: "USD";
  unitTokens: 1_000_000;
  verifiedAt: string;
  sourceUrl: string;
  text: { input: number; cachedInput: number; output: number };
  audio: { input: number; cachedInput: number; output: number };
}

export interface AgentConfigurationPayload {
  revision: string;
  current: AgentConfiguration | null;
  recommended: AgentConfiguration;
  modelCapabilities: RealtimeModelCapability[];
  availableTools: Array<{
    name: AgentToolName;
    description: string;
    title: string;
    help: string;
    route: string;
    icon: string;
    kind: "consult" | "mutate" | "external";
  }>;
  secrets: { apiKeyConfigured: boolean };
}

export type VerifiedCalendarSnapshot = Omit<LocationCalendarSnapshot, "professionals"> & {
  defaultCalendarStatus?: GoogleCalendarAccessStatus | "unconfigured";
  professionals: Array<LocationCalendarSnapshot["professionals"][number] & {
    effectiveCalendarStatus?: GoogleCalendarAccessStatus | "unconfigured";
  }>;
};

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

const authenticationFailureHandlers = new Set<() => void>();

export function onAuthenticationFailure(handler: () => void): () => void {
  authenticationFailureHandlers.add(handler);
  return () => authenticationFailureHandlers.delete(handler);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...options?.headers },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const code = errorCode(body);
    if (response.status === 401 && url !== "/api/auth/login") {
      for (const handler of authenticationFailureHandlers) handler();
    }
    throw new ApiError(code, response.status);
  }
  return body as T;
}

function errorCode(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return "HTTP_ERROR";
  const error = body.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return "HTTP_ERROR";
  return typeof error.code === "string" ? error.code : "HTTP_ERROR";
}

export const api = {
  login: (credentials: { email: string; password: string }) => request<{ principal: AdminPrincipal }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify(credentials) },
  ),
  logout: () => request<{ loggedOut: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ principal: AdminPrincipal }>("/api/auth/me"),
  health: () => request<{ status: string }>("/api/health"),
  readiness: () => request<Readiness>("/api/admin/readiness"),
  business: () => request<Business>("/api/business"),
  locationCalendars: (id: string) => request<VerifiedCalendarSnapshot>(`/api/admin/locations/${encodeURIComponent(id)}/calendars`),
  updateLocationCalendar: (id: string, calendarId: string | null, version: number) => request<VerifiedCalendarSnapshot>(`/api/admin/locations/${encodeURIComponent(id)}/calendar`, {
    method: "PUT", headers: { "if-match": `"${version}"` }, body: JSON.stringify({ calendarId }),
  }),
  updateProfessionalCalendar: (locationId: string, id: string, calendarId: string | null, version: number) => request<VerifiedCalendarSnapshot>(`/api/admin/locations/${encodeURIComponent(locationId)}/professionals/${encodeURIComponent(id)}/calendar`, {
    method: "PUT", headers: { "if-match": `"${version}"` }, body: JSON.stringify({ calendarId }),
  }),
  businessConfiguration: () => request<VersionedBusinessConfiguration>("/api/admin/business-configuration"),
  updateBusinessConfiguration: (configuration: EditableBusinessConfiguration, version: number) =>
    request<VersionedBusinessConfiguration>("/api/admin/business-configuration", {
      method: "PUT", headers: { "if-match": `"${version}"` }, body: JSON.stringify({ configuration }),
    }),
  createService: (service: TenantServiceDefinition, version: number) => request<{ version: number; service: TenantServiceDefinition }>("/api/admin/services", {
    method: "POST", headers: { "if-match": `"${version}"` }, body: JSON.stringify(service),
  }),
  updateService: (id: string, service: Omit<TenantServiceDefinition, "id">, version: number) => request<{ version: number; service: TenantServiceDefinition }>(`/api/admin/services/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "if-match": `"${version}"` }, body: JSON.stringify(service),
  }),
  createProfessional: (professional: ProfessionalDefinition, version: number) => request<{ version: number; professional: ProfessionalDefinition }>("/api/admin/professionals", {
    method: "POST", headers: { "if-match": `"${version}"` }, body: JSON.stringify(professional),
  }),
  updateProfessional: (id: string, professional: Omit<ProfessionalDefinition, "id">, version: number) => request<{ version: number; professional: ProfessionalDefinition }>(`/api/admin/professionals/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "if-match": `"${version}"` }, body: JSON.stringify(professional),
  }),
  setProfessionalAssignment: (locationId: string, id: string, assignment: Omit<LocationProfessionalAssignment, "professionalId">, version: number) => request<{ version: number; assignment: LocationProfessionalAssignment }>(`/api/admin/locations/${encodeURIComponent(locationId)}/professionals/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "if-match": `"${version}"` }, body: JSON.stringify(assignment),
  }),
  updateBusinessTimezone: (timezone: string) => request<Business>("/api/business/timezone", {
    method: "PUT",
    body: JSON.stringify({ timezone }),
  }),
  findOrCreateCustomer: (input: { name: string; phone: string; email?: string; preferredLanguage?: string; emailOptIn?: boolean }) =>
    request<Customer>("/api/customers", { method: "POST", body: JSON.stringify(input) }),
  availability: (input: { locationId?: string; serviceId: string; employeeId?: string; rangeStart: string; rangeEnd: string }) => {
    const query = new URLSearchParams(input);
    return request<{ slots: Slot[] }>(`/api/availability?${query}`);
  },
  searchCustomers: (q: string, limit = 100) => request<{ customers: Customer[] }>(`/api/customers?${new URLSearchParams({ q, limit: String(limit) })}`),
  officeDirectory: () => request<{ customers: DirectoryCustomer[]; professionals: DirectoryProfessional[] }>("/api/office/directory"),
  customer: (id: string) => request<Customer>(`/api/customers/${encodeURIComponent(id)}`),
  customerHistory: (id: string) => request<{ appointments: Appointment[] }>(`/api/customers/${encodeURIComponent(id)}/appointments`),
  updateCustomer: (id: string, input: Partial<Pick<Customer, "name" | "phone" | "email" | "preferredLanguage" | "emailOptIn">>) =>
    request<Customer>(`/api/customers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  createAppointment: (input: { locationId?: string; customerId: string; serviceId: string; employeeId: string; startAt: string; idempotencyKey: string }) =>
    request<Appointment>("/api/appointments", {
      method: "POST",
      body: JSON.stringify({
        locationId: input.locationId,
        customerId: input.customerId,
        serviceId: input.serviceId,
        employeeId: input.employeeId,
        startAt: input.startAt,
      }),
      headers: { "idempotency-key": input.idempotencyKey },
    }),
  appointmentLocations: () => request<{ locations: AvailabilityLocation[] }>("/api/appointment-locations"),
  appointmentCalendar: (locationId: string, range: { rangeStart: string; rangeEnd: string }) =>
    request<{ appointments: AppointmentCalendarEntry[] }>(`/api/locations/${encodeURIComponent(locationId)}/appointment-calendar?${new URLSearchParams(range)}`),
  officeSchedule: (input: { locationId: string; rangeStart: string; rangeEnd: string; employeeId?: string; serviceId?: string; status?: string }) =>
    request<{ appointments: Appointment[]; slots: Slot[] }>(`/api/office/schedule?${new URLSearchParams(input)}`),
  customerAppointments: (locationId: string, customerId: string) => request<{ appointments: Appointment[] }>(`/api/locations/${encodeURIComponent(locationId)}/appointments?${new URLSearchParams({ customerId })}`),
  locationAppointment: (locationId: string, id: string) => request<Appointment>(`/api/locations/${encodeURIComponent(locationId)}/appointments/${encodeURIComponent(id)}`),
  cancelAppointment: (locationId: string, id: string, version: number, idempotencyKey: string) => request<Appointment>(`/api/locations/${encodeURIComponent(locationId)}/appointments/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { "if-match": `"${version}"`, "idempotency-key": idempotencyKey }, body: "{}" }),
  rescheduleAppointment: (locationId: string, id: string, startAt: string, version: number, idempotencyKey: string) => request<Appointment>(`/api/locations/${encodeURIComponent(locationId)}/appointments/${encodeURIComponent(id)}/reschedule`, { method: "POST", headers: { "if-match": `"${version}"`, "idempotency-key": idempotencyKey }, body: JSON.stringify({ startAt }) }),
  appointmentTimeline: (locationId: string, id: string) => request<{ events: AppointmentEvent[]; notifications: NotificationDelivery[] }>(`/api/locations/${encodeURIComponent(locationId)}/appointments/${encodeURIComponent(id)}/events`),
  markAppointmentOutcome: (locationId: string, id: string, outcome: "COMPLETED" | "NO_SHOW", version = 1) => request<Appointment>(`/api/locations/${encodeURIComponent(locationId)}/appointments/${encodeURIComponent(id)}/outcome`, { method: "POST", headers: { "if-match": `"${version}"` }, body: JSON.stringify({ outcome }) }),
  appointment: (appointmentId: string) => request<Appointment>(`/api/appointments/${encodeURIComponent(appointmentId)}`),
  googleCalendarStatus: () => request<GoogleCalendarStatus>("/api/integrations/google/status"),
  googleCalendarConnect: (returnTo: string) => request<{ url: string }>(`/api/integrations/google/connect?${new URLSearchParams({ returnTo })}`),
  agentConfiguration: () => request<AgentConfigurationPayload>("/api/configuration"),
  updateAgentConfiguration: (configuration: AgentConfiguration, revision: string) => request<{
    configuration: AgentConfiguration;
    appliesTo: "next-conversation";
    revision: string;
  }>("/api/configuration", { method: "PUT", headers: { "if-match": `"${revision}"` }, body: JSON.stringify(configuration) }),
};
