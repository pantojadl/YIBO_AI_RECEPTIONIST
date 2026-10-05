import { SqliteAppointmentConcurrencyGuard } from "../infrastructure/database/sqlite-appointment-concurrency-guard.js";
import { buildAsteriskIntegration } from "./asterisk-integration.js";
import { randomUUID } from "node:crypto";
import {
  defaultDatabasePath,
  migrateDatabase,
  openRegionalDatabase,
  seedBusiness,
} from "../infrastructure/database/regional-database.js";
import { SqliteAgentConfigurationRepository } from "../infrastructure/database/sqlite-agent-configuration-repository.js";
import { SqliteCallRepository } from "../infrastructure/database/sqlite-call-repository.js";
import { SqliteConversationUsageRepository } from "../infrastructure/database/sqlite-conversation-usage-repository.js";
import { SqliteGoogleTokenStore } from "../infrastructure/database/sqlite-google-token-store.js";
import { SqliteBusinessRepository } from "../infrastructure/database/sqlite-business-repository.js";
import { SqliteAdminIdentityRepository } from "../infrastructure/database/sqlite-admin-identity-repository.js";
import { SqliteAdminAuditLog } from "../infrastructure/database/sqlite-admin-audit-log.js";
import { SqliteCustomerRepository } from "../infrastructure/database/sqlite-customer-repository.js";
import { SqliteAppointmentRepository } from "../infrastructure/database/sqlite-appointment-repository.js";
import { SqliteNotificationRepository } from "../infrastructure/database/sqlite-notification-repository.js";
import { NotificationService, ResendEmailSender } from "../modules/notifications/index.js";
import {
  AgentConfigurationService,
  DEFAULT_REALTIME_MODEL,
  type AgentConfiguration,
  type AgentToolName,
} from "../modules/agents/index.js";
import {
  GoogleCalendarAdapter,
  GoogleOAuthService,
  BusinessCalendarAssignmentResolver,
} from "../modules/integrations/index.js";
import { BusinessDirectoryService, upgradeBusinessProfile, type BusinessConfigurationV2 } from "../modules/business/index.js";
import {
  DEVELOPMENT_BUSINESS,
  DEVELOPMENT_US_BUSINESS,
} from "../app/development-fixtures.js";
import {
  buildApplication,
  type BuildApplicationOptions,
  type YiboApplication,
} from "./build-application.js";

export async function buildConfiguredApplication(options: BuildApplicationOptions = {}): Promise<YiboApplication> {
  const environment = options.environment ?? process.env;
  const businesses = (options.businesses ?? [DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS])
    .map(upgradeBusinessProfile);
  const tenantId = options.tenantId ?? DEVELOPMENT_BUSINESS.tenantId;
  const tenant = businesses.find((profile) => profile.tenantId === tenantId);
  if (!tenant) throw new Error(`Unknown bootstrap tenant: ${tenantId}`);
  const path = environment[`YIBO_DATABASE_${tenant.region}`]?.trim() || defaultDatabasePath(tenant.region);
  const database = openRegionalDatabase(tenant.region, path);
  migrateDatabase(database);
  seedBusiness(database, tenant);
  const businessRepository = new SqliteBusinessRepository(database, tenant.region);
  await importLegacyDefaultCalendar(environment, tenantId, businessRepository);

  const configurationRepository = options.agentConfigurationRepository
    ?? new SqliteAgentConfigurationRepository(database, tenant.region);
  const usageRecorder = options.usageRecorder
    ?? new SqliteConversationUsageRepository(database, tenant.region);
  const callRepository = options.callRepository
    ?? new SqliteCallRepository(database, tenant.region);
  const customerRepository = options.customerRepository
    ?? new SqliteCustomerRepository(database, tenant.region);
  const appointmentRepository = options.appointmentRepository
    ?? new SqliteAppointmentRepository(database, tenant.region);
  const configurationService = new AgentConfigurationService(configurationRepository);
  const existingConfiguration = await configurationService.get(tenantId);
  if (!existingConfiguration) {
    const applicationConfig = options.config;
    const model = applicationConfig?.openAiRealtimeModel
      ?? environment.OPENAI_REALTIME_MODEL?.trim()
      ?? DEFAULT_REALTIME_MODEL;
    await configurationService.update(
      tenantId,
      configurationService.recommended(tenant.locations[0]!.locale, tenant.name, model, {
        ...(applicationConfig?.conversationVoice ? { voice: applicationConfig.conversationVoice } : {}),
        ...(applicationConfig?.maxOutputTokens ? { maxOutputTokens: applicationConfig.maxOutputTokens } : {}),
        ...(applicationConfig?.vadThreshold !== undefined
          || applicationConfig?.vadPrefixPaddingMs !== undefined
          || applicationConfig?.vadSilenceDurationMs !== undefined
          ? { turnDetection: {
              ...(applicationConfig.vadThreshold === undefined ? {} : { threshold: applicationConfig.vadThreshold }),
              ...(applicationConfig.vadPrefixPaddingMs === undefined ? {} : { prefixPaddingMs: applicationConfig.vadPrefixPaddingMs }),
              ...(applicationConfig.vadSilenceDurationMs === undefined ? {} : { silenceDurationMs: applicationConfig.vadSilenceDurationMs }),
            } }
          : {}),
      }),
    );
  } else {
    const migrated = addCompatibleAgentTools(existingConfiguration);
    if (migrated) await configurationService.update(tenantId, migrated);
  }

  const google = buildGoogleIntegration(environment, tenant, database, businessRepository);
  const notifications = new NotificationService(new SqliteNotificationRepository(database, tenant.region),
    customerRepository, new BusinessDirectoryService(businessRepository),
    environment.RESEND_API_KEY?.trim() && environment.YIBO_EMAIL_FROM?.trim()
      ? new ResendEmailSender(environment.RESEND_API_KEY.trim(), environment.YIBO_EMAIL_FROM.trim()) : undefined,
    () => `notification-${randomUUID()}`);
  const asterisk = options.enableAsteriskTelephony && !options.telephonyGateway ? buildAsteriskIntegration(environment) : undefined;
  const application = buildApplication({
    ...options,
    environment,
    businesses,
    businessRepository,
    tenantId,
    agentConfigurationRepository: configurationRepository,
    usageRecorder,
    callRepository,
    customerRepository,
    appointmentRepository,
    appointmentConcurrencyGuard: options.appointmentConcurrencyGuard ?? new SqliteAppointmentConcurrencyGuard(database, tenant.region),
    appointmentNotifications: notifications,
    providerReadiness: { email: Boolean(environment.RESEND_API_KEY?.trim() && environment.YIBO_EMAIL_FROM?.trim()),
      telephony: Boolean(asterisk), calendar: Boolean(google), realtime: applicationRuntimeConfigured(environment) },
    adminIdentityRepository: options.adminIdentityRepository
      ?? new SqliteAdminIdentityRepository(database, tenant.region),
    adminAuditLog: options.adminAuditLog ?? new SqliteAdminAuditLog(database, tenant.region),
    ...(environment.YIBO_ADMIN_SESSION_KEY?.trim()
      ? { adminSessionSecret: environment.YIBO_ADMIN_SESSION_KEY.trim() }
      : {}),
    ...(google ? { googleOAuth: google.oauth, calendar: google.calendar } : {}),
    ...(asterisk ? { telephonyGateway: asterisk.telephony, voiceGateway: asterisk.voice } : {}),
  });
  if (asterisk) await asterisk.client.connect();
  return application;
}

