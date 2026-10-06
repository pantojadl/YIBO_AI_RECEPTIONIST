# CLOSE-002 — protect existing booking calendar routes

## Root cause and reproduction

Appointments retain a Google event ID, while mutation routing uses the current
location/professional mapping. Before this fix, create on calendar A, change its
mapping to B, then reschedule/cancel would look for A's event ID in B. Typically this
returns not found and leaves A's event untouched. Existing ownership/etag checks
reject an unrelated event; they cannot prove that a matching copied event in B is
the original in A. No automatic migration existed.

A controlled run disabling only the new guard reproduced five failing regression
cases (three unaffected cases passed). Restoring the guard made all eight pass.

## Fix

[ADR-009](adr/ADR-009-protect-booked-calendar-routes.md) selects a guarded mapping
policy. Configuration persistence rejects effective calendar-ID changes for every
location/professional referenced by a non-cancelled appointment. This covers old
rows without snapshots, confirmed past appointments, pending creation and uncertain
failed bookings. No schema migration or provider behavior changes are needed.

The check is atomic with the configuration write: SQLite BEGIN IMMEDIATE and a
synchronous reference read/save for in-memory repositories. Pending rows already
exist before provider creation. All application configuration-save paths share the
guard, including whole-document replacement and legacy/unversioned repository saves.
Custom repository implementations must uphold this same persistence contract.

Professional overrides still win. An unused fallback may change; replacing an
override with the same effective fallback is allowed. Unrelated tenant/location/
professional references do not block a save. A version conflict takes precedence.
API rejection is HTTP 409 `CALENDAR_ROUTE_IN_USE`, with no configuration version
increment or success audit. The calendar editor retains the draft and explains why.

The 2026-09-22 closure follow-up also blocks disabling a currently accessible
business/location/professional assignment used by protected bookings, even when its
calendar ID is unchanged. Restoring an already-disabled route with the same ID is
allowed. This closes a full-document configuration bypass; see `BUSINESS_TEST_READINESS.md`.

Reschedule/cancel continue using the original unchanged route and existing event ID.
After all affected bookings are cancelled, the route can change and new bookings
use the new calendar. No events are implicitly moved, copied, recreated or deleted.

## Verification — 2026-09-20

- 12 new regression tests: eight API/domain guard cases, one SQLite fixture covering
  both write paths/statuses/isolation/versioning, one editor case, and two phone E2Es.
- Focused API/SQLite/editor run: 28 passed. New phone cases passed; an initial combined
  run found shared test RTP ports, fixed by assigning a separate range to the new file.
- Full final suite: **477 passed, one optional live test skipped**, 75 passing files.
- Backend typecheck, dashboard typecheck and production build passed.
- Phone E2E: several events, rejected route change, correct booking rescheduled twice,
  neighboring event unchanged, original persisted ID retained, cancel, route change,
  new booking on the new calendar. Exactly three creation POSTs for three bookings;
  no extra events. Another case holds Google creation in flight while rejecting reroute.
- Existing Google ownership/etag, tenant/auth, phone/media and conversation tests pass.

## Manual acceptance and limits

On a test calendar, create a synthetic booking. Try another calendar mapping: expect
an explanatory failed save and retained draft. Reschedule and cancel the booking;
verify the original event changed and then disappeared. Once no protected references
remain, change mapping and create a new booking; verify it appears only in the new
calendar. Real Google/browser acceptance was not performed automatically.

This prevents future mapping edits from stranding bookings. It cannot reconstruct
routes changed before deployment or repair existing orphaned/uncertain events.
Failed or old confirmed rows deliberately continue blocking affected route changes;
staff must reconcile them, not delete rows to bypass protection. Bulk event migration
requires a separately designed workflow. No live data/services were changed.

REL-002 final software audit is complete; see `RELEASE_CLOSURE_AUDIT.md`.
Operator-owned live acceptance and deployment readiness remain separate gates.
