const endedCallIds = new Set<string>();

/** Record that this call will not accept a new booking side effect. */
export const markCallEnded = (callId: string): void => {
  if (callId) endedCallIds.add(callId);
};

export const isCallEnded = (callId: string): boolean => endedCallIds.has(callId);

/** Test isolation. Production processes drop this state when they exit. */
export const resetCallLiveness = (): void => {
  endedCallIds.clear();
};
