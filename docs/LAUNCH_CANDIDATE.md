# Launch candidate — release gates

Plan: Alan's six-page `YIBO_Alan_Codex_Instructions.pdf`, read in full before
integration. This document records evidence for the combined candidate; older
branch acceptance does not automatically pass a new release gate.

## Latest update — 4 October 2026

The existing public dashboard at **https://yibo-ai-receptionist.28rc9ktmdp.workers.dev**
returns HTTPS 200; its HTML/CSS/JS match the launch build. Canonical `/index.html`
redirects to `/` without looping. The browser renders the login screen but reports
authentication unavailable: health/auth/business/readiness return **503
`API_PROXY_NOT_CONFIGURED`**. Browser navigation upgrades HTTP to HTTPS successfully;
raw non-HSTS clients receive HTTP 200 without a server-side redirect.
Public frontend delivery passes; hosted authentication/workflows and deployment
closure remain blocked. No live setting, provider or database was changed.
[Detailed public checks, exact dashboard origin and remaining work](DEPLOYMENT_CHECKPOINT.md).

## Repository preparation — 3 October 2026

The user reported that 7001 worked and authorized starting Checkpoint 6. The
approved Speex16 endpoint repair and its limits are recorded in
[phone acceptance evidence](LAUNCH_7001_SPEAKERPHONE_REPAIR.md). Detailed later-call
diagnostics and the remaining ACCEPT-001 variants are not claimed as passed.

Checkpoint 6 repository preparation is complete: Node supervision templates,
consistent regional backup/verify/new-directory restore, and an off-host backup
job/timer template. **34 focused tests, both typechecks and production build passed.**
Real synthetic SQLite restore and restored-owner API login passed; off-host upload
tests use a stub. The existing one-CPU/1-GiB Asterisk VPS was inspected read-only and
is not recommended for the additional launch workload. No host or Cloudflare
changes were made. Host selection, actual domains, remote storage/restore and hosted
acceptance remain open. See [Checkpoint 6](DEPLOYMENT_CHECKPOINT.md).

## Browser acceptance update — 30 September 2026

Resumed from a clean `2117c5d` worktree; no unfinished implementation changes or
merge remained. Supplementary synthetic browser acceptance passed for appointment
changes, settings persistence, customer history/notification records, roles,
professional availability, compact layouts and Voice Lab lifecycle/cost. **56
focused tests, both typechecks and production build passed.** No application fix
was needed. Native WAV picker automation remains unverified; real microphone and
phone/provider acceptance are not claimed. See
[the complete browser evidence and limits](LAUNCH_BROWSER_ACCEPTANCE.md).

Gates 1–4 below remain complete. At this browser checkpoint the next gate was
**5 / ACCEPT-001**. PBX readiness was not inspected by that checkpoint; subsequent
phone evidence and the user's authorization to prepare deployment are recorded above.

## 1. Integration checkpoint — complete, 25 September 2026

| Source | Verified remote commit |
|---|---|
| `codex/product-ux-improvements` (first parent) | `7078d49e8ad312f2f4ab797ee184d2e933818297` |
| `codex/yibo-business-operations` (second parent) | `785389f3c6aea89c2f4d26ec1a7b433669f6b668` |
| `codex/integrate-telephony-and-finish` (already in first parent) | `46ce7135a6e6118c14c387b103957868a672645e` |