const applicationRuntimeConfigured = (environment: NodeJS.ProcessEnv) =>
  environment.YIBO_RUNTIME?.trim() === "openai-realtime" && Boolean(environment.OPENAI_API_KEY?.trim());

function buildGoogleIntegration(
  environment: NodeJS.ProcessEnv,
  tenant: BusinessConfigurationV2,
  database: ReturnType<typeof openRegionalDatabase>,
  businesses: SqliteBusinessRepository,
): { oauth: GoogleOAuthService; calendar: GoogleCalendarAdapter } | undefined {
  const clientId = environment.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = environment.GOOGLE_REDIRECT_URI?.trim();
  const stateSigningKey = environment.YIBO_TOKEN_ENCRYPTION_KEY?.trim();
  if (!clientId || !clientSecret || !redirectUri || !stateSigningKey) return undefined;
  const oauth = new GoogleOAuthService(
    { clientId, clientSecret, redirectUri, stateSigningKey },
    new SqliteGoogleTokenStore(database, tenant.region, stateSigningKey),
  );
  return {
    oauth,
    calendar: new GoogleCalendarAdapter(
      new BusinessCalendarAssignmentResolver(new BusinessDirectoryService(businesses)),
      oauth,
    ),
  };
}

const AGENT_TOOL_ADDITIONS: Array<{ prerequisite: AgentToolName; tool: AgentToolName }> = [
  { prerequisite: "create_appointment", tool: "update_customer" },
  { prerequisite: "create_appointment", tool: "reschedule_appointment" },
  { prerequisite: "check_availability", tool: "get_service_information" },
  { prerequisite: "create_appointment", tool: "list_customer_appointments" },
];

function addCompatibleAgentTools(configuration: AgentConfiguration): AgentConfiguration | null {
  const addForPrerequisites = (tools: AgentToolName[]): AgentToolName[] => {
    const additions = AGENT_TOOL_ADDITIONS
      .filter(({ prerequisite, tool }) => tools.includes(prerequisite) && !tools.includes(tool))
      .map(({ tool }) => tool);
    return additions.length > 0 ? [...tools, ...additions] : tools;
  };
  const enabledTools = addForPrerequisites(configuration.enabledTools);
  const phoneTools = addForPrerequisites(configuration.toolPolicies.channels.phone.enabledTools);
  const voiceLabTools = addForPrerequisites(configuration.toolPolicies.channels.voice_lab.enabledTools);
  if (enabledTools === configuration.enabledTools
    && phoneTools === configuration.toolPolicies.channels.phone.enabledTools
    && voiceLabTools === configuration.toolPolicies.channels.voice_lab.enabledTools) return null;
  return {
    ...configuration,
    enabledTools,
    toolPolicies: {
      ...configuration.toolPolicies,
      channels: {
        phone: { ...configuration.toolPolicies.channels.phone, enabledTools: phoneTools },
        voice_lab: { ...configuration.toolPolicies.channels.voice_lab, enabledTools: voiceLabTools },
      },
    },
  };
}

async function importLegacyDefaultCalendar(
  environment: NodeJS.ProcessEnv,
  tenantId: string,
  repository: SqliteBusinessRepository,
): Promise<void> {
  const calendarId = environment.GOOGLE_CALENDAR_ID?.trim();
  if (!calendarId) return;
  const stored = await repository.findConfigurationByTenantId(tenantId);
  if (!stored) return;
  const profile = upgradeBusinessProfile(stored.profile);
  const location = profile.locations.find(({ id }) => id === "default") ?? profile.locations[0];
  if (!location || location.defaultCalendarId) return;
  location.defaultCalendarId = calendarId;
  await repository.saveIfVersion(profile, stored.version);
}
