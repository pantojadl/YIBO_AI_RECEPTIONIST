# REL-002 — final software-roadmap closure audit

Date: **2026-09-20**. Audited implementation:
`506228ad4af638f5319acf5ecf462ecc068b52c2` on
`codex/integrate-telephony-and-finish`.

**Outcome: software roadmap complete through REL-002.** This is an automated
implementation/documentation checkpoint, not deployment approval or proof of a
successful live phone call. ACCEPT-001 and DEPLOY-001 remain open below.
This final audit changes documentation only. No service, database, live calendar,
original phone checkout or main branch was changed.

## Business-test follow-up — 2026-09-22

A focused re-audit found and fixed a route-deactivation bypass in the existing guard.
Latest checkpoint: 482 passed, one optional live skip; both typechecks/build passed.
Software-roadmap closure does not mean the current environment is ready for a real
call: Google authorization and a dedicated test route remain blocked. Concurrent
appointment edits and secretary ID-based lookup now have explicit follow-up owners.
See [business-test readiness](BUSINESS_TEST_READINESS.md) for scope and manual checks.

## Closure rule and result

The handoff requires no contradictory current documentation, unowned open tasks,
or hardcoded controls explicitly promised as configurable. Provider-boundary fakes
are allowed. The two implementation gaps found in the initial audit were resolved
in separate commits; dated historical evidence is labeled and current status is
reconciled. Remaining operational gates have an explicit owner and acceptance scope.

## Verified evidence

| Area | Repository evidence / conclusion |
|---|---|
| Preservation and ancestry | Integration descends from `1ff998b`; `INTEGRATION_INVENTORY.md` records the three-source audit and preservation. Local backup refs remain present; original phone checkout remains on `codex/asterisk-development-phone`. No history rewrite or blind legacy merge. |
| Modern PBX/media integration | `2147800`, `75990b8`, `84ff2c5`: bounded ARI controls, PCMU/RTP conversion/pacing, media backpressure, trusted DID routing and modern Calls/Conversation ownership. `b87eeb0` records the green baseline before UI resumed. |
| Latency reconciliation | `51959c7`, `75a7279`: serialized response requests/tool output and bounded SDK startup. Provider settings remain canonical configuration; no global latency defaults changed and no live p50/p95 improvement is claimed. OBS-001 adds privacy-filtered measurements. |
| Intentionally omitted legacy behavior | Old standalone VoiceBridge, duplicate provider payload/settings, caller-number diagnostic bypasses and obsolete dashboard replacement remain omitted. The useful behavior uses modern contracts; natural completion now uses ADR-008. |
| UI sequence | UI-004 `f1f1bce`, UI-005 `aeb02e9`, UI-006 `0bc05ec`, UI-007 `5a29b64`, UI-008 `780121b`, UI-009 `6c1b9d2`, in order with separate commits and status updates. |
| Configurable controls | Agent defaults/upgrader v4 → definition/prompt/policies → validated Realtime payload; dashboard exposes model/audio/VAD, behavior, silence, tools/channel/confirmation/retry/escalation controls. Location/catalog/calendar editors expose existing policy, price and assignment models. |
| Intentional constants | PCM16 24 kHz, PCMU 8 kHz, RTP pacing, bounded startup/tool/cleanup/end-playback deadlines and confirmation-token TTL are internal transport/safety contracts. No competing provider setting override was found in the inspected modern path. |
| Security and observability | SEC-001 `4032f45`, OBS-001 `641db35`: authenticated/CAS administration, scoped tools/confirmation state and redacted correlation/latency metrics. Existing regressions pass. |
| Booking and operations E2E | `b6c5065`, `ac977cd`: two locations, booking confirmation, pricing/timezone, Google identity/ownership/etag, listing/reschedule/cancel, transfer, outages, competing slots and PBX/media failures. Real modules, simulated provider boundaries. |
| CLOSE-001 | `f0822b9`, ADR-008: session-only end_call, final response/audio/local drain, partial RTP flush, interruption cancellation, bounded completion and no extra response request. Live model compliance/acoustic playback remains ACCEPT-001. |
| CLOSE-002 | `506228a`, ADR-009: configuration persistence atomically rejects effective route changes referenced by non-cancelled appointments. Historical/pending/failed rows, override/fallback, versioning, repeated reschedules, cancel and new bookings covered. No implicit event migration. |
| Migration | REL-001 `12fb732` rehearsed local MX/US copies from SQLite schema 4 to 9 with integrity, preservation, idempotence and restore checks. Sources had no appointments/customers. Current schema stays 9, business schema v2 and agent defaults/schema v4; closure fixes add no migration. |
| Commit discipline | Integration and subsequent roadmap commits each include `docs/PROJECT_STATUS.md`; closure fixes include decisions, code and tests. Final REL-002 is a separate documentation commit. |

