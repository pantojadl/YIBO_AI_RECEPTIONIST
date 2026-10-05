import { randomBytes, randomUUID } from "node:crypto";
import {
  AgentDefinitionService,
  AgentConfigurationService,
  createDefaultAgentConfiguration,
  InMemoryAgentConfigurationSource,
  ToolExecutorImpl,
  type HumanTransferPort,
  type AgentDefinitionFactory,
  type AgentConfigurationRepository,
  type AgentConfigurationServiceContract,
  type ToolExecutor,
} from "../modules/agents/index.js";
import {
  AppointmentServiceImpl,
  InMemoryAppointmentConcurrencyGuard,
  type AppointmentConcurrencyGuard,
  InMemoryAppointmentRepository,
  type AppointmentService,
  type AppointmentCalendarPort,
  type AppointmentRepository,
  type CustomerReader,
} from "../modules/appointments/index.js";
import {
  BusinessDirectoryService,
  BusinessCatalogService,
  InMemoryBusinessRepository,
  upgradeBusinessProfile,
  type BusinessDirectory,
  type BusinessRepository,
  type VersionedBusinessProfile,
} from "../modules/business/index.js";
import {
  CallOrchestratorService,
  InMemoryCallRepository,
  type CallOrchestrator,
  type CallHistoryReader,
  type CallRepository,
} from "../modules/calls/index.js";
import {
  ConversationService,
  OpenAIRealtimeAdapter,
  ScriptedConversationRuntime,
  type ConversationRuntimePort,
  type ConversationServiceContract,
  type ConversationTransport,
  type ConversationUsageRecorder,
} from "../modules/conversation/index.js";
import {
  DefaultCustomerService,
  InMemoryCustomerRepository,
  type CustomerService,
  type CustomerRepository,
} from "../modules/customers/index.js";
import {
  GoogleOAuthService,
  InMemoryCalendarAdapter,
  TelephonyHumanTransferAdapter,
} from "../modules/integrations/index.js";
import {
  SchedulingServiceImpl,
  type CalendarPort,
  type ConfirmedAppointmentReader,
  type EmployeeWorkingHoursProvider,
  type SchedulingService,
} from "../modules/scheduling/index.js";
import {
  ScriptedVoiceMediaGateway,
  type VoiceMediaGateway,
} from "../modules/voice/index.js";
import type { Clock, IdGenerator } from "../shared/application/system.js";
import { success } from "../shared/domain/result.js";
import {
  DEVELOPMENT_BUSINESS,
  DEVELOPMENT_US_BUSINESS,
} from "../app/development-fixtures.js";
import { loadConfiguration, type ApplicationConfiguration } from "./configuration.js";
import { InMemoryCallTelephonyGateway } from "./in-memory-telephony.js";
import type { OrganizationCostReader } from "../modules/billing/index.js";
import type { AppointmentNotificationService } from "../modules/notifications/index.js";
import type { TelephonyGateway } from "../modules/telephony/index.js";
import { OpenAIOrganizationCostsAdapter } from "../infrastructure/billing/openai-organization-costs-adapter.js";
import {
  AdminCredentialService,
  AdminAuditService,
  InMemoryAdminAuditLog,
  InMemoryAdminIdentityRepository,
  ScryptPasswordHasher,
  SignedAdminSession,
  type AdminIdentityRepository,
  type AdminAuditLogPort,
  type AdminSessionPort,
} from "../modules/auth/index.js";
type ApplicationCalendar = CalendarPort & AppointmentCalendarPort;
type ApplicationAppointmentRepository = AppointmentRepository & ConfirmedAppointmentReader;

export interface YiboApplication {
  tenantId: string;
  config: ApplicationConfiguration;
  business: BusinessDirectory;
  businessCatalog: BusinessCatalogService;
  customers: CustomerService;
  scheduling: SchedulingService;
  appointments: AppointmentService;
  tools: ToolExecutor;
  agents: AgentDefinitionFactory;
  agentConfiguration: AgentConfigurationServiceContract;
  conversations: ConversationServiceContract;
  calls: CallOrchestrator;
  callHistory: CallHistoryReader;
  runtime: ConversationRuntimePort;
  voice: VoiceMediaGateway;
  calendar: ApplicationCalendar;
  telephony: TelephonyGateway & {
    close?(): void | Promise<void>;
    readonly answeredCallIds?: string[];
    readonly hungUpCallIds?: string[];
    readonly transfers?: Array<{ callId: string; destination: unknown }>;
  };
  ids: IdGenerator;
  billing?: OrganizationCostReader;
  googleOAuth?: GoogleOAuthService;
  developerTestModeAuthorized?: boolean;
  adminAuth: {
    credentials: AdminCredentialService;
    sessions: AdminSessionPort;
  };
  adminAudit: AdminAuditService;
  notifications?: AppointmentNotificationService;
  providerReadiness: { email: boolean; telephony: boolean; calendar: boolean; realtime: boolean };
  registerCallMedia(callId: string, transport: ConversationTransport): () => void;
}

