# Model Configuration Pipeline — isolated Voice Lab acceptance

September 24, 2026, `codex/product-ux-improvements`. `1184fff` is unchanged.
Runtime/configuration acceptance passed; physical microphone, listening and browser
barge-in acceptance remain manual. This is not a new development checkpoint.

**User acceptance update — September 24, 2026:** the user accepted the remaining
manual Voice Lab checks for now and authorized Appointments Calendar UI. The
matrix below records what automation actually observed; this update does not
claim additional microphone/listening measurements.

## What actually ran

- Seven real `gpt-realtime-2.1` audio conversations through the existing Voice Lab
  WAV/WebSocket harness. Synthetic speech was generated locally, sent as audio, and
  real returned audio, final model transcripts, tool results and call states observed.
  Replies were not scripted. This driver did not use the browser microphone/speaker.
- Saved settings were changed through the existing authenticated, versioned APIs.
  The actual prepared agents and their unmodified tool results were observed.
  Additional direct calls against saved, prepared agents checked server-side denial
  and structured price filtering independently of model compliance.
- Private dashboard `http://product-acceptance.localhost:5380`, API 3112, voice 4318;
  synthetic SQLite data and local calendar adapter. No Google/OAuth, Asterisk,
  Telnyx, live routing or live-service configuration was present or changed.
  A private server-selected East called-number fixture exercised location routing.
- Synthetic transcripts, WAVs and diagnostics stayed in the private temporary
  acceptance directory outside Git. They contain no real caller/patient data.
  Transcript/tool-result capture was turned off before leaving the setup for manual use.

## Results

PASS below means the stated runtime observation passed, not a human listening sign-off.

| Scenario | Status | Evidence |
|---|---|---|
| 1. Price disclosure | PASS | Enabled: model said the configured $125.50 price. Disabled: refused pricing; structured service and appointment results contained no `price`. Booking still succeeded. |
| 2. Booking permission | PASS | Enabled: real model invoked `create_appointment`, then clearly confirmed Monday September 28, 2026, 10 AM America/Chicago. Disabled: said it could not book, made no booking, and forged tool calls returned `TOOL_DISABLED`. |
| 3. Rescheduling permission | PASS | Enabled: same synthetic appointment moved to Tuesday September 29, 11 AM America/Chicago; confirmation followed successful `reschedule_appointment`. Disabled: refused with no mutation or false confirmation; direct calls denied server-side. |
| 4. Cancellation permission | PASS | Enabled: model listed and cancelled that appointment, then stated cancellation. Disabled: refused without a mutation or success claim; direct calls denied server-side. |
| 5. Location overrides | PASS | East denied all three actions and prices while the default location retained them. East's explicit price permission could not override business denial; its empty disabled list could not grant business/channel-denied actions. Both direct execution and fresh spoken replies respected these restrictions. |
| 6. Language / locale | PASS | With business `es-MX` and East override `en-US`, the same English audio question received a Spanish price response at the default location and an English price refusal at East. |
| 7. Phone readback | MANUAL REQUIRED | Model audio transcripts and successful update results differed: grouped `+ 52, 999, 000, 0001` versus separate `+ 5 2 9 9 9 0 0 0 0 0 0 1`. Stored normalized phone remained `+529990000001`. A human must hear the cadence and intelligibility. |
| 8. Fresh configuration | PASS | Fresh call IDs picked up saved price/action/language/readback changes without restarting the application between those setting changes. Existing calls retained their prepared configuration. |
| 9. Session lifecycle | MANUAL REQUIRED | Four subsequent audio conversations produced one farewell, matching playback acknowledgment and one automatic close each. Fresh sessions worked; all seven calls ended with one closure. Browser restart/microphone release, audible clipping/barge-in and Recent Activity during microphone use still need a human. |

One appointment row was created in this acceptance, rescheduled and cancelled. Its
stored price remained 12550 USD minor units, with no active test appointment left.
This verifies local scheduling behavior only; live Google was deliberately unused.

## Bugs found and narrow corrections

### Voice completion and activity — `0994bf1`

1. The harness classified a tool's `started` event as `failed`. It now reports
   started/completed/failed distinctly, with readable dashboard labels.
2. The model emitted `end_call` in a function-only response before farewell audio.
   The previous same-response requirement rejected it; a later spoken goodbye
   could leave the session open. A valid function-only end now requests one following
   farewell response and waits for its matching completed audio and playback drain.
   Duplicates cannot request another farewell; caller activity, another business tool,
   unexpected response, pending/uncertain actions and the deadline retain their guards.
3. One live provider response failed during that following farewell. The old failure
   path silently cancelled the pending end. It now reports an error and cleans up a
   failed test. The underlying provider failure cause was not established; regression
   tests reproduce the observed response status rather than assuming its cause.

The first three exploratory conversations were closed manually, including the
provider-failure case. The following four closed automatically. These failures are
not counted as successful natural completions.

