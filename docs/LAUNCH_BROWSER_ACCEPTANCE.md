# Launch candidate — synthetic browser acceptance

Completed 30 September 2026; checks began 29 September. This supplements the
ordered gates in [LAUNCH_CANDIDATE.md](LAUNCH_CANDIDATE.md), following Alan's
six-page launch PDF. It does not repeat or replace the completed integration,
full regression, appointment concurrency, or real Google gates.

## Repository state and scope

- The resumed launch worktree was **clean**, at `2117c5d0bb889a976d030a71e789720122be921e`.
  There were no uncommitted browser-smoke implementation edits to recover.
- Merge `6b82aa9` already retains Product/UX `7078d49` and Business Operations
  `785389f` as its two parents. Both source tips remain ancestors of the candidate;
  their remote tips and the launch remote were checked before acceptance.
- Existing concurrency fix `3046c82` and real Google evidence `a437ea2` remain
  unchanged. This checkpoint changes documentation only.
- Other worktrees and their unfinished edits were preserved. No main, Cloudflare,
  phone/7001, live Calendar/OAuth, production database, or teammate subsystem edits.

## Isolated setup

Reused the existing loopback Fastify API on **3113** and dashboard on **5381**
(`http://launch-acceptance.localhost:5381/`), with private synthetic SQLite,
in-memory Calendar, and no live email, Realtime, ARI, or telephony providers.
Existing acceptance processes and the Product/UX acceptance setup were preserved.
Synthetic owner, office-manager, secretary and read-only accounts exercised the
actual authentication and role checks. Credentials and evidence files stay outside
Git; no real customer records, tokens, recordings, or database files were added.

## Browser results

| Area | Result | Observed evidence |
|---|---|---|
| Create and reschedule | PASS | Secretary selected an existing synthetic customer and Dr. Alex, booked 30 September at 09:00 America/Chicago in Office, then moved that appointment to 1 October at 10:00 in Product Appointments. Both screens showed the correct time, service and professional. |
| Cancellation | PASS | Secretary cancelled that appointment in Office. Status became CANCELLED, further change/outcome actions disappeared, and its 10:00 slot became available again. |
| Event and record identity | PASS | Synthetic SQLite retained the same appointment and external Calendar event IDs across create/reschedule/cancel; revisions advanced 2 → 3 → 4. The original two synthetic appointments were unchanged; zero active appointments remained. This is an in-memory-provider check, not another real Google test. |
| Customer history | PASS | The existing customer showed three appointments, including the newly cancelled 1 October booking, the correct care team, and the two preserved historical bookings. No duplicate customer was created. |
| Notifications | PASS, synthetic | Timeline displayed CREATED, RESCHEDULED and CANCELLED, with corresponding confirmation/reschedule/cancellation email records marked SKIPPED and a masked recipient. No email was sent. Failed and skipped delivery cases are covered by focused integration tests. |
| Settings persistence | PASS | The combined location editor exposed scheduling, availability, Product AI overrides and Operations capabilities. Changed availability alternatives and search-ahead days, saved, reloaded and verified persistence, then restored the original values and saved again. |
| Agent/catalog/mappings | PASS | Agent identity and business rules, USD catalog headings, professional location/service assignments and inherited hours loaded correctly. Mapping screens showed the actual unconfigured synthetic routes and their protection warning; no mapping or provider configuration was changed. |
| Staff availability | PASS | Team availability returned separate Dr. Alex and Dr. Taylor results, each with 20 open times. Booking controls required a selected customer. |
| Roles | PASS | Owner and office manager could access configuration; secretary could manage appointments without configuration navigation; read-only could inspect customers/history without creation controls. Focused API tests also verify server-side denials across all six roles. |
| Compact layouts | PASS | Office, appointment detail, Settings, customer directory, team availability, catalog/professional assignments, mappings and Voice Lab were checked at 390 px without page-width overflow. Visual inspection confirmed usable professional and cost controls. Desktop navigation also passed. |
| Voice Lab lifecycle/cost | PASS, synthetic | Actual shared session controller and cost UI completed the two-session protocol test below, with no application console errors observed. |

## Voice Lab evidence and limits