export interface BuildApplicationOptions {
  environment?: NodeJS.ProcessEnv;
  config?: ApplicationConfiguration;
  tenantId?: string;
  businesses?: VersionedBusinessProfile[];
  businessRepository?: BusinessRepository;
  customerRepository?: CustomerRepository;
  appointmentRepository?: ApplicationAppointmentRepository;
  appointmentConcurrencyGuard?: AppointmentConcurrencyGuard;
  clock?: Clock;
  ids?: IdGenerator;
  runtime?: ConversationRuntimePort;
  humanTransfer?: HumanTransferPort;
  telephonyGateway?: TelephonyGateway;
  voiceGateway?: import("../modules/voice/index.js").VoiceMediaGateway;
  enableAsteriskTelephony?: boolean;
  agentConfigurationRepository?: AgentConfigurationRepository;
  usageRecorder?: ConversationUsageRecorder;
  callRepository?: CallRepository & CallHistoryReader;
  billing?: OrganizationCostReader;
  calendar?: ApplicationCalendar;
  googleOAuth?: GoogleOAuthService;
  adminIdentityRepository?: AdminIdentityRepository;
  adminAuditLog?: AdminAuditLogPort;
  adminSession?: AdminSessionPort;
  adminSessionSecret?: string;
  appointmentNotifications?: AppointmentNotificationService;
  providerReadiness?: Partial<YiboApplication["providerReadiness"]>;
  /** Only the local development voice harness may set this true. */
  developerTestModeAuthorized?: boolean;
}

