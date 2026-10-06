/** How long a hangup keeps blocking a reused call id. */
export const CALL_ENDED_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Shared record of calls that must not accept another booking side effect.
 * Production installs a database-backed store so every instance agrees.
 */
export interface CallLivenessStore {
  markEnded(callId: string, endedAtMs: number, ttlMs: number): void;
  isEnded(callId: string, nowMs: number): boolean;
  /** Holds the hangup decision while a tool that already started is still running. */
  pin(callId: string): void;
  unpin(callId: string): void;
  reset(): void;
}

export class MemoryCallLivenessStore implements CallLivenessStore {
  private readonly calls = new Map<string, { endedAt: number; expires: number; inFlight: number }>();

  markEnded(callId: string, endedAtMs: number, ttlMs: number): void {
    if (!callId) return;
    const expires = endedAtMs + ttlMs;
    const current = this.calls.get(callId);
    if (!current) {
      this.calls.set(callId, { endedAt: endedAtMs, expires, inFlight: 0 });
      return;
    }
    if (current.endedAt === 0 || expires > current.expires) {
      current.endedAt = endedAtMs;
      current.expires = expires;
    }
  }

  isEnded(callId: string, nowMs: number): boolean {
    const current = this.calls.get(callId);
    if (!current || (current.endedAt === 0 && current.expires === 0)) return false;
    if (current.expires > nowMs || current.inFlight > 0) return true;
    this.calls.delete(callId);
    return false;
  }

  pin(callId: string): void {
    if (!callId) return;
    const current = this.calls.get(callId) ?? { endedAt: 0, expires: 0, inFlight: 0 };
    current.inFlight += 1;
    this.calls.set(callId, current);
  }

  unpin(callId: string): void {
    const current = this.calls.get(callId);
    if (!current) return;
    current.inFlight = Math.max(0, current.inFlight - 1);
    if (current.inFlight === 0 && current.endedAt === 0) this.calls.delete(callId);
  }

  reset(): void {
    this.calls.clear();
  }
}

const defaultNow = (): number => Date.now();
let nowFn: () => number = defaultNow;
let ttlMs = CALL_ENDED_TTL_MS;
let store: CallLivenessStore = new MemoryCallLivenessStore();

export function configureCallLiveness(options: {
  store: CallLivenessStore;
  now?: () => number;
  ttlMs?: number;
}): void {
  store = options.store;
  nowFn = options.now ?? defaultNow;
  ttlMs = options.ttlMs ?? CALL_ENDED_TTL_MS;
}

/** Test isolation. Puts the process back on a private in-memory list. */
export function restoreDefaultCallLiveness(): void {
  store = new MemoryCallLivenessStore();
  nowFn = defaultNow;
  ttlMs = CALL_ENDED_TTL_MS;
}

/** Record that this call will not accept a new booking side effect. */
export const markCallEnded = (callId: string): void => {
  if (callId) store.markEnded(callId, nowFn(), ttlMs);
};

export const isCallEnded = (callId: string): boolean => (callId ? store.isEnded(callId, nowFn()) : false);

/** Keep an in-flight tool from outliving the hangup mark. */
export const pinCall = (callId: string): void => {
  if (callId) store.pin(callId);
};

export const unpinCall = (callId: string): void => {
  if (callId) store.unpin(callId);
};

/** Test isolation. Clears the active store without forgetting which store is installed. */
export const resetCallLiveness = (): void => {
  store.reset();
};