The [official Realtime function-calling documentation](https://developers.openai.com/api/docs/guides/realtime-conversations#function-calling)
describes function-only output followed by a response to the returned tool result.
The fix reuses that existing response path; no new provider or telephony architecture.

### Availability input and spoken timezone guidance — follow-up acceptance commit

An initial run retried invalid date inputs and read a UTC alternative as local time.
The existing tool description did not enumerate its supported date grammar, and the
prompt supplied the location timezone without explicitly requiring conversion of UTC
tool values for speech. A later observed invalid request supplied only
`requestedStartAt`, omitting the required date/range.

Descriptions now specify the existing required date/range and supported date forms;
the prompt requires local-time speech while retaining original tool timestamps.
No parser, availability algorithm, Calendar API, booking data or routing was changed.
The final explicit-date audio check succeeded on its first tool request. Successful
booking/rescheduling confirmations matched 15:00Z → 10 AM Chicago and 16:00Z → 11 AM
Chicago. Prompts improve guidance; spontaneous model wording is still probabilistic.

## Automated and browser checks

**127 focused checks passed**: 126 across the nine files below, plus the selected
adapter completion test. Twelve new cases were added; the old expectation rejecting
every end request without same-response audio was replaced by the guarded behavior.

```text
vitest run --silent \
  tests/agents/business-agent-policy.test.ts \
  tests/dashboard/business-agent-pipeline.test.ts \
  tests/dashboard/voice-lab-session.test.ts \
  tests/voice/dev-voice-harness.test.ts \
  tests/conversation/conversation-service.test.ts \
  tests/conversation/realtime-session-payload.test.ts \
  tests/agents/agent-prompt-compiler.test.ts \
  tests/calls/call-orchestrator.test.ts \
  tests/agents/natural-date-range.test.ts
vitest run --silent tests/conversation/openai-realtime-adapter.test.ts \
  -t 'acknowledges call end without another response'
tsc --noEmit
vue-tsc --noEmit -p dashboard/tsconfig.json
vite build --config dashboard/vite.config.ts
git diff --check
```

Both typechecks and production build passed. The adapter command deliberately
deselected 27 unrelated tests; no full repository suite ran. Runtime completion is
shared with Phone, so focused call-orchestrator/payload/adapter tests were included.

Browser: authenticated synthetic dashboard, saved-language/readback/rule controls,
Voice Lab readiness, disconnected-session completion/retry controls and retained
Recent Activity inspected. Reload restored the saved default configuration. No
microphone was enabled and no physical playback/interrupt result is claimed here.
Automated browser-session tests cover duplicate completion and late/stale media.

## Exact manual test state and script

Both configuration documents were restored and compared with the pre-acceptance
snapshot through the API. Default location: YIBO US Demo Clinic, America/Chicago,
agent `en-US`, prices allowed, all three appointment actions allowed, Natural / grouped
readback, wait for caller. Consultation is $125.50 / 30 minutes. The original East
`es-MX` locale override is restored. Capture is off; no active test calls remain.

Open the private dashboard above, **AI agent → Open saved-settings Voice Lab →
Start Voice Test**. Google-unavailable readiness is expected in this local setup.
Use only Taylor Example and the synthetic number below.

1. Say **“What is the price of a consultation?”** Expect $125.50, naturally spoken.
2. Say **“Please read back my callback number: plus five two, nine nine nine, zero
   zero zero, zero zero zero one. My name is Taylor Example.”** Expect grouped
   reading with every digit intact. If asked for details individually, use those same
   synthetic details.
3. Say **“That is all. Thank you and goodbye.”** Hear one complete farewell; the test
   should complete once and the browser microphone indicator should turn off.
   Immediately start another test and say **“Hello, what services do you offer?”**
   Check no stale audio, repeated opening or doubled microphone input. Inspect older
   Recent Activity entries and return to the latest ones.
4. End that test. In **AI agent → 03 Silence → Phone readback**, select **Digit by
   digit**, then **Save settings**. Start a fresh test and repeat step 2. Hear each
   country-code and phone digit separately. Restore **Natural / grouped** afterward.
5. For a spoken price-off/booking check: end the current test, use **04 Business
   rules → Tell callers service prices** off, then save. In a fresh test repeat the
   price question; expect refusal without revealing a number. Say **“Book a
   consultation on Monday September 28, 2026 at 10 AM Central time.”** Agree to the
   verified time; expect confirmation only after success, without a price.
6. Say **“Reschedule that appointment to Tuesday September 29, 2026 at 11 AM
   Central time.”** Then **“Please cancel that appointment.”** Expect each result
   only after its tool succeeds. This cleans up the manual test appointment.
7. In a separate goodbye test, interrupt YIBO with **“Actually, one more question.”**
   The test should stay open. Finish naturally, check microphone/audio cleanup and
   start another fresh test. Restore the price switch afterward.

If those dates have passed when testing, choose future open dates and state the
year/timezone. A failed provider request is not a successful voice acceptance; retain
its activity/error and use the enabled retry/start control for a fresh test.

## Files and scope

- Voice fix: `apps/dev-voice/harness.ts`, `dashboard/src/components/AgentVoiceLab.vue`,
  `src/modules/conversation/application/conversation-service.ts` and their two focused
  test files; `docs/CALL_COMPLETION.md`, `docs/PRODUCT_UX_CHECKPOINT_B.md`.
- Guidance: `src/modules/agents/application/agent-prompt-compiler.ts`,
  `tool-definitions.ts`; `tests/agents/agent-prompt-compiler.test.ts`,
  `natural-date-range.test.ts`.
- Acceptance documentation: this file, `docs/MODEL_CONFIGURATION_PIPELINE.md`,
  `docs/PROJECT_STATUS.md`.

No Customer Profiles or Email Notifications implementation was modified. Existing
customer tools were exercised with synthetic data only. Shared prompt/status files
may need normal conflict review when a future integrator combines teammate work.
No merge, main push, deployment, live phone/Calendar configuration or next checkpoint.

Recommended next development checkpoint after the manual checks: agree on the
Appointments Calendar UI scope with the teammate, preserving their profile and
notification ownership. Do not start it automatically.