export function buildApplication(options: BuildApplicationOptions = {}): YiboApplication {
  const environment = options.environment ?? process.env;
  const config = options.config ?? loadConfiguration(environment);
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? uuidGenerator;
  const profiles = (options.businesses ?? [DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS])
    .map(upgradeBusinessProfile);
  const tenantId = options.tenantId ?? DEVELOPMENT_BUSINESS.tenantId;
  const tenant = profiles.find((profile) => profile.tenantId === tenantId);
  if (!tenant) throw new Error(`Unknown bootstrap tenant: ${tenantId}`);

  const runtime = selectRuntime(config, options.runtime);
  const billing = options.billing ?? (config.openAiAdminKey
    ? new OpenAIOrganizationCostsAdapter(config.openAiAdminKey)
    : undefined);
  const appointmentRepository = options.appointmentRepository ?? new InMemoryAppointmentRepository();
  const businessRepository = options.businessRepository ?? new InMemoryBusinessRepository(profiles, tenantId => appointmentRepository.calendarRouteReferences(tenantId));
  const adminIdentityRepository = options.adminIdentityRepository ?? new InMemoryAdminIdentityRepository();
  const adminAuth = {
    credentials: new AdminCredentialService(
      adminIdentityRepository,
      new ScryptPasswordHasher(),
      () => `admin-${randomUUID()}`,
    ),
    sessions: options.adminSession ?? new SignedAdminSession(
      options.adminSessionSecret ?? randomBytes(32).toString("base64url"),
    ),
  };
  const adminAudit = new AdminAuditService(
    options.adminAuditLog ?? new InMemoryAdminAuditLog(),
    () => clock.now(),
    () => ids.generate("audit"),
  );
  const business = new BusinessDirectoryService(businessRepository);
  const telephony = options.telephonyGateway ?? new InMemoryCallTelephonyGateway();
  const callRepository = options.callRepository ?? new InMemoryCallRepository();
  const customerRepository = options.customerRepository ?? new InMemoryCustomerRepository();
  const customers = new DefaultCustomerService(
    customerRepository,
    () => ids.generate("customer"),
  );
  const businessCatalog = new BusinessCatalogService(business, appointmentRepository);
  const calendar = options.calendar ?? new InMemoryCalendarAdapter();

  const customerReader: CustomerReader = {
    exists: async (candidateTenantId, customerId) =>
      (await customerRepository.findById(candidateTenantId, customerId)) !== null,
    get: async (candidateTenantId, customerId) => {
      const customer = await customerRepository.findById(candidateTenantId, customerId);
      return customer ? { name: customer.name, phone: customer.phone } : null;
    },
  };
  const workingHours: EmployeeWorkingHoursProvider = {
    getWorkingHours: async ({ tenantId: candidateTenantId, locationId, employeeId }) => {
      const profile = await business.getLocation(candidateTenantId, locationId);
      if (!profile.ok || !profile.value.business.professionals.some((employee) => employee.id === employeeId && employee.active)) return [];
      const assignment = profile.value.location.professionals.find((candidate) =>
        candidate.professionalId === employeeId && candidate.active);
      return assignment?.openingHours.map((rule) => ({ ...rule })) ?? [];
    },
  };
  const confirmedAppointments: ConfirmedAppointmentReader = appointmentRepository;
  const scheduling = new SchedulingServiceImpl(
    business,
    workingHours,
    confirmedAppointments,
    calendar,
    clock,
  );
  const appointments = new AppointmentServiceImpl(
    appointmentRepository,
    customerReader,
    business,
    scheduling,
    calendar,
    options.appointmentConcurrencyGuard ?? new InMemoryAppointmentConcurrencyGuard(),
    () => ids.generate("appointment"),
    clock,
    options.appointmentNotifications,
  );
  // Developer Test Mode must be repeatable without touching a connected Google
  // Calendar. It uses the same scheduling and appointment services, with an
  // isolated in-memory calendar and demo clinic hours beginning at 7:00 AM.
  const developerTestBusiness: BusinessDirectory = {
    resolveLocationByCalledNumber: async (phoneNumber) => demoLocation(await business.resolveLocationByCalledNumber(phoneNumber)),
    getLocation: async (candidateTenantId, locationId) => demoLocation(await business.getLocation(candidateTenantId, locationId)),
    getBusinessByCalledNumber: async (phoneNumber) => demoBusiness(await business.getBusinessByCalledNumber(phoneNumber)),
    getBusinessProfile: async (candidateTenantId) => demoBusiness(await business.getBusinessProfile(candidateTenantId)),
    updateBusinessTimezone: async (candidateTenantId, timezone) => demoBusiness(await business.updateBusinessTimezone(candidateTenantId, timezone)),
    getBusinessConfiguration: (candidateTenantId) => business.getBusinessConfiguration(candidateTenantId),
    updateBusinessConfiguration: (candidateTenantId, configuration, version) =>
      business.updateBusinessConfiguration(candidateTenantId, configuration, version),
  };
  const developerTestCalendar = new InMemoryCalendarAdapter();
  const developerTestAppointmentRepository = new InMemoryAppointmentRepository();
  const developerTestWorkingHours: EmployeeWorkingHoursProvider = {
    getWorkingHours: async ({ tenantId: candidateTenantId, locationId, employeeId }) => {
      const profile = await developerTestBusiness.getLocation(candidateTenantId, locationId);
      if (!profile.ok || !profile.value.business.professionals.some((employee) => employee.id === employeeId && employee.active)) return [];
      const assignment = profile.value.location.professionals.find((candidate) =>
        candidate.professionalId === employeeId && candidate.active);
      return assignment?.openingHours.map((rule) => ({ ...rule })) ?? [];
    },
  };
  const developerTestScheduling = new SchedulingServiceImpl(
    developerTestBusiness,
    developerTestWorkingHours,
    developerTestAppointmentRepository,
    developerTestCalendar,
    clock,
  );
  const developerTestAppointments = new AppointmentServiceImpl(
    developerTestAppointmentRepository,
    customerReader,
    developerTestBusiness,
    developerTestScheduling,
    developerTestCalendar,
    new InMemoryAppointmentConcurrencyGuard(),
    () => ids.generate("appointment"),
    clock,
  );
  const transfer = options.humanTransfer
    ?? new TelephonyHumanTransferAdapter(business, callRepository, telephony, clock);
  const tools = new ToolExecutorImpl(scheduling, appointments, transfer, business, clock, customers, {
    scheduling: developerTestScheduling,
    appointments: developerTestAppointments,
  });
  const configurationRepository = options.agentConfigurationRepository ?? new InMemoryAgentConfigurationSource(profiles.map((profile) => ({
      tenantId: profile.tenantId,
      configuration: createDefaultAgentConfiguration({
        locale: profile.locations[0]!.locale,
        businessName: profile.name,
        model: config.openAiRealtimeModel,
        voice: config.conversationVoice,
        maxOutputTokens: config.maxOutputTokens,
        ...(config.vadThreshold !== undefined
          || config.vadPrefixPaddingMs !== undefined
          || config.vadSilenceDurationMs !== undefined
          ? { turnDetection: {
              ...(config.vadThreshold === undefined ? {} : { threshold: config.vadThreshold }),
              ...(config.vadPrefixPaddingMs === undefined ? {} : { prefixPaddingMs: config.vadPrefixPaddingMs }),
              ...(config.vadSilenceDurationMs === undefined ? {} : { silenceDurationMs: config.vadSilenceDurationMs }),
            } }
          : {}),
      }),
    })));
  const agentConfiguration = new AgentConfigurationService(configurationRepository);
  const agentDefinitions = new AgentDefinitionService(configurationRepository, tools, business);
  const conversations = new ConversationService({
    runtime,
    ...(options.usageRecorder ? { usageRecorder: options.usageRecorder } : {}),
  });
  const registeredVoice = new ScriptedVoiceMediaGateway();
  const voice = options.voiceGateway ?? registeredVoice;
  const calls = new CallOrchestratorService(
    business,
    customers,
    telephony,
    agentDefinitions,
    voice,
    conversations,
    callRepository,
    options.developerTestModeAuthorized ?? false,
  );
  telephony.onEvent((event) => calls.handleTelephonyEvent(event));

  return {
    tenantId,
    config,
    business,
    businessCatalog,
    customers,
    scheduling,
    appointments,
    tools,
    agents: agentDefinitions,
    agentConfiguration,
    conversations,
    calls,
    callHistory: callRepository,
    runtime,
    voice,
    calendar,
    telephony,
    ids,
    adminAuth,
    adminAudit,
    ...(options.appointmentNotifications ? { notifications: options.appointmentNotifications } : {}),
    providerReadiness: { email: false, telephony: false, calendar: Boolean(options.calendar),
      realtime: config.runtime === "openai-realtime", ...options.providerReadiness },
    ...(billing ? { billing } : {}),
    ...(options.googleOAuth ? { googleOAuth: options.googleOAuth } : {}),
    registerCallMedia: (callId, transport) => registeredVoice.register(callId, transport),
  };
}

