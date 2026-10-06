# ADR-008 — intentional phone-call completion

Status: accepted for CLOSE-001, 2026-09-19. Extends ADR-001 lifecycle ownership.

Conversation owns a session-only `end_call` capability, separate from business tools
and persisted agent configuration. It is offered only on phone sessions whose audio
sink reports playback idle, with tool choice enabled and parallel calls disabled.
It cannot mutate business data or choose a call identifier. Voice Lab is unchanged.

The model speaks its final farewell and then requests end_call with an empty object.
Conversation requires audio from the current response, no pending tools and no
uncertain mutation. The successful function result is acknowledged without scheduling
another response. Closing waits for successful completion of that response, its
matching audio-completed event and local playback drain, plus one RTP packet tail.
An optional sink finishAudio hook pads only the last partial RTP packet of an
accepted end request; ordinary streaming and interruption remain unchanged.
These conditions are independent: audio drain can occur before model completion.
Caller speech/text/interruption cancels the pending end; ordinary response completion
never ends a call. Duplicate function delivery is ignored. Missing completion/drain
signals have a bounded deadline and fail the session rather than wait indefinitely.

A successful function result means ending was accepted, not that a booking succeeded.
Existing booking confirmation rules still apply. Calls observes Conversation's
completion and performs normal ARI hangup/cleanup. The RTP tail is an estimate after
local send, not proof of remote acoustic playback; live PBX acceptance remains needed.

This avoids provider-specific end-call commands, goodbye transcript matching, closing
on every response.done, adding lifecycle authority to Appointments, or enabling a
business mutation after end has been requested. Hard deadlines are safety bounds,
not duplicate provider controls. Tests must cover early/late drain, interruptions,
pending/uncertain tools, duplicate events, provider response failure, caller hangup,
and no extra response.create after a successful end acknowledgment.

## Amendment — Product/UX Checkpoint B, 2026-09-23

The browser harness now implements the playback-idle/finishAudio contract. Voice Lab
sessions with enabled, serial tools reuse this completion capability, including the
Realtime payload eligibility check. The browser acknowledges a matching finish request
only after its playback queue drains; terminal events and manual stop share one
idempotent test finalizer. No change is made to the phone condition, business mutations,
ARI/RTP behavior or routing. See [Checkpoint B](../PRODUCT_UX_CHECKPOINT_B.md).
