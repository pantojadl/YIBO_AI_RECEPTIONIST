import type {
  ConversationRuntimeEvent,
  ConversationRuntimePort,
  ConversationRuntimeSession,
  OpenConversationInput,
  ToolResultEnvelope,
  AudioFrame,
  AssistantPlaybackPosition,
} from "../ports/conversation-runtime-port.js";

export class ScriptedConversationRuntime implements ConversationRuntimePort {
  readonly openedInputs: OpenConversationInput[] = [];
  readonly sessions: ScriptedConversationRuntimeSession[] = [];

  async openSession(input: OpenConversationInput): Promise<ConversationRuntimeSession> {
    this.openedInputs.push(input);
    const session = new ScriptedConversationRuntimeSession();
    this.sessions.push(session);
    return session;
  }

  get latestSession(): ScriptedConversationRuntimeSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("No scripted conversation session has been opened");
    return session;
  }
}

export class ScriptedConversationRuntimeSession implements ConversationRuntimeSession {
  readonly receivedAudio: AudioFrame[] = [];
  readonly receivedText: string[] = [];
  readonly requestedResponses: string[] = [];
  readonly receivedToolResults: ToolResultEnvelope[] = [];
  interruptCount = 0;
  readonly interruptions: Array<AssistantPlaybackPosition | undefined> = [];
  closeCount = 0;

  private readonly eventQueue = new AsyncEventQueue<ConversationRuntimeEvent>();
  private closed = false;

  async sendText(text: string): Promise<void> {
    this.receivedText.push(text);
  }

  async requestResponse(instructions: string): Promise<void> {
    this.requestedResponses.push(instructions);
  }

  async sendAudio(frame: AudioFrame): Promise<void> {
    this.receivedAudio.push(frame);
  }

  async sendToolResult(result: ToolResultEnvelope, _options?: { requestResponse: boolean }): Promise<void> {
    this.receivedToolResults.push(result);
  }

  async interrupt(position?: AssistantPlaybackPosition): Promise<void> {
    this.interruptCount += 1;
    this.interruptions.push(position);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeCount += 1;
    this.eventQueue.end();
  }

  events(): AsyncIterable<ConversationRuntimeEvent> {
    return this.eventQueue;
  }

  emit(event: ConversationRuntimeEvent): void {
    if (this.closed) throw new Error("Cannot emit an event after the scripted session is closed");
    this.eventQueue.push(event);
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) throw new Error("Cannot push to a closed event queue");
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}
