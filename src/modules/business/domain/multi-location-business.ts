import type {
  BusinessId,
  EmployeeId,
  IANATimeZone,
  LocationId,
  RegionId,
  ServiceId,
  TenantId,
} from "../../../shared/types/identifiers.js";
import type { OpeningHoursRule } from "../application/contracts.js";
import { DISPLAY_CURRENCIES, validateMoney, type DisplayCurrency, type Money } from "./money.js";
import { isLocationAgentOverrides, type LocationAgentOverrides } from "./location-agent-overrides.js";

export const MULTI_LOCATION_BUSINESS_SCHEMA_VERSION = 2 as const;
export const SLOT_INCREMENT_MINUTES = [5, 10, 15, 20, 30, 45, 60] as const;

export interface TenantServiceDefinition {
  id: ServiceId;
  name: string;
  description: string;
  durationMinutes: number;
  bufferMinutes: number;
  active: boolean;
}

export interface ProfessionalDefinition {
  id: EmployeeId;
  displayName: string;
  active: boolean;
}

export interface LocationAddress {
  line1: string;
  line2?: string;
  city: string;
  administrativeArea?: string;
  postalCode?: string;
  countryCode: string;
}

export interface LocationClosure {
  id: string;
  startLocal: string;
  endLocal: string;
  administrativeReason: string;
}

export interface AvailabilitySuggestionsPolicy {
  enabled: boolean;
  expansionDays: number;
  maximumAlternatives: number;
}

export const isAvailabilitySuggestionsPolicy = (value: unknown): value is AvailabilitySuggestionsPolicy => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return Object.keys(policy).length === 3
    && Object.keys(policy).every(key => ["enabled", "expansionDays", "maximumAlternatives"].includes(key))
    && typeof policy.enabled === "boolean"
    && typeof policy.expansionDays === "number" && Number.isInteger(policy.expansionDays) && policy.expansionDays >= 1 && policy.expansionDays <= 14
    && typeof policy.maximumAlternatives === "number" && Number.isInteger(policy.maximumAlternatives) && policy.maximumAlternatives >= 1 && policy.maximumAlternatives <= 5;
};

export const DEFAULT_AVAILABILITY_SUGGESTIONS: Readonly<AvailabilitySuggestionsPolicy> = {
  enabled: false, expansionDays: 1, maximumAlternatives: 3,
};

export interface LocationSchedulingPolicy {
  availabilitySuggestions?: AvailabilitySuggestionsPolicy;
  defaultServiceId: ServiceId;
  slotIncrementMinutes: typeof SLOT_INCREMENT_MINUTES[number];
  minimumLeadTimeMinutes: number;
  maximumBookingHorizonDays: number;
  maximumResults: number;
  minimumCancellationNoticeMinutes: number;
  minimumRescheduleNoticeMinutes: number;
  concurrentCapacity: number;
  sameDayBooking?: boolean;
  cancellationAllowed?: boolean;
  reschedulingAllowed?: boolean;
  staffOverrideAllowed?: boolean;
}

export interface LocationAiCapabilities {
  bookAppointments: boolean;
  rescheduleAppointments: boolean;
  cancelAppointments: boolean;
  quotePrices: boolean;
  describeServices: boolean;
  offerEarliest: boolean;
  offerAlternatives: boolean;
  collectEmail: boolean;
  collectPhone: boolean;
  sendAppointmentEmails: boolean;
  transferToHuman: boolean;
  afterHoursBehavior: "INFORMATION_ONLY" | "BOOK" | "TRANSFER";
}

export interface LocationServiceAssignment {
  serviceId: ServiceId;
  active: boolean;
  price: Money;
}

export interface LocationProfessionalAssignment {
  professionalId: EmployeeId;
  active: boolean;
  serviceIds: ServiceId[];
  openingHours: OpeningHoursRule[];
  calendarId?: string;
}

export type LocationTransferDestination =
  | { type: "PHONE_NUMBER"; value: string }
  | { type: "EXTENSION"; value: string };

export interface LocationDefinition {
  agentOverrides?: LocationAgentOverrides;
  id: LocationId;
  name: string;
  active: boolean;
  address: LocationAddress;
  timezone: IANATimeZone;
  locale: string;
  calledNumbers: string[];
  openingHours: OpeningHoursRule[];
  closures: LocationClosure[];
  policies: LocationSchedulingPolicy;
  services: LocationServiceAssignment[];
  professionals: LocationProfessionalAssignment[];
  defaultCalendarId?: string;
  transferDestination?: LocationTransferDestination;
  aiCapabilities?: LocationAiCapabilities;
}

export const resolvedAiCapabilities = (location: LocationDefinition): LocationAiCapabilities => ({
  bookAppointments: true, rescheduleAppointments: true, cancelAppointments: true,
  quotePrices: true, describeServices: true, offerEarliest: true, offerAlternatives: true,
  collectEmail: false, collectPhone: true, sendAppointmentEmails: true,
  transferToHuman: true, afterHoursBehavior: "INFORMATION_ONLY",
  ...location.aiCapabilities,
});

