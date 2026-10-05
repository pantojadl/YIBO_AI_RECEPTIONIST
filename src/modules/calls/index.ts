export { CallOrchestratorService } from "./application/call-orchestrator.js";
export { isCallEnded, markCallEnded, resetCallLiveness } from "./application/call-liveness.js";
export type { CallHistoryEntry, CallOrchestrator, CallRecord, CallState, TelephonyEvent } from "./application/contracts.js";
export type { CallHistoryReader, CallRepository } from "./ports/call-repository.js";
export type {
  CallCustomerDirectory,
  CallTelephonyGateway,
} from "./ports/call-dependencies.js";
export { InMemoryCallRepository } from "./infrastructure/in-memory-call-repository.js";
