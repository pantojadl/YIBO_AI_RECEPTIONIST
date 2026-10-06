import { failure, success } from "../../../shared/domain/result.js";
import type { ConversationTransport, VoiceMediaGateway } from "../application/contracts.js";

export class ScriptedVoiceMediaGateway implements VoiceMediaGateway {
  readonly openedCallIds: string[] = [];
  private readonly transports = new Map<string, ConversationTransport>();

  register(callId: string, transport: ConversationTransport): () => void {
    this.transports.set(callId, transport);
    return () => {
      if (this.transports.get(callId) === transport) this.transports.delete(callId);
    };
  }

  async open(callId: string) {
    this.openedCallIds.push(callId);
    const transport = this.transports.get(callId);
    if (!transport) {
      return failure({
        code: "MEDIA_NOT_AVAILABLE" as const,
        message: `No media transport is registered for call ${callId}`,
      });
    }
    return success(transport);
  }
}