export interface BusinessConfigurationV2 {
  /** Default for currency-unspecified presentation/new prices; never converts existing Money. */
  displayCurrency?: DisplayCurrency;
  schemaVersion: typeof MULTI_LOCATION_BUSINESS_SCHEMA_VERSION;
  region: RegionId;
  tenantId: TenantId;
  businessId: BusinessId;
  name: string;
  active: boolean;
  services: TenantServiceDefinition[];
  professionals: ProfessionalDefinition[];
  locations: LocationDefinition[];
}

export type MultiLocationBusinessValidationError = { path: string; message: string };

export const validateMultiLocationBusiness = (
  profile: BusinessConfigurationV2,
): MultiLocationBusinessValidationError[] => {
  const errors: MultiLocationBusinessValidationError[] = [];
  if (profile.displayCurrency !== undefined && !(DISPLAY_CURRENCIES as readonly string[]).includes(profile.displayCurrency)) {
    errors.push({ path: "displayCurrency", message: "Choose USD, MXN or EUR." });
  }
  required(errors, "tenantId", profile.tenantId);
  required(errors, "businessId", profile.businessId);
  required(errors, "name", profile.name);
  uniqueIds(errors, "services", profile.services.map(({ id }) => id));
  uniqueIds(errors, "professionals", profile.professionals.map(({ id }) => id));
  uniqueIds(errors, "locations", profile.locations.map(({ id }) => id));

  const serviceIds = new Set(profile.services.map(({ id }) => id));
  const professionalIds = new Set(profile.professionals.map(({ id }) => id));
  const activeServiceIds = new Set(profile.services.filter(({ active }) => active).map(({ id }) => id));
  const activeProfessionalIds = new Set(profile.professionals.filter(({ active }) => active).map(({ id }) => id));
  for (const [index, service] of profile.services.entries()) {
    required(errors, `services.${index}.name`, service.name);
    if (!Number.isInteger(service.durationMinutes) || service.durationMinutes <= 0) {
      errors.push({ path: `services.${index}.durationMinutes`, message: "Must be a positive integer." });
    }
    if (!Number.isInteger(service.bufferMinutes) || service.bufferMinutes < 0) {
      errors.push({ path: `services.${index}.bufferMinutes`, message: "Must be a non-negative integer." });
    }
  }

  const allNumbers = new Set<string>();
  for (const [index, location] of profile.locations.entries()) {
    const path = `locations.${index}`;
    required(errors, `${path}.id`, location.id);
    required(errors, `${path}.name`, location.name);
    required(errors, `${path}.locale`, location.locale);
    if (location.agentOverrides !== undefined && !isLocationAgentOverrides(location.agentOverrides)) {
      errors.push({ path: `${path}.agentOverrides`, message: "Use supported appointment restrictions, a price-disclosure boolean, phone readback style and a valid language tag." });
    }
    required(errors, `${path}.address.line1`, location.address.line1);
    required(errors, `${path}.address.city`, location.address.city);
    if (!/^[A-Z]{2}$/.test(location.address.countryCode)) {
      errors.push({ path: `${path}.address.countryCode`, message: "Must be an ISO 3166-1 alpha-2 code." });
    }
    if (!isTimeZone(location.timezone)) {
      errors.push({ path: `${path}.timezone`, message: "Must be a valid IANA timezone." });
    }
    if (location.active && location.calledNumbers.length === 0) {
      errors.push({ path: `${path}.calledNumbers`, message: "An active location requires a called number." });
    }
    if (!location.active && location.calledNumbers.length > 0) {
      errors.push({ path: `${path}.calledNumbers`, message: "Called numbers may belong only to active locations." });
    }
    for (const [numberIndex, phone] of location.calledNumbers.entries()) {
      const normalized = normalizePhone(phone);
      if (!normalized) errors.push({ path: `${path}.calledNumbers.${numberIndex}`, message: "Invalid phone number." });
      else if (allNumbers.has(normalized)) errors.push({ path: `${path}.calledNumbers.${numberIndex}`, message: "Called number belongs to more than one location." });
      else allNumbers.add(normalized);
    }
    validateHours(errors, `${path}.openingHours`, location.openingHours);
    uniqueIds(errors, `${path}.services`, location.services.map(({ serviceId }) => serviceId));
    for (const [assignmentIndex, assignment] of location.services.entries()) {
      const assignmentPath = `${path}.services.${assignmentIndex}`;
      if (!serviceIds.has(assignment.serviceId)) errors.push({ path: `${assignmentPath}.serviceId`, message: "Unknown tenant service." });
      if (assignment.active && !activeServiceIds.has(assignment.serviceId)) {
        errors.push({ path: `${assignmentPath}.active`, message: "An active assignment requires an active tenant service." });
      }
      const priceError = validateMoney(assignment.price);
      if (priceError) errors.push({ path: `${assignmentPath}.price`, message: priceError });
    }
    uniqueIds(errors, `${path}.professionals`, location.professionals.map(({ professionalId }) => professionalId));
    for (const [assignmentIndex, assignment] of location.professionals.entries()) {
      const assignmentPath = `${path}.professionals.${assignmentIndex}`;
      if (!professionalIds.has(assignment.professionalId)) errors.push({ path: `${assignmentPath}.professionalId`, message: "Unknown tenant professional." });
      if (assignment.active && !activeProfessionalIds.has(assignment.professionalId)) {
        errors.push({ path: `${assignmentPath}.active`, message: "An active assignment requires an active tenant professional." });
      }
      if (new Set(assignment.serviceIds).size !== assignment.serviceIds.length
        || assignment.serviceIds.some((serviceId) => !location.services.some((service) => service.serviceId === serviceId))) {
        errors.push({ path: `${assignmentPath}.serviceIds`, message: "Services must be unique assignments of this location." });
      }
      validateHours(errors, `${assignmentPath}.openingHours`, assignment.openingHours);
      if (assignment.calendarId !== undefined && !isValidCalendarId(assignment.calendarId)) {
        errors.push({ path: `${assignmentPath}.calendarId`, message: "Invalid calendar identifier." });
      }
    }
    if (!location.services.some(({ serviceId, active }) => serviceId === location.policies.defaultServiceId && active)) {
      errors.push({ path: `${path}.policies.defaultServiceId`, message: "Must reference an active location service." });
    }
    if (!(SLOT_INCREMENT_MINUTES as readonly number[]).includes(location.policies.slotIncrementMinutes)) {
      errors.push({ path: `${path}.policies.slotIncrementMinutes`, message: "Unsupported slot increment." });
    }
    const suggestions = location.policies.availabilitySuggestions;
    if (suggestions !== undefined && !isAvailabilitySuggestionsPolicy(suggestions)) {
      errors.push({ path: `${path}.policies.availabilitySuggestions`, message: "Use enabled boolean, expansionDays 1–14 and maximumAlternatives 1–5." });
    }
    for (const field of ["minimumLeadTimeMinutes", "maximumBookingHorizonDays", "maximumResults",
      "minimumCancellationNoticeMinutes", "minimumRescheduleNoticeMinutes", "concurrentCapacity"] as const) {
      const value = location.policies[field];
      const minimum = ["concurrentCapacity", "maximumResults", "maximumBookingHorizonDays"].includes(field) ? 1 : 0;
      if (!Number.isSafeInteger(value) || value < minimum) {
        errors.push({ path: `${path}.policies.${field}`, message: "Invalid non-negative policy value." });
      }
    }
    for (const [closureIndex, closure] of location.closures.entries()) {
      if (!closure.id.trim() || !closure.administrativeReason.trim() || !isLocalDateTime(closure.startLocal)
        || !isLocalDateTime(closure.endLocal) || closure.startLocal >= closure.endLocal) {
        errors.push({ path: `${path}.closures.${closureIndex}`, message: "Closure requires an ID, reason and ordered local date range." });
      }
    }
    if (location.defaultCalendarId !== undefined && !isValidCalendarId(location.defaultCalendarId)) {
      errors.push({ path: `${path}.defaultCalendarId`, message: "Invalid calendar identifier." });
    }
    if (location.transferDestination !== undefined && !isValidTransferDestination(location.transferDestination)) {
      errors.push({ path: `${path}.transferDestination`, message: "Invalid phone number or extension." });
    }
    if (location.aiCapabilities && !["INFORMATION_ONLY", "BOOK", "TRANSFER"].includes(location.aiCapabilities.afterHoursBehavior)) {
      errors.push({ path: `${path}.aiCapabilities.afterHoursBehavior`, message: "Invalid after-hours behavior." });
    }
  }
  if (profile.active && !profile.locations.some(({ active }) => active)) {
    errors.push({ path: "locations", message: "An active business requires an active location." });
  }
  return errors;
};

