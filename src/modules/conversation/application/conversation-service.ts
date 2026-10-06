import { markCallEnded, isCallEnded, pinCall, unpinCall } from "../../calls/application/call-liveness.js";
import { ConversationMetrics } from "../../../shared/observability/conversation-metrics.js";
import { withOperationalContext } from "../../../shared/observability/operational-log.js";
import type { AgentToolResult } from "../../agents/index.js";
import type {
  ConversationRuntimeEvent,
  ToolResultEnvelope,
} from "../ports/conversation-runtime-port.js";
import type {
  ConversationCompletion,
  ConversationError,
  ConversationServiceContract,
  ConversationServiceDependencies,
  ConversationSession,
  ConversationSessionControllerDependencies,
  StartConversationCommand,
} from "./contracts.js";

export class ConversationService implements ConversationServiceContract {
  constructor(private readonly dependencies: ConversationServiceDependencies) {}

  async start(command: StartConversationCommand): Promise<ConversationSession> {
    const canEnd = supportsCallEnd(command);
    const metrics = new ConversationMetrics(command.agent.trustedContext);
    const started = performance.now();
    const runtimeSession = await withOperationalContext(command.agent.trustedContext, () => this.dependencies.runtime.openSession({
      conversationId: command.conversationId,
      agent: {
        instructions: command.agent.instructions + (canEnd ? "\nWhen the caller is finished, speak one concise final farewell, then invoke end_call with {}. If end_call returns farewellRequired, speak that farewell in your next response without calling another tool or asking another question. Do not call it before completing requested actions and stating their actual results. Do not ask another question after saying goodbye. If the caller interrupts, continue helping; end_call never confirms a booking." : ""),
        locale: command.agent.locale,
        ...(command.agent.voice ? { voice: command.agent.voice } : {}),
        tools: [...command.agent.tools, ...(canEnd ? [{ name: "end_call" as const,
          description: "Request conversation completion after final farewell audio has played. If the result requests a farewell, speak it once in your next response. Use only when the caller is finished and all requested actions have resolved. No arguments; never claims booking success.",
          inputSchema: { type: "object", additionalProperties: false, properties: {} },
        }] : [])],
        conversation: structuredClone(command.agent.conversation),
        audio: structuredClone(command.agent.audio),
        behavior: structuredClone(command.agent.behavior),
        toolChoice: command.agent.toolChoice,
        parallelToolCalls: command.agent.parallelToolCalls,
        channel: command.agent.channel,
      },
    })).catch(error => {
      metrics.observe({ type: "error", code: "CONNECTION_FAILED", message: "", retryable: false });
      metrics.close(); throw error;
    });
    metrics.timing("session_startup", performance.now() - started);

    return new ActiveConversationSession({
      runtimeSession,
      command,
      ...(this.dependencies.usageRecorder ? { usageRecorder: this.dependencies.usageRecorder } : {}),
      spendLimit: this.dependencies.spendLimit ?? {
        maxDurationMs: DEFAULT_CALL_MAX_DURATION_MS,
        maxTokens: DEFAULT_CALL_MAX_TOKENS,
      },
    }, metrics);
  }
}

class ActiveConversationSession implements ConversationSession {
  readonly completed: Promise<ConversationCompletion>;