## Final validation

Fresh checkpoint against `506228a`, 2026-09-20:

- Full suite: **477 passed, 1 optional live test skipped**, 75 passing test files.
- Backend: `tsc --noEmit` passed.
- Dashboard: `vue-tsc --noEmit -p dashboard/tsconfig.json` passed.
- Production: `vite build --config dashboard/vite.config.ts` passed.
- Local documentation links, diff whitespace and outgoing secret/sensitive-file
  checks passed before committing this audit.

Installed package executables were used directly (the same commands as package
scripts); no dependency changes. UDP tests used local sockets. No live API writes,
provider connections or deployment restart were used for acceptance evidence.

## Remaining gates with explicit ownership

Owners are functional roles; no person has been contacted or assigned in an external
service. These gates do not reopen completed software tasks, but must be completed
before claiming production readiness.

### ACCEPT-001 — OPEN; owner: deployment operator with test PBX/carrier/Google access

Use synthetic contacts and a test calendar. Run the scenarios in
[voice booking](VOICE_BOOKING_E2E.md), [phone operations](PHONE_OPERATIONS_E2E.md),
[call completion](CALL_COMPLETION.md) and [booked routes](BOOKED_CALENDAR_ROUTES.md).
Record actual spoken confirmation/local time, one farewell then clean hangup,
interruption continuation, transfer, original event identity and resource cleanup.
Check browser roles, retained drafts, two-tab conflicts and unsaved-change warnings.
Automated results do not prove live credentials, intelligibility, network reachability
or remote acoustic playback.

### DEPLOY-001 — OPEN; owner: deployment operator responsible for the target host/data

Identify the intended target database and host. Take durable protected backups with
required keys; provision admins and a stable session key; verify Google settings,
HTTPS/session behavior and PBX-only ARI/RTP networking. Rehearse separately if target
data differs from the local sources. Follow [operations](OPERATIONS_RUNBOOK.md) and
[migration/recovery](MIGRATION_RECOVERY.md). Private temporary rehearsal artifacts are
not durable backups. Current concurrency evidence covers one application instance.

Previously changed calendar mappings or uncertain external writes require staff
reconciliation. Failed and old confirmed bookings deliberately protect their routes;
do not delete rows or bypass validation to force a mapping change. Bulk event movement
needs a separately designed migration workflow, not implicit event recreation.

## Initial audit history

The 2026-09-19 audit at `12fb732` found roadmap closure incomplete and reopened
E2E-002. It identified final-playback/intentional-end behavior (CLOSE-001) and safe
handling of route changes with existing bookings (CLOSE-002). At that point the
latest full baseline was 443 passing tests and one optional live skip; the audit's
43 focused tests and both typechecks/build passed. These findings were retained as
owned tasks rather than hidden beneath DONE statuses. CLOSE-001 and CLOSE-002 are
now complete; E2E-002 and REL-002 are closed for software scope.

**Next:** operator-owned ACCEPT-001 and DEPLOY-001 planning/execution on the intended
test/deployment environment. Do not merge to main or restart the working phone
service merely because this software audit passed.