export const isValidCalendarId = (value: string): boolean =>
  value.length <= 255 && /^[^\s\u0000-\u001F\u007F]+$/.test(value);

export const isValidTransferDestination = (destination: LocationTransferDestination): boolean =>
  destination.type === "PHONE_NUMBER"
    ? /^\+?[1-9]\d{6,14}$/.test(destination.value)
    : destination.type === "EXTENSION" && /^\d{1,8}$/.test(destination.value);

const required = (errors: MultiLocationBusinessValidationError[], path: string, value: string): void => {
  if (!value.trim()) errors.push({ path, message: "Required." });
};

const uniqueIds = (errors: MultiLocationBusinessValidationError[], path: string, ids: string[]): void => {
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    errors.push({ path, message: "IDs must be non-empty and unique." });
  }
};

const isTimeZone = (value: string): boolean => {
  try { Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
};

const normalizePhone = (value: string): string | null => {
  const normalized = value.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
};

const validateHours = (
  errors: MultiLocationBusinessValidationError[],
  path: string,
  hours: OpeningHoursRule[],
): void => {
  for (const [index, rule] of hours.entries()) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.startTime)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.endTime)
      || rule.startTime >= rule.endTime) {
      errors.push({ path: `${path}.${index}`, message: "Hours require ordered HH:mm values." });
    }
  }
};

const isLocalDateTime = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value) && !Number.isNaN(Date.parse(`${value}Z`));
