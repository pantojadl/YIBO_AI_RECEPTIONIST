# CLOSE-001 — intentional call completion

## Behavior

Phone conversations with tools enabled, serial tool calls and a playback-idle-capable
transport now receive an `end_call` session capability. It is not an appointment
mutation or a persisted/admin tool. Product/UX Checkpoint B extends the same capability
to Voice Lab with a browser playback-idle signal. Transports without playback signals
remain unchanged; the validated payload still requires an eligible serial audio session.
See [Checkpoint B](PRODUCT_UX_CHECKPOINT_B.md) for the browser lifecycle and validation.
See [ADR-008](adr/ADR-008-intentional-call-completion.md).

YIBO is instructed to finish the requested work, report its actual outcome, speak a
brief final farewell and request end_call. The backend requires an empty argument
object and matching farewell audio before closure. Pending tool work or
an uncertain mutation blocks the request. A known booking failure can be explained
and followed by a farewell; end-call success does not mean booking success.

When current-response farewell audio exists, the accepted function result is sent
without requesting another Realtime response. A function-only end request returns
`farewellRequired` and requests exactly one following response. Only that response's
audio can finish the pending end; a repeated request does not request extra speech.
The session waits for all of: result acknowledgment, successful response completion,
matching audio completion and playback idle. A final partial RTP packet is padded
with PCMU silence, then sent before closure. A 20 ms packet tail follows local drain.
A 45-second final-completion deadline fails/cleans up rather than hanging forever.

Caller speech, text or interruption cancels pending hangup. Another business tool or
unexpected new response also invalidates the old ending. A failed final response
emits a non-retryable runtime error and closes the failed test instead of waiting for
another caller turn. Ordinary response completion does not
hang up. Duplicate tool deliveries are ignored; repeated end requests do not schedule
extra speech. Unsolicited responses while ending are cancelled; caller speech resumes
normal response behavior. Calls handles the final ARI hangup and resource cleanup.

## Isolated Voice Lab follow-up — 2026-09-24

Real synthetic audio exposed function-only `end_call` responses before farewell
audio. Requiring both in the same response rejected the request; a later farewell
could then leave the test open. The bounded following-response path above addresses
that ordering, which is permitted by the
[Realtime function-calling contract](https://developers.openai.com/api/docs/guides/realtime-conversations#function-calling).
No transcript matching or business-action success inference was introduced.

Focused regression coverage includes both eligible channels, matching browser drain,
duplicates, caller/tool/response interruption, missing audio, provider failure and
failed-test labeling. Four subsequent real-model synthetic conversations ended
automatically after one farewell and matching playback acknowledgment. One earlier
provider response failed; the provider's underlying cause was not established.
This verifies the local audio protocol, not physical speakers or PBX cleanup.
No live phone configuration or service was changed.

## Verification — 2026-09-19

- 22 new tests cover lifecycle ordering, packet-tail delay, ordinary conversation,
  unsupported sessions, hostile arguments, repeated requests, caller interruption,
  pending/uncertain bookings, known failures, slow acknowledgment, cancelled response,
  deadline, caller hangup, and no extra Realtime response after end acknowledgment.
- Both location scenarios in the integrated Google-booking test now end intentionally
  after a partial final RTP packet, verifying COMPLETED state and resource cleanup.
- Full suite: 465 passed, one optional live test skipped. Both typechecks and production
  build passed. Google routing, reschedule/cancel and existing phone tests remain green.

## Real-call acceptance still required

No real OpenAI/Google/carrier call was made in CLOSE-001. Later isolated OpenAI audio
acceptance is described above; carrier acceptance remains pending. The model must follow the farewell/tool
instruction; a local UDP drain plus packet-tail delay cannot prove remote acoustic
playback. Provider/buffering behavior must be checked in the intended test deployment.

Use synthetic contact details and a test calendar. Book a time, listen for the actual
confirmation, then say “That is all, thank you.” YIBO should finish the farewell and
hang up once, with no second question. In a separate call, interrupt the farewell
with another request; the conversation should continue. Check the final event/time,
call state and ARI bridge/External Media cleanup. Do not deploy/restart the working
phone service merely to perform the automated checks.

CLOSE-002 subsequently added guarded mapping changes; see `BOOKED_CALENDAR_ROUTES.md`.
REL-002 software audit is complete; production acceptance remains separately tracked.