  private resolveCompleted!: (completion: ConversationCompletion) => void;
  private completionSettled = false;
  private closePromise?: Promise<void>;
  private interruptedTurnId?: string;
  private turnSequence = 0;
  private readonly toolCalls = new Set<string>();
  private readonly deadlines = new Set<() => void>();
  private readonly metrics: ConversationMetrics;
  private removeMediaObserver?: () => void;
  private removePlaybackObserver?: () => void;
  private activeTools = 0;
  private responseSequence = 0;
  private responseComplete = false;
  private lastAudioTurn?: string;
  private audioComplete = false;
  private playbackIdle = false;
  private ending?: { flushed: boolean; acknowledged: boolean; response: number; turn?: string; deadline: ReturnType<typeof setTimeout> };
  private endTail?: ReturnType<typeof setTimeout>;
  private mutationPending = false;
  private mutationUncertain = false;
  private spentTokens = 0;
  private spendWrapUpStarted = false;
  private spendCloseOnResponse = false;
  private spendTimer?: ReturnType<typeof setTimeout>;
  private spendShutdownTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly dependencies: ConversationSessionControllerDependencies, metrics: ConversationMetrics) {
    this.metrics = metrics;
    try { this.removeMediaObserver = dependencies.command.transport.outboundAudio.onFirstAudioSent?.(turnId => this.metrics.mediaSent(turnId)); } catch { /* Optional observation only. */ }
    if (supportsCallEnd(dependencies.command)) this.removePlaybackObserver = dependencies.command.transport.outboundAudio.onPlaybackIdle!(() => {
      this.playbackIdle = true;
      this.checkCallEnd();
    });
    this.completed = new Promise((resolve) => { this.resolveCompleted = resolve; });
    const limit = dependencies.spendLimit ?? { maxDurationMs: DEFAULT_CALL_MAX_DURATION_MS, maxTokens: DEFAULT_CALL_MAX_TOKENS };
    this.dependencies.spendLimit = limit;
    this.spendTimer = setTimeout(() => { void this.beginSpendWrapUp(); }, limit.maxDurationMs);
    this.spendTimer.unref?.();
    void this.forwardInboundAudio();
    void this.consumeRuntimeEvents();
  }

  interrupt(position?: import("../ports/conversation-runtime-port.js").AssistantPlaybackPosition): Promise<void> {
    this.cancelCallEnd();
    this.lastAudioTurn = undefined;
    if (position) this.interruptedTurnId = position.assistantTurnId;
    return this.dependencies.runtimeSession.interrupt(position);
  }

  async sendText(text: string): Promise<void> {
    this.cancelCallEnd();
    this.lastAudioTurn = undefined;
    await this.dependencies.runtimeSession.sendText(text);
    this.turnSequence += 1;
  }

  close(): Promise<void> {
    markCallEnded(this.dependencies.command.agent.trustedContext.callId);
    if (!this.closePromise) {
      this.closePromise = this.closeResources();
    }
    return this.closePromise;
  }

  private async forwardInboundAudio(): Promise<void> {
    try {
      for await (const frame of this.dependencies.command.transport.inboundAudio) {
        if (this.spendWrapUpStarted || this.closePromise) continue;
        await this.bounded(this.dependencies.runtimeSession.sendAudio(frame), 5_000);
      }
    } catch (error) {
      await this.fail({
        code: "AUDIO_TRANSPORT_ERROR",
        message: errorMessage(error),
      });
    }
  }

  private async consumeRuntimeEvents(): Promise<void> {
    try {
      for await (const event of this.dependencies.runtimeSession.events()) {
        await this.handleRuntimeEvent(event);
        if (event.type === "closed" || event.type === "error") return;
      }
      if (!this.closePromise && !this.completionSettled) { this.settle({status:"closed",reason:"runtime_stream_ended"}); await this.close(); }
    } catch (error) {
      await this.fail({
        code: "RUNTIME_ERROR",
        message: errorMessage(error),
        retryable: false,
      });
    }
  }

  private async handleRuntimeEvent(event: ConversationRuntimeEvent): Promise<void> {
    if (this.closePromise || this.completionSettled) return;
    this.observe(event);
    switch (event.type) {
      case "audio.delta":
        if (event.assistantTurnId === this.interruptedTurnId) return;
        this.interruptedTurnId = undefined;
        if (this.ending && !this.ending.turn && this.ending.response === this.responseSequence) this.ending.turn = event.assistantTurnId;
        else if (this.ending && this.ending.turn !== event.assistantTurnId) this.cancelCallEnd();
        this.lastAudioTurn = event.assistantTurnId;
        this.audioComplete = false;
        this.playbackIdle = false;
        try {
          await this.bounded(this.dependencies.command.transport.outboundAudio.write(event.frame, event.assistantTurnId), 5_000);
        } catch (error) {
          await this.fail({ code: "AUDIO_TRANSPORT_ERROR", message: errorMessage(error) });
        }
        return;
      case "tool.call":
        if (event.name === "end_call") void this.requestCallEnd(event);
        else void this.executeTool({ ...event, name: event.name });
        return;
      case "user.speech_started":
        this.cancelCallEnd();
        if (this.spendWrapUpStarted) void this.reRequestSpendFarewell();
        this.lastAudioTurn = undefined;
        this.turnSequence += 1;
        await this.handleBargeIn();
        return;
      case "error":
        await this.fail({
          code: "RUNTIME_ERROR",
          message: event.message,
          retryable: event.retryable,
        });
        return;
      case "closed":
        this.settle({ status: "closed", ...(event.reason ? { reason: event.reason } : {}) });
        await this.close();
        return;
      case "assistant.response_created":
        this.responseSequence += 1;
        // A function-only end_call response needs one following farewell response.
        if (this.ending?.response !== this.responseSequence || this.ending.turn) this.cancelCallEnd();
        this.responseComplete = false;
        this.lastAudioTurn = undefined;
        this.audioComplete = false;
        return;
      case "assistant.response_done":
        if (event.status === "failed" && this.ending) {
          const error = { code: "RUNTIME_ERROR" as const, message: "The final farewell response failed", retryable: false };
          this.observe({ type: "error", ...error });
          await this.fail(error);
          return;
        }
        if (event.status !== "completed") {
          this.cancelCallEnd();
          this.lastAudioTurn = undefined;
          this.responseComplete = false;
          if (this.spendWrapUpStarted) void this.reRequestSpendFarewell();
          return;
        }
        this.responseComplete = true;
        if (this.spendCloseOnResponse) {
          this.settle({ status: "closed", reason: "spend_limit" });
          await this.close();
          return;
        }
        this.checkCallEnd();
        return;
      case "assistant.audio_completed":
        if (event.assistantTurnId === this.lastAudioTurn) this.audioComplete = true;
        this.checkCallEnd();
        return;
      case "assistant.transcript":
      case "silence.timeout":
        return;
      case "user.speech_stopped":
        return;
      case "usage":
        void this.recordUsage(event).catch(() => undefined);
        return;
    }
  }

  private async recordUsage(event: Extract<ConversationRuntimeEvent, { type: "usage" }>): Promise<void> {
    const increment = event.totalTokens ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    this.spentTokens += increment;
    const limit = this.dependencies.spendLimit?.maxTokens ?? DEFAULT_CALL_MAX_TOKENS;
    if (this.spentTokens >= limit) await this.beginSpendWrapUp();
    if (!this.dependencies.usageRecorder) return;
    await this.dependencies.usageRecorder.record({
      tenantId: this.dependencies.command.agent.trustedContext.tenantId,
      callId: this.dependencies.command.agent.trustedContext.callId,
      occurredAt: new Date().toISOString(),
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
      inputAudioMs: event.inputAudioMs ?? 0,
      outputAudioMs: event.outputAudioMs ?? 0,
      toolCalls: event.toolCalls ?? 0,
    });
  }

  private async handleBargeIn(): Promise<void> {
    const position = await this.dependencies.command.transport.outboundAudio.interrupt?.();
    if (!position) return;
    this.interruptedTurnId = position.assistantTurnId;
    await this.dependencies.runtimeSession.interrupt(position);
  }

  private async executeTool(event: Extract<ConversationRuntimeEvent, { type: "tool.call" }> & { name: import("../../agents/index.js").AgentToolName }): Promise<void> {
    if (this.toolCalls.has(event.toolCallId) || this.closePromise || isCallEnded(this.dependencies.command.agent.trustedContext.callId)) return;
    if (this.spendWrapUpStarted) {
      this.toolCalls.add(event.toolCallId);
      const limited = { toolCallId: event.toolCallId, ok: false as const, error: {
        code: "CALL_SPEND_LIMIT",
        message: "This call has reached its limit. Speak a brief goodbye only. Do not continue the request.",
        retryable: false,
      } };
      try {
        await this.bounded(this.dependencies.runtimeSession.sendToolResult(limited, { requestResponse: false }), 5_000);
      } catch { /* The farewell turn is already requested. */ }
      return;
    }
    this.cancelCallEnd();
    this.lastAudioTurn = undefined;
    this.activeTools += 1;
    this.toolCalls.add(event.toolCallId);
    const callId = this.dependencies.command.agent.trustedContext.callId;
    pinCall(callId);
    try {
    this.observe({type:"tool.execution",phase:"started",toolCallId:event.toolCallId,name:event.name});
    const mutable = ["create_appointment", "cancel_appointment", "reschedule_appointment", "transfer_to_human", "update_customer"].includes(event.name);
    let result: ToolResultEnvelope;
    if (mutable && (this.mutationPending || this.mutationUncertain)) {
      result = {toolCallId:event.toolCallId,ok:false,error:{code:"ACTION_OUTCOME_UNKNOWN",message:"A prior action is pending or uncertain. Do not retry or claim success; ask staff to verify it.",retryable:false}};
    } else {
      if (mutable) this.mutationPending = true;
      try {
        const executed = await this.bounded(withOperationalContext(this.dependencies.command.agent.trustedContext, () => this.dependencies.command.agent.toolExecutor.execute(
          { ...this.dependencies.command.agent.trustedContext, turnSequence: this.turnSequence },
          {toolCallId:event.toolCallId,name:event.name,arguments:event.arguments},
        )), 12_000);
        result = toEnvelope(executed);
      } catch (error) {
        if (error instanceof CallDeadlineError && mutable) this.mutationUncertain = true;
        result = {toolCallId:event.toolCallId,ok:false,error:{
          code: error instanceof CallDeadlineError ? (mutable ? "ACTION_OUTCOME_UNKNOWN" : "TOOL_TIMEOUT") : "TOOL_EXECUTION_FAILED",
          message: error instanceof CallDeadlineError && mutable ? "The action may have completed. Do not claim success or retry; ask staff to verify it." : "The operation did not complete. Explain the failure without claiming success.",retryable:false,
        }};
      } finally { if (mutable) this.mutationPending = false; }
    }
    if (this.closePromise || this.completionSettled) return;
    try {
      await this.bounded(this.dependencies.runtimeSession.sendToolResult(result), 5_000);
      this.observe({type:"tool.execution",phase:result.ok?"completed":"failed",...(!result.ok ? { outcomeCode: result.error.code } : {}),toolCallId:event.toolCallId,name:event.name});
    } catch { if (!this.closePromise) await this.fail({code:"TOOL_EXECUTION_ERROR",message:"Tool result delivery failed"}); }
    finally { this.activeTools -= 1; }
    } finally { unpinCall(callId); }
  }

  private async requestCallEnd(event: Extract<ConversationRuntimeEvent, { type: "tool.call" }>): Promise<void> {
    if (this.toolCalls.has(event.toolCallId) || this.closePromise || this.completionSettled) return;
    this.toolCalls.add(event.toolCallId);
    const valid = typeof event.arguments === "object" && event.arguments !== null
      && !Array.isArray(event.arguments) && Object.keys(event.arguments).length === 0;
    const accepted = supportsCallEnd(this.dependencies.command) && valid && !this.activeTools
      && !this.mutationUncertain;
    const requestFarewell = accepted && !this.ending && !this.lastAudioTurn;
    if (accepted && !this.ending) {
      this.ending = { flushed: false, acknowledged: false, response: this.responseSequence + (requestFarewell ? 1 : 0),
        ...(this.lastAudioTurn ? { turn: this.lastAudioTurn } : {}),
        deadline: setTimeout(() => { void this.fail({ code: "AUDIO_TRANSPORT_ERROR", message: "Final response playback did not complete" }); }, 45_000) };
    }
    const end = this.ending;
    try {
      await this.bounded(this.dependencies.runtimeSession.sendToolResult(accepted
        ? { toolCallId: event.toolCallId, ok: true, data: { ending: true, ...(requestFarewell ? {
          farewellRequired: true, message: "Speak one concise farewell now. Do not ask a question or call another tool. The session will close after your audio finishes; this does not confirm any appointment action.",
        } : {}) } }
        : { toolCallId: event.toolCallId, ok: false, error: { code: "CALL_END_NOT_READY", message: "Continue assisting. Resolve pending actions and speak a final farewell before requesting call end. Never claim uncertain actions succeeded.", retryable: false } },
        { requestResponse: requestFarewell || (!accepted && !end) }), 5_000);
      if (accepted && end && this.ending === end) end.acknowledged = true;
      this.checkCallEnd();
    } catch { if (!this.closePromise) await this.fail({ code: "TOOL_EXECUTION_ERROR", message: "Call-end result delivery failed" }); }
  }

  private checkCallEnd(): void {
    const end = this.ending;
    if (!end || !end.turn || !end.acknowledged || end.response !== this.responseSequence || end.turn !== this.lastAudioTurn
      || !this.responseComplete || !this.audioComplete || this.activeTools
      || this.mutationUncertain || this.closePromise || this.completionSettled) return;
    if (!end.flushed) {
      end.flushed = true;
      this.dependencies.command.transport.outboundAudio.finishAudio?.(end.turn);
    }
    if (!this.isPlaybackIdle() || this.endTail) return;
    // The last PCMU packet represents 20 ms of sound after local UDP send completes.
    this.endTail = setTimeout(() => {
      this.endTail = undefined;
      if (this.ending !== end || !this.isPlaybackIdle() || !this.audioComplete || !this.responseComplete) return;
      this.settle({ status: "closed", reason: this.spendWrapUpStarted ? "spend_limit" : "conversation_completed" });
      void this.close();
    }, 20);
  }

  private isPlaybackIdle(): boolean {
    const state = this.dependencies.command.transport.outboundAudio.getBargeInDiagnostics?.();
    return this.playbackIdle && (!state || (!state.outboundRtpPlaying && state.outboundQueueDepth === 0));
  }

  private cancelCallEnd(): void {
    if (this.ending) clearTimeout(this.ending.deadline);
    if (this.endTail) clearTimeout(this.endTail);
    this.ending = undefined;
    this.endTail = undefined;
  }

  private observe(event: ConversationRuntimeEvent): void {
    try { this.metrics.observe(event); } catch { /* Observation only. */ }
    try { this.dependencies.command.observeEvent?.(event); } catch { /* Observation cannot block or terminate a call. */ }
  }

  private bounded<T>(operation: Promise<T>, durationMs: number): Promise<T> {
    return new Promise<T>((resolve,reject) => {
      const cancel = () => { clearTimeout(timer); this.deadlines.delete(cancel); reject(new CallDeadlineError()); };
      const timer = setTimeout(cancel,durationMs);
      this.deadlines.add(cancel);
      operation.then(resolve,reject).finally(() => {clearTimeout(timer);this.deadlines.delete(cancel);});
    });
  }

  private async fail(error: ConversationError): Promise<void> {
    this.settle({ status: "failed", error });
    await this.close();
  }

  private async beginSpendWrapUp(): Promise<void> {
    if (this.spendWrapUpStarted || this.closePromise || this.completionSettled) return;
    this.spendWrapUpStarted = true;
    this.armSpendShutdown();
    const canDrain = supportsCallEnd(this.dependencies.command);
    if (canDrain && !this.ending) {
      this.ending = {
        flushed: false,
        acknowledged: true,
        response: this.responseSequence + 1,
        deadline: setTimeout(() => { void this.fail({ code: "AUDIO_TRANSPORT_ERROR", message: "Final response playback did not complete" }); }, 45_000),
      };
    } else if (!canDrain) this.spendCloseOnResponse = true;
    try {
      const runtime = this.dependencies.runtimeSession;
      if (runtime.requestResponse) await runtime.requestResponse(SPEND_LIMIT_FAREWELL);
      else await runtime.sendText(SPEND_LIMIT_FAREWELL);
    } catch {
      await this.close();
    }
  }

  private async reRequestSpendFarewell(): Promise<void> {
    if (!this.spendWrapUpStarted || this.closePromise || this.completionSettled) return;
    try {
      const runtime = this.dependencies.runtimeSession;
      if (runtime.requestResponse) await runtime.requestResponse(SPEND_LIMIT_FAREWELL);
      else await runtime.sendText(SPEND_LIMIT_FAREWELL);
    } catch {
      await this.close();
    }
  }

  private armSpendShutdown(): void {
    if (this.spendShutdownTimer || this.closePromise || this.completionSettled) return;
    // Independent of the farewell timer. Caller speech and a cancelled response clear that one.
    this.spendShutdownTimer = setTimeout(() => {
      this.spendShutdownTimer = undefined;
      if (this.closePromise || this.completionSettled) return;
      this.settle({ status: "closed", reason: "spend_limit" });
      void this.close();
    }, SPEND_FORCED_SHUTDOWN_MS);
    this.spendShutdownTimer.unref?.();
  }

  private async closeResources(): Promise<void> {
    const cleanupStarted = performance.now();
    if (this.spendTimer) clearTimeout(this.spendTimer);
    this.spendTimer = undefined;
    if (this.spendShutdownTimer) clearTimeout(this.spendShutdownTimer);
    this.spendShutdownTimer = undefined;
    this.cancelCallEnd();
    this.removePlaybackObserver?.();
    try { this.removeMediaObserver?.(); } catch { /* Observation only. */ }
    for (const cancel of [...this.deadlines]) cancel();
    const results = await Promise.allSettled([
      this.bounded(Promise.resolve().then(() => this.dependencies.runtimeSession.close()), 5_000),
      this.bounded(Promise.resolve().then(() => this.dependencies.command.transport.close()), 5_000),
    ]);
    this.metrics.timing("cleanup", performance.now() - cleanupStarted);
    this.metrics.close();
    if (!this.completionSettled) {
      const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejection) {
        this.settle({
          status: "failed",
          error: { code: "RUNTIME_ERROR", message: errorMessage(rejection.reason), retryable: false },
        });
      } else {
        this.settle({ status: "closed" });
      }
    }
  }

  private settle(completion: ConversationCompletion): void {
    if (this.completionSettled) return;
    this.completionSettled = true;
    this.resolveCompleted(completion);
  }

}

const DEFAULT_CALL_MAX_DURATION_MS = 15 * 60_000;
const DEFAULT_CALL_MAX_TOKENS = 150_000;
/** Once a hard spend cap is reached, the session ends even if the farewell is interrupted. */
export const SPEND_FORCED_SHUTDOWN_MS = 45_000;
const SPEND_LIMIT_FAREWELL = "The call has reached its time or usage limit. Speak one short, polite farewell now. Do not ask a question, book, cancel, reschedule, or call a tool.";

const toEnvelope = (result: AgentToolResult): ToolResultEnvelope => result.ok
  ? { toolCallId: result.toolCallId, ok: true, data: result.data }
  : {
      toolCallId: result.toolCallId,
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.messageForAgent,
        retryable: result.error.retryable,
        ...(result.error.confirmationToken ? { confirmationToken: result.error.confirmationToken } : {}),
      },
    };

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : "Unexpected conversation failure";

class CallDeadlineError extends Error {}

const supportsCallEnd = (command: StartConversationCommand): boolean => (command.agent.channel === "phone" || command.agent.channel === "voice_lab")
  && command.agent.toolChoice !== "none" && !command.agent.parallelToolCalls
  && typeof command.transport.outboundAudio.onPlaybackIdle === "function";
