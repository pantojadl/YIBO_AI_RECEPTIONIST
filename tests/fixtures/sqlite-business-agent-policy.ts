import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVELOPMENT_BUSINESS } from "../../src/app/development-fixtures.js";
import { AgentConfigurationService, AgentDefinitionService } from "../../src/modules/agents/index.js";
import { agentConfigurationRevision } from "../../src/modules/agents/application/agent-configuration-service.js";
import { BusinessDirectoryService } from "../../src/modules/business/index.js";
import { SqliteAgentConfigurationRepository } from "../../src/infrastructure/database/sqlite-agent-configuration-repository.js";
import { SqliteBusinessRepository } from "../../src/infrastructure/database/sqlite-business-repository.js";
import { migrateDatabase, seedBusiness } from "../../src/infrastructure/database/regional-database.js";

const directory = mkdtempSync(join(tmpdir(), "yibo-agent-policy-test-"));
let database = new DatabaseSync(join(directory, "test.sqlite"));
try {
  migrateDatabase(database);
  seedBusiness(database, DEVELOPMENT_BUSINESS);
  const other = structuredClone(DEVELOPMENT_BUSINESS);
  other.tenantId = "other-tenant"; other.businessId = "other-business";
  other.locations[0]!.calledNumbers = ["+529991000098"];
  seedBusiness(database, other);
  const source = new SqliteAgentConfigurationRepository(database, "MX");
  const agents = new AgentConfigurationService(source);
  const original = agents.recommended("es-MX", "Synthetic test", "gpt-realtime-2.1");
  await agents.update(DEVELOPMENT_BUSINESS.tenantId, original);
  await agents.update(other.tenantId, original);
  const changed = structuredClone(original); changed.behavior.allowPriceDisclosure = false;
  await agents.update(DEVELOPMENT_BUSINESS.tenantId, changed, agentConfigurationRevision(original));
  const business = new BusinessDirectoryService(new SqliteBusinessRepository(database, "MX"));
  const before = await business.getBusinessConfiguration(DEVELOPMENT_BUSINESS.tenantId);
  assert(before.ok);
  before.value.configuration.locations[0]!.agentOverrides = {
    disabledTools: ["cancel_appointment"], locale: "en-GB", phoneReadback: "digit_by_digit", allowPriceDisclosure: true,
  };
  assert((await business.updateBusinessConfiguration(DEVELOPMENT_BUSINESS.tenantId, before.value.configuration, before.value.version)).ok);
  database.close(); database = new DatabaseSync(join(directory, "test.sqlite"));

  const reopenedSource = new SqliteAgentConfigurationRepository(database, "MX");
  const reopenedAgents = new AgentConfigurationService(reopenedSource);
  const reopenedBusiness = new BusinessDirectoryService(new SqliteBusinessRepository(database, "MX"));
  assert.equal((await reopenedAgents.get(DEVELOPMENT_BUSINESS.tenantId))!.behavior.allowPriceDisclosure, false);
  assert.equal((await reopenedAgents.get(other.tenantId))!.behavior.allowPriceDisclosure, true);
  const location = await reopenedBusiness.getLocation(DEVELOPMENT_BUSINESS.tenantId, "default"); assert(location.ok);
  assert.deepEqual(location.value.location.agentOverrides, before.value.configuration.locations[0]!.agentOverrides);
  const otherLocation = await reopenedBusiness.getLocation(other.tenantId, "default"); assert(otherLocation.ok);
  assert.equal(otherLocation.value.location.agentOverrides, undefined);
  await assert.rejects(reopenedAgents.update(DEVELOPMENT_BUSINESS.tenantId, original, agentConfigurationRevision(original)));
  assert.equal((await reopenedBusiness.updateBusinessConfiguration(DEVELOPMENT_BUSINESS.tenantId, before.value.configuration, before.value.version)).ok, false);
  const context = { tenantId: DEVELOPMENT_BUSINESS.tenantId, locationId: "default", callId: "sqlite-call", turnSequence: 1 };
  const prepared = await new AgentDefinitionService(reopenedSource, {
    execute: async callContext => ({ toolCallId: "t", ok: true, data: { tenant: callContext.tenantId, price: { amountMinor: 12500 } } }),
  }, reopenedBusiness).prepare(context);
  assert(prepared.ok); assert.equal(prepared.value.locale, "en-GB");
  assert.equal(prepared.value.behavior.phoneReadback, "digit_by_digit");
  assert.equal(prepared.value.behavior.allowPriceDisclosure, false);
  assert.equal(prepared.value.tools.some(tool => tool.name === "cancel_appointment"), false);
  assert.deepEqual(await prepared.value.toolExecutor.execute(context, { toolCallId: "t", name: "get_service_information", arguments: {} }), {
    toolCallId: "t", ok: true, data: { tenant: DEVELOPMENT_BUSINESS.tenantId },
  });
  console.log(JSON.stringify({ reopened: true, isolated: true, conflictsProtected: true, runtimeConsumed: true }));
} finally {
  database.close(); rmSync(directory, { recursive: true, force: true });
}
