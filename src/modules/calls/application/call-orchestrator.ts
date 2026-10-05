import { operationalLog } from "../../../shared/observability/operational-log.js";
import { markCallEnded } from "./call-liveness.js";
import type { BusinessDirectory } from "../../business/index.js";
import type { AgentDefinitionFactory } from "../../agents/index.js";
import type {
  ConversationServiceContract,
  ConversationSession,
} from "../../conversation/index.js";
import type { VoiceMediaGateway } from "../../voice/index.js";
import type { CallOrchestrator, CallRecord, CallState, TelephonyEvent } from "./contracts.js";
import type { CallRepository } from "../ports/call-repository.js";
import type {
  CallCustomerDirectory,
  CallTelephonyGateway,
} from "../ports/call-dependencies.js";

const terminalStates = new Set<CallState>(["COMPLETED", "FAILED", "TRANSFERRED"]);

export class CallOrchestratorService implements CallOrchestrator {
  private readonly incomingCalls = new Map<string, Promise<void>>();
  private readonly sessions = new Map<string, ConversationSession>();

  constructor(
    private readonly businessDirectory: BusinessDirectory,
    private readonly customers: CallCustomerDirectory,
    private readonly telephony: CallTelephonyGateway,
    private readonly agents: AgentDefinitionFactory,
    private readonly voice: VoiceMediaGateway,
    private readonly conversations: ConversationServiceContract,
    private readonly calls: CallRepository,
    private readonly developerTestModeAuthorized = false,
  ) {}

  async handleTelephonyEvent(event: TelephonyEvent): Promise<void> {
    if (event.type === "INCOMING_CALL") {
      const existing = this.incomingCalls.get(event.callId);
      if (existing) return existing;
      const starting = this.handleIncoming(event).finally(() => this.incomingCalls.delete(event.callId));
      this.incomingCalls.set(event.callId, starting);
      return starting;
    }
    if (event.type === "CALL_HUNG_UP") {
      try { await this.incomingCalls.get(event.callId); }
      finally { await this.shutdown(event.callId, event.occurredAt); }
      return;
    }
    // DTMF is persisted by the telephony implementation if required; it does not alter call state.
  }

  async interrupt(callId: string, position?: import("../../conversation/index.js").AssistantPlaybackPosition): Promise<void> {
    await this.sessions.get(callId)?.interrupt(position);
  }

  private async handleIncoming(event: Extract<TelephonyEvent, { type: "INCOMING_CALL" }>): Promise<void> {
    if (await this.calls.findByCallId(event.callId)) return;

    const location = await this.businessDirectory.resolveLocationByCalledNumber(event.to);
    if (!location.ok) {
      await this.telephony.hangup(event.callId);
      return;
    }

    const record: CallRecord = {
      callId: event.callId,
      tenantId: location.value.tenantId,
      locationId: location.value.locationId,
      from: event.from,
      to: event.to,
      state: "RINGING",
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
    await this.calls.create(record);
    operationalLog("call.started", {}, record);

    const answered = await this.telephony.answer(event.callId);
    if (!answered.ok) return this.fail(record.callId, event.occurredAt);
    await this.transition(record.callId, "ANSWERED", event.occurredAt);

    const customer = await this.customers.findOrCreateByPhone({ tenantId: record.tenantId, phone: event.from });
    if (!customer.ok) return this.fail(record.callId, event.occurredAt);
    await this.calls.setCustomer(record.callId, customer.value.id, event.occurredAt);
    await this.transition(record.callId, "AI_CONNECTING", event.occurredAt);

    const agent = await this.agents.prepare({
      callId: record.callId,
      tenantId: record.tenantId,
      locationId: record.locationId,
      customerId: customer.value.id,
      ...(this.developerTestModeAuthorized ? { developerTestModeAuthorized: true as const } : {}),
    });
    if (!agent.ok) return this.fail(record.callId, event.occurredAt);

    const media = await this.voice.open(record.callId);
    if (!media.ok) return this.fail(record.callId, event.occurredAt);

    let conversation: ConversationSession;
    try {
      conversation = await this.conversations.start({
        conversationId: record.callId,
        agent: agent.value,
        transport: media.value,
        ...(media.value.observeEvent ? { observeEvent: media.value.observeEvent } : {}),
      });
    } catch {
      await media.value.close();
      return this.fail(record.callId, event.occurredAt);
    }

    this.sessions.set(record.callId, conversation);
    await this.transition(record.callId, "IN_CONVERSATION", event.occurredAt);
    void conversation.completed.then(async completion => {
      operationalLog("call.session_ended", { phase: completion.status }, record);
      if (this.sessions.get(record.callId) !== conversation) return;
      this.sessions.delete(record.callId);
      try { await conversation.close(); }
      finally {
        const latest = await this.calls.findByCallId(record.callId);
        if (latest && !terminalStates.has(latest.state) && latest.state !== "TRANSFERRING") {
          await this.transition(record.callId, completion.status === "failed" ? "FAILED" : "COMPLETED", new Date().toISOString());
          await this.telephony.hangup(record.callId);
        }
      }
    }).catch(() => operationalLog("call.cleanup.failed", {}, record));
  }

  private async shutdown(callId: string, occurredAt: string): Promise<void> {
    markCallEnded(callId);
    const record = await this.calls.findByCallId(callId);
    if (!record) return;
    operationalLog("call.hangup", {}, record);

    const session = this.sessions.get(callId);
    if (session) {
      this.sessions.delete(callId);
      await session.close();
    }
    if (terminalStates.has(record.state)) return;
    await this.transition(callId, "COMPLETED", occurredAt);
  }

  private async fail(callId: string, occurredAt: string): Promise<void> {
    await this.telephony.hangup(callId);
    await this.transition(callId, "FAILED", occurredAt);
  }

  private async transition(callId: string, state: CallState, occurredAt: string): Promise<void> {
    await this.calls.updateState(callId, state, occurredAt);
  }
}
