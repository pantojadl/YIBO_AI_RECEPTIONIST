import { afterEach, describe, expect, it, vi } from "vitest";
import { isCallEnded, resetCallLiveness } from "../../src/modules/calls/index.js";
import { AgentDefinitionService, InMemoryAgentConfigurationSource, type AgentToolName, type ToolExecutor } from "../../src/modules/agents/index.js";
import { BusinessDirectoryService, InMemoryBusinessRepository, type BusinessProfile } from "../../src/modules/business/index.js";
import { CallOrchestratorService, InMemoryCallRepository, type CallCustomerDirectory, type CallTelephonyGateway } from "../../src/modules/calls/index.js";
import { ConversationService, ScriptedConversationRuntime } from "../../src/modules/conversation/index.js";
import { ScriptedVoiceMediaGateway, type ConversationTransport } from "../../src/modules/voice/index.js";

const business: BusinessProfile = {
  region: "US",
  tenantId: "tenant-smileline", businessId: "business-smileline", name: "SmileLine Dental", timezone: "America/Denver", locale: "en-US", active: true,
  calledNumbers: ["+13035550123"], employees: [{ id: "employee-1", displayName: "Dr. Lee", active: true }],
  services: [{ id: "service-1", name: "Consultation", durationMinutes: 30, bufferMinutes: 0, eligibleEmployeeIds: ["employee-1"] }],
  openingHours: [],
};

const incoming = { type: "INCOMING_CALL" as const, callId: "call-1", from: "+13035550999", to: "+13035550123", occurredAt: "2026-08-09T18:00:00.000Z" };
const noAudio = async function* () {};

const createOrchestrator = (overrides: { agentOk?: boolean; customerOk?: boolean } = {}) => {
  const repository = new InMemoryCallRepository();
  const telephony: CallTelephonyGateway = { answer: vi.fn(async () => ({ ok: true })), hangup: vi.fn(async () => ({ ok: true })) };
  const customers: CallCustomerDirectory = { findOrCreateByPhone: vi.fn(async () => {
    if (overrides.customerOk === false) return { ok: false } as const;
    return { ok: true, value: { id: "customer-1" } } as const;
  }) };
  const toolExecutor: ToolExecutor = { execute: vi.fn() };
  const configurations = overrides.agentOk === false ? [] : [{
    tenantId: business.tenantId,
    configuration: {
      instructions: "Help the caller", locale: "en-US",
      enabledTools: ["check_availability", "create_appointment", "cancel_appointment", "transfer_to_human"] as AgentToolName[],
      conversation: { model: "gpt-realtime-2.1", maxOutputTokens: 512, reasoningEffort: "minimal" as const, turnDetection: {} },
    },
  }];
  const directory = new BusinessDirectoryService(new InMemoryBusinessRepository([business]));
  const agents = new AgentDefinitionService(new InMemoryAgentConfigurationSource(configurations), toolExecutor, directory);
  const transportClose = vi.fn(async () => undefined);
  const transport: ConversationTransport = {
    inboundAudio: noAudio(),
    outboundAudio: { write: vi.fn() },
    close: transportClose,
  };
  const voice = new ScriptedVoiceMediaGateway();
  voice.register(incoming.callId, transport);
  const runtime = new ScriptedConversationRuntime();
  const conversations = new ConversationService({ runtime });
  return {
    orchestrator: new CallOrchestratorService(directory, customers, telephony, agents, voice, conversations, repository),
    repository,
    runtime,
    telephony,
    transportClose,
    voice,
  };
};

describe("CallOrchestratorService", () => {
  afterEach(() => resetCallLiveness());

  it("starts a conversation through the public agent, voice and conversation APIs", async () => {
    const system = createOrchestrator();

    await system.orchestrator.handleTelephonyEvent(incoming);

    expect(system.repository.stateHistory.map((entry) => entry.state)).toEqual(["RINGING", "ANSWERED", "AI_CONNECTING", "IN_CONVERSATION"]);
    await expect(system.repository.findByCallId(incoming.callId)).resolves.toMatchObject({ tenantId: business.tenantId, locationId: "default", customerId: "customer-1", from: incoming.from, to: incoming.to, state: "IN_CONVERSATION" });
    expect(system.voice.openedCallIds).toEqual([incoming.callId]);
    expect(system.runtime.openedInputs).toEqual([{
      conversationId: incoming.callId,
      agent: expect.objectContaining({
        instructions: expect.stringContaining("<editable_guidance>\nHelp the caller\n</editable_guidance>"),
        locale: "en-US",
        tools: expect.arrayContaining([expect.objectContaining({ name: "check_availability" })]),
      }),
    }]);
  });

  it("forwards optional transport diagnostics to the conversation service", async () => {
    const system = createOrchestrator();
    const observed: string[] = [];
    system.voice.register(incoming.callId, {
      inboundAudio: noAudio(),
      outboundAudio: { write: vi.fn() },
      close: vi.fn(async () => undefined),
      observeEvent: (event) => observed.push(event.type),
    });

    await system.orchestrator.handleTelephonyEvent(incoming);
    system.runtime.latestSession.emit({ type: "user.speech_started" });

    await vi.waitFor(() => expect(observed).toEqual(["user.speech_started"]));
  });

  it("closes the conversation and media exactly once when the call hangs up", async () => {
    const system = createOrchestrator();
    await system.orchestrator.handleTelephonyEvent(incoming);

    await system.orchestrator.handleTelephonyEvent({ type: "CALL_HUNG_UP", callId: incoming.callId, occurredAt: "2026-08-09T18:03:00.000Z" });
    await system.orchestrator.handleTelephonyEvent({ type: "CALL_HUNG_UP", callId: incoming.callId, occurredAt: "2026-08-09T18:04:00.000Z" });

    expect(system.runtime.latestSession.closeCount).toBe(1);
    expect(system.transportClose).toHaveBeenCalledTimes(1);
    expect(system.repository.stateHistory.at(-1)).toEqual({ callId: incoming.callId, state: "COMPLETED" });
    expect(isCallEnded(incoming.callId)).toBe(true);
  });

  it("closes media after a transferred call without replacing its terminal state", async () => {
    const system = createOrchestrator();
    await system.orchestrator.handleTelephonyEvent(incoming);
    await system.repository.updateState(incoming.callId, "TRANSFERRED", "2026-08-09T18:02:00.000Z");

    await system.orchestrator.handleTelephonyEvent({
      type: "CALL_HUNG_UP", callId: incoming.callId, occurredAt: "2026-08-09T18:03:00.000Z",
    });

    expect(system.runtime.latestSession.closeCount).toBe(1);
    expect(system.transportClose).toHaveBeenCalledTimes(1);
    await expect(system.repository.findByCallId(incoming.callId)).resolves.toMatchObject({ state: "TRANSFERRED" });
  });

  it("fails and hangs up when an agent definition cannot be prepared", async () => {
    const system = createOrchestrator({ agentOk: false });
    await system.orchestrator.handleTelephonyEvent(incoming);
    expect(system.telephony.hangup).toHaveBeenCalledWith(incoming.callId);
    expect(system.runtime.sessions).toHaveLength(0);
    expect(system.repository.stateHistory.at(-1)).toEqual({ callId: incoming.callId, state: "FAILED" });
  });

  it("does not create a call record for an unknown called number", async () => {
    const system = createOrchestrator();
    await system.orchestrator.handleTelephonyEvent({ ...incoming, to: "+13035550000" });
    expect(system.repository.stateHistory).toEqual([]);
    expect(system.telephony.hangup).toHaveBeenCalledWith(incoming.callId);
  });
});
