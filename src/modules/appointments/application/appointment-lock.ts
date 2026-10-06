import { AsyncLocalStorage } from "node:async_hooks";

/** How often a holder refreshes its lease. */
export const LOCK_HEARTBEAT_MS = 30_000;

/** A holder that misses this many heartbeats can be replaced. Age since acquire is not the rule. */
export const LOCK_LEASE_MS = LOCK_HEARTBEAT_MS * 3;

export interface AppointmentFence {
  ownerId: string;
  fence: number;
}

const fences = new AsyncLocalStorage<AppointmentFence>();

export function currentAppointmentFence(): AppointmentFence | undefined {
  return fences.getStore();
}

export function runWithAppointmentFence<T>(fence: AppointmentFence, operation: () => Promise<T>): Promise<T> {
  return fences.run(fence, operation);
}

/** Lease math uses one numeric clock. Heartbeat timestamps are unix milliseconds, never ISO strings. */
export function leaseIsExpired(heartbeatMs: number, nowMs: number, leaseMs: number): boolean {
  return !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs >= leaseMs;
}
