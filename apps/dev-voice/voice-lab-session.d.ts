export type TestPhase = "connecting" | "ready" | "starting" | "active" | "completed" | "error";
export interface VoiceLabSnapshot {
  phase: TestPhase;
  connected: boolean;
  microphoneActive: boolean;
  speaking: boolean;
  aiConnected: boolean;
  testNumber: number;
  callId?: string;
  configuration?: Record<string, unknown>;
  completionReason?: string;
}
export interface VoiceLabOptions {
  url: string;
  onState(snapshot: VoiceLabSnapshot): void;
  onActivity(event: Record<string, unknown>): void;
  blockReason?(configuration: Record<string, unknown> | undefined): string | undefined;
  createSocket?(url: string): WebSocket;
  createAudioContext?(): AudioContext;
  getUserMedia?(): Promise<MediaStream>;
}
/** One browser test at a time; completed history belongs to the caller, not the transport. */
export class VoiceLabSession {
  constructor(options: VoiceLabOptions);
  connect(): Promise<void>;
  startMicrophone(): Promise<void>;
  pauseMicrophone(): void;
  sendFixture(file: Pick<File, "name" | "arrayBuffer">): Promise<void>;
  interrupt(): void;
  finish(): void;
  dispose(): void;
}