Fetched and checked against GitHub before creating `codex/yibo-launch-candidate`
in its own worktree. Product/Operations divergence was 10/9 commits (one newer
Product commit than the PDF's snapshot). Both histories remain ancestors of the
merge; source branches, main, and the dirty working-phone checkout are preserved.
No environment files, credentials, customer databases, recordings, or live routes
were copied into this branch.

### Deliberate conflict resolutions

- **Navigation:** Office schedule remains the default operational view; Customers
  and Operations Team availability remain available. Accepted Product Availability
  and Appointments screens stay connected to their existing APIs. Read-only users
  cannot invoke either family's write controls or APIs.
- **Metadata/storage:** appointment location metadata supports both professional
  name contracts and service assignments. Both range queries remain; the Product
  calendar still includes inactive/historical records and enforces its 31-day
  limit. Operations outcomes, customer fields, history and delivery records use
  its additive migration 10 and existing services, with no duplicate subsystem.
- **Configuration:** both location editors' controls survive. Business/channel
  tools, Product location overrides, and Operations AI capabilities intersect;
  restrictions win. Price redaction applies to structured tool output as well as
  the prompt. Saved locale and phone readback survive the new contact gate.
- **Agent:** Operations confirmed-contact persistence and local time/professional
  feedback combine with Product success-only confirmation and function-first
  goodbye behavior. Existing email/profile hooks are reused.
- **Voice Lab:** retain the shared Product session controller, completion and
  playback-drain fixes. Cost reporting observes its lifecycle rather than creating
  another controller. Reset, duplicate completion and late usage have coverage.
- **Google:** preserve the verified events-scope access probe; merge Operations
  refresh/revocation and API-disabled diagnostics. Event routing, ID generation,
  OAuth configuration, stored tokens and provider settings are unchanged.
- **Small integration fixes:** the appointment timeline validates its location
  before returning notification records; legacy UI defaults are normalized before
  capturing the clean editor baseline; cancelled appointments and denied actions
  no longer expose inappropriate Office action buttons.

### Validation evidence

291 distinct focused tests passed across 22 files, including 18 new cases.
Coverage includes both admin API families, roles, tenant/location isolation,
customer history/outcomes, successful/failed/skipped notifications, two reschedules
and cancellation with the original event ID, Google authorization/identity/routing,
agent restrictions/contact/locale/readback, Voice Lab lifecycle/cost, conversation
completion, ARI behavior and the existing scheduling service. One location-scope
notification leak was reproduced and fixed; stale/deduplicated cost events and
untouched legacy settings now have regression tests.

Both backend and dashboard typechecks and the production Vite build passed.
Synthetic v9 MX/US SQLite copies migrate to v10 twice, preserve all original data
and configuration, persist outcomes/events/deliveries and reopen successfully;
source fixture bytes remain unchanged.

Browser smoke test used a separate loopback API (3113) and dashboard (5381), private
synthetic SQLite, in-memory Calendar and no live email/Realtime/telephony providers:

- Office create → Customers directory/history → Product calendar/detail →
  reschedule → Office cancellation and timeline/notification status.
- Correct local date/time and professional in Product details; one booking across
  views; cancellation frees its slot. All email records are correctly `SKIPPED`.
- Office day/week/month/agenda controls, both availability screens, combined
  location controls and clean navigation after loading optional defaults.
- Compact 390 px Office and Settings layouts have no page overflow; visual review
  confirms usable controls. The synthetic appointment is left cancelled.

This is synthetic browser acceptance, not proof of real Google, microphone, phone
or email delivery. The existing Product acceptance browser/setup is untouched.

## 2. Full regression — complete, 25 September 2026

Integration commit `6b82aa9` is pushed on the dedicated launch branch. The full
suite passes **664 tests across 88 files**, with the existing optional live OpenAI
test explicitly skipped (no API key supplied). Both typechecks and the production
build pass. Coverage includes auth/roles/isolation, regional SQLite migrations,
scheduling/calendar identity/routing, customer/office operations and notifications,
configuration/runtime, conversation, Realtime adapter, ARI and local RTP teardown.

The sandbox-only run initially blocked loopback UDP (`EPERM`). Running the fake
PBX/media fixtures with local socket access resolved those environment failures.
Two older booked-calendar-route tests then exposed missing contact confirmation
in their scripts: they now assert the contact gate before using the same persisted
contact flow as callers. Their routing, neighbor-event, repeated-reschedule,
create-in-flight and cancellation assertions remain unchanged. No runtime
workaround or test exclusion was added.

The source feature branches remain `7078d49` and `785389f`; the launch merge's two
parents prove both histories are retained. `main` was neither checked out nor
modified. Next: appointment concurrency, before any multioperator business test.

## 3. RISK-001 — complete, 26 September 2026

Reproduced four races before the fix: delayed reschedule resurrecting a cancelled
local appointment, lost office outcome, duplicate cancellation and stale history
on queued reschedules. The existing appointment service now acquires its shared
location guard before re-reading and comparing the displayed revision. SQLite
migration 11 supplies persistent revisions and a claim shared by configured API
and voice processes. Shipped UIs and voice references provide the revision; stale
edits and competing writes return explicit conflicts before provider mutations.

15 new regressions include two configured database connections, a real child
process, crash recovery on disposable data, provider failure, repeated reschedules,
cancel, unchanged event identity and an untouched neighboring booking. Final suite:
**679 passed, 1 optional live-model test skipped** across 90 passing files. Both
typechecks and production build passed. Synthetic MX/US migration copies now cover
9→11, retained records/revision defaults, idempotence and reopening.

Two-tab synthetic browser acceptance passed in Office and Product Appointments:
stale cancellation rejected after each of two reschedules, explicit refresh/reload
revealed the current time, reviewed cancellation succeeded once and freed the slot.
No live providers or working services were involved.

Claims do not expire automatically: after process death an operator must reconcile
local/Google state before removing the exact abandoned claim. All database writers
must upgrade together. Legacy unversioned HTTP clients remain compatible but do not
gain stale-intent detection. See [contracts, evidence and recovery procedure](APPOINTMENT_EDIT_PROTECTION.md).

## 4. Real Google — complete, 26 September 2026

Code `3046c82` passed against the existing **YIBO Test Appointments** calendar using
a fresh private configured application/database. Existing authorization refreshed
successfully; no Calendar/OAuth settings or live token storage were changed.
Real availability → create two synthetic appointments → verify → reschedule the
primary twice → reject a stale cancellation → cancel → clean up the neighbor all
passed. The original event ID and correct clinic-local instants were retained;
no duplicates, all 15 pre-existing events unchanged, both test events removed from
active lists and both local records cancelled. All operation claims released.

[Real-provider evidence and isolation boundaries](LAUNCH_GOOGLE_ACCEPTANCE.md).
The next gate requires an approved isolated phone path and a human caller.

## 5. ACCEPT-001 preflight — blocked, updated 27 September 2026

The explicitly approved Tailscale reconnect succeeded without changing saved
settings. SSH/ARI access is restored. Read-only inspection reproduced an unreadable
`root:root 0640` dialplan and an inactive `pbx_config.so`. With separate explicit
approval, the file was backed up preserving metadata, its group alone changed to
`asterisk`, and the inactive module loaded once on September 27 at 18:21:53 UTC.
Contents, owner, mode and Asterisk PID are unchanged. Both contexts now match the
preserved September 23 snapshots: 7001 and the explicit public rules target normal
`yibo`. No routing edit or service restart occurred. Post-repair ARI reads returned
HTTP 200 with zero channels/bridges and no registered applications. A fresh private
standby API on 3114 now uses synthetic data and the copied verified test-calendar
grant; no ARI connection. UDP 50500–50509 binds locally without overlap. Health/auth
checks and 29 focused phone/ARI/media tests pass. The exact 7001 candidate and
rollback are prepared locally; separate route/activation approval and a real human
call remain required. No further PBX mutation or provider write occurred.
[Evidence and operator steps](LAUNCH_PHONE_PREFLIGHT.md).

## Ordered remaining gates

| Gate | State | Required evidence |
|---|---|---|
| 2 — Full regression | COMPLETE | 664 passed, 1 optional live-model test skipped; both typechecks and production build passed |
| 3 — RISK-001 | COMPLETE | Reproduced/fixed races; revisions and shared SQLite claims; stale UI/voice references, two processes, migration and recovery tests |
| 4 — Real Google | COMPLETE | Real availability/create/two reschedules/cancel/cleanup; same ID, exact local time, stale rejection, 15 existing events unchanged |
| 5 — ACCEPT-001 | USER-REPORTED CALL SUCCESS; DETAILS OPEN | Approved isolated repair followed by the user's 7001 success report. Detailed booking/transfer/failure/language/cleanup variants still need recorded manual evidence before pilot. |
| 6 — Deployment/restore | PUBLIC DASHBOARD VERIFIED; DEPLOYMENT OPEN | Assets, canonical redirect and browser HTTPS upgrade pass. API returns 503 configuration error; separate backend, off-host restore, monitoring and authenticated hosted acceptance remain required. |

The 27 September snapshot recorded 7001 targeting normal `yibo` after the approved
file-group repair and inactive-module load. It does not establish the route today.
No PBX/7001 changes or inspection were performed during the 30 September browser
checkpoint. Preserve the scope of existing approvals, and obtain explicit approval
for any new working-route change or merge to main. Real provider tests must use
isolated test resources and synthetic labels; never substitute a mocked result.

## Known limitations carried into later gates

- Shared-database writers must upgrade together. A crashed writer leaves its
  location blocked until an operator reconciles the outcome and clears that exact
  claim. Google/local writes are not one transaction; uncertain outcomes still need
  inspection. Legacy HTTP clients without `If-Match` cannot detect stale user intent.
- Office open-slot lists obey configured result limits; month/week views are not
  an exhaustive inventory of every free interval. Per-professional availability
  and Product date/time search remain available.
- Office quick booking acts on slot selection after a customer is chosen. Review
  this interaction with the office user during pilot acceptance.
- `staffOverrideAllowed` is stored metadata, without an implemented policy bypass.
  `afterHoursBehavior` guides the prompt rather than enforcing a domain boundary.
  Same-day booking is enforced at create time, not throughout all availability and
  reschedule paths. Do not advertise these as broader guarantees.
- Real email delivery, target-account OAuth, natural speech/microphone behavior and
  PBX routing require the later live gates; readiness metadata is not acceptance.
