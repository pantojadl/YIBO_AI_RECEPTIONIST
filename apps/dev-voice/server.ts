import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { buildConfiguredApplication } from "../../src/bootstrap/build-configured-application.js";
import { DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS } from "../../src/app/index.js";
import { AgentConfigurationService } from "../../src/modules/agents/index.js";
import {
  migrateDatabase,
  openRegionalDatabase,
  seedBusiness,
} from "../../src/infrastructure/database/regional-database.js";
import { SqliteAgentConfigurationRepository } from "../../src/infrastructure/database/sqlite-agent-configuration-repository.js";
import { SqliteConversationUsageRepository } from "../../src/infrastructure/database/sqlite-conversation-usage-repository.js";
import { SqliteCallRepository } from "../../src/infrastructure/database/sqlite-call-repository.js";
import { registerAgentConfigurationRoutes } from "../../src/api/routes/agent-configuration.js";
import { attachHarness } from "./harness.js";

const transcriptEnabled = process.argv.includes("--transcript");
const audioDebug = process.env.YIBO_VOICE_DEBUG === "1";
const developerTestModeAuthorized = process.env.YIBO_LOCAL_DEVELOPER_TEST_MODE === "1";
const port = Number(process.env.DEV_VOICE_PORT ?? 4317);
const tenantId = process.env.YIBO_TENANT_ID?.trim() || DEVELOPMENT_BUSINESS.tenantId;
const profile = [DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS].find((value) => value.tenantId === tenantId);
if (!profile) throw new Error(`Unknown development tenant: ${tenantId}`);
const location = profile.locations[0]!;
const database = openRegionalDatabase(profile.region);
migrateDatabase(database);
seedBusiness(database, profile);
const configurationRepository = new SqliteAgentConfigurationRepository(database, profile.region);
const usageRepository = new SqliteConversationUsageRepository(database, profile.region);
const callRepository = new SqliteCallRepository(database, profile.region);
const configurationService = new AgentConfigurationService(configurationRepository);
if (!await configurationRepository.getConfiguration(profile.tenantId)) {
  await configurationRepository.saveConfiguration(profile.tenantId, configurationService.recommended(
    location.locale,
    profile.name,
    process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1",
  ));
}
const app = await buildConfiguredApplication({
  tenantId,
  businesses: [DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS],
  agentConfigurationRepository: configurationRepository,
  usageRecorder: usageRepository,
  callRepository,
  developerTestModeAuthorized,
});
const server = Fastify({ logger: false });
const htmlPath = new URL("./index.html", import.meta.url);
const clientPath = new URL("./client.js", import.meta.url);
const configurationPanelPath = new URL("./configuration-panel.js", import.meta.url);
const usageMonitorPath = new URL("./usage-monitor.js", import.meta.url);
const callHistoryPath = new URL("./call-history.js", import.meta.url);

server.get("/", async (_request, reply) => reply.type("text/html").send(await readFile(htmlPath, "utf8")));
server.get("/voice-lab-session.js", async (_request, reply) => reply.type("text/javascript").send(await readFile(new URL("./voice-lab-session.js", import.meta.url), "utf8")));
server.get("/client.js", async (_request, reply) => reply.type("text/javascript").send(await readFile(clientPath, "utf8")));
server.get("/configuration-panel.js", async (_request, reply) => reply.type("text/javascript").send(await readFile(configurationPanelPath, "utf8")));
server.get("/usage-monitor.js", async (_request, reply) => reply.type("text/javascript").send(await readFile(usageMonitorPath, "utf8")));
server.get("/call-history.js", async (_request, reply) => reply.type("text/javascript").send(await readFile(callHistoryPath, "utf8")));
await registerAgentConfigurationRoutes(server, app);
server.get("/api/usage", async () => usageRepository.summarize(app.tenantId));
server.get("/api/billing", async (_request, reply) => {
  if (!app.billing) return { configured: false };
  try {
    return { configured: true, summary: await app.billing.summarize() };
  } catch (error) {
    return reply.code(502).send({ configured: true, error: errorMessage(error) });
  }
});
server.get("/api/calls", async (request) => {
  const query = request.query as { limit?: string };
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25) || 25));
  return { calls: await app.callHistory.listByTenant(app.tenantId, limit) };
});

const sockets = new WebSocketServer({ server: server.server, path: "/voice" });
sockets.on("connection", (socket) => attachHarness(socket, { app, callRepository, calledNumber: location.calledNumbers[0]!, transcriptEnabled, audioDebug }));

await server.listen({ host: "127.0.0.1", port });
console.log(`YIBO DevAudioHarness: http://127.0.0.1:${port}`);
console.log(`Transcript logging: ${transcriptEnabled ? "ON" : "OFF"}; audio persistence: OFF`);
console.log(JSON.stringify({
  event: "voice.runtime.configured",
  runtime: app.config.runtime,
  model: app.config.openAiRealtimeModel,
  apiKeyConfigured: Boolean(app.config.openAiApiKey),
}));

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unexpected harness error";