A temporary loopback UI on **5382** served the unchanged launch dashboard with
only a private test transform redirecting its Voice Lab socket from **4317** to
the protocol fixture on **4319**. It never connected to the working 4317 service.
The fixture supplied synthetic usage and silent PCM audio; no OpenAI connection,
real microphone, speech recognition or spoken conversation was exercised.

The browser file-chooser tool failed during attachment with
`No node found for given backend id`, including in a fresh tab. There is no proven
application defect from that failure. Temporary fixture-only buttons therefore
passed generated silent WAV files to the same `VoiceLabSession.sendFixture`
method used by the file input. These controls were not added to repository source.
Native file-picker acceptance remains unverified; the lifecycle results below do
not claim that the picker passed.

- Test 1 reported 150 audio tokens, 1,200 text/context tokens and two tool calls:
  **$0.013128**, including the configured cached-token rates. Browser audio playback
  drained and acknowledged completion. The interruption control exchanged a
  playback-clear acknowledgement; natural spoken barge-in still requires a live test.
- Manual End Voice Test produced one completion entry and a FINAL cost/duration.
- Test 2 started on the **same page**, reset the first test's counters, and completed
  automatically. It showed 10 text tokens, zero audio/tool counts and **< US$0.0001**.
- A duplicate conversation-close event and late usage of 999,999 tokens did not
  duplicate completion or inflate the final result. Each test had exactly one
  start and completion; End Voice Test was disabled afterward.
- Recent Activity retained both sessions. Keyboard scrolling revealed earlier
  entries and **Show latest** returned to the newest entries.
- The compact cost panel fit 390 px. All fixture connections closed, with zero
  microphone starts. Navigation disposed the UI, then only the temporary 5382/4319
  processes and helper tabs were stopped. The original 3113/5381 setup remains.

Real microphone permission/restart, audible speech quality and provider billing
remain manual/live checks. Existing focused session tests cover fake-microphone
resource cleanup; silent playback is not a substitute for hearing a real call.

## Validation

**56/56 focused tests in eight files passed** on 29 September:

```text
tests/integration/launch-office-integration.test.ts
tests/integration/auth-api.test.ts
tests/dashboard/voice-lab-session.test.ts
tests/dashboard/realtime-cost.test.ts
tests/dashboard/agent-policy-controls.test.ts
tests/appointments/appointment-concurrency.test.ts
tests/integrations/sqlite-appointment-concurrency.test.ts
tests/integrations/sqlite-launch-migration.test.ts
```

Backend `tsc --noEmit`, dashboard `vue-tsc --noEmit -p dashboard/tsconfig.json`,
and production Vite build all passed. Dependencies were restored from the offline
cache with a frozen lockfile; manifests and lockfile were unchanged. No code changed
after those checks. The completed **679 passed / one optional live test skipped**
full regression remains historical evidence, not a newly repeated run.

No new application regression or concurrency defect was found. Existing limits
still apply: all SQLite writers must upgrade together; crashed operation claims
need operator reconciliation; Google/local writes are not one transaction; legacy
clients without revisions cannot detect stale intent. See
[appointment edit protection](APPOINTMENT_EDIT_PROTECTION.md).

## Exact next release gate

**Subsequent update, October 3:** the user has reported 7001 success and authorized
Checkpoint 6 preparation. See [current deployment work](DEPLOYMENT_CHECKPOINT.md)
and [the limits of the phone evidence](LAUNCH_7001_SPEAKERPHONE_REPAIR.md). The
paragraphs below preserve the September 30 checkpoint's boundary.

**PDF checkpoint 5 — Live Phone Acceptance (ACCEPT-001).** Use synthetic data and
a freshly verified, approved isolated phone path with a human caller. Verify the
correct location, natural turns/interruption, contact capture, availability,
booking and one clear confirmation, Calendar consistency, enabled email delivery,
reschedule/cancel restrictions, human transfer, goodbye and clean/early hangup.
Exercise both English and Spanish if offered.

This checkpoint made no PBX inspection or routing change and does not certify
the current 7001 destination or readiness. Earlier phone documents are dated
snapshots. Stop here for the real caller and any separately needed routing approval;
do not skip ahead to PDF checkpoint 6 (deployment/backups/restore) or pilot onboarding.