const systemClock: Clock = { now: () => new Date() };
const uuidGenerator: IdGenerator = { generate: (scope) => `${scope}-${randomUUID()}` };
type BusinessProfileResult = Awaited<ReturnType<BusinessDirectory["getBusinessProfile"]>>;
type BusinessLocationResult = Awaited<ReturnType<BusinessDirectory["getLocation"]>>;

const demoBusiness = (result: BusinessProfileResult): BusinessProfileResult => {
  if (!result.ok) return result;
  return success({ ...result.value, locations: result.value.locations.map((location) => ({
    ...location,
    openingHours: location.openingHours.map((rule) => ({ ...rule, startTime: "07:00" })),
  })) });
};

const demoLocation = (result: BusinessLocationResult): BusinessLocationResult => {
  if (!result.ok) return result;
  const openingHours = result.value.location.openingHours.map((rule) => ({ ...rule, startTime: "07:00" }));
  return success({
    ...result.value,
    location: { ...result.value.location, openingHours },
    business: {
      ...result.value.business,
      locations: result.value.business.locations.map((location) =>
        location.id === result.value.locationId ? { ...location, openingHours } : location),
    },
  });
};

function selectRuntime(
  config: ApplicationConfiguration,
  injected: ConversationRuntimePort | undefined,
): ConversationRuntimePort {
  if (injected) return injected;
  if (config.runtime === "in-memory") return new ScriptedConversationRuntime();
  if (!config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required when YIBO_RUNTIME=openai-realtime");
  }
  return new OpenAIRealtimeAdapter({
    apiKey: config.openAiApiKey,
  });
}
