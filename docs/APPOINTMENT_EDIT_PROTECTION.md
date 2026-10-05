# RISK-001 — appointment edit protection

Launch candidate, 26 September 2026. This extends the existing appointment service,
concurrency port and SQLite store. It does not change Calendar routing, event IDs,
OAuth, phone configuration, customer profiles or notification delivery behavior.

## Reproduced failure

Before this change, rescheduling loaded a whole appointment before entering a
process-local location guard. Cancellation and office outcomes did not acquire
that guard. Two API/voice processes also had separate guards.

Four deterministic tests failed against that implementation:

1. A reschedule PATCH succeeds, but its response is delayed. Cancellation deletes
   the event and saves `CANCELLED`. The reschedule then saves its old snapshot as
   `CONFIRMED`, leaving a confirmed local appointment with a deleted Google event.
2. An office outcome saved during rescheduling is overwritten by that old snapshot.
3. Two cancellations both reach the provider and append cancellation history.
4. Two queued reschedules both use the first snapshot, recording the wrong previous
   time in the second change's history.

These are reproduced controlled-provider failures, not evidence of an observed
production incident. Google's per-request etag checks do not order local saves.

## Fix and contracts

- Create, reschedule, cancel and outcome mutations share the existing location
  concurrency guard. A mutation re-reads its appointment **after** acquiring it.
- Configured applications use a committed SQLite claim keyed by region, tenant and
  location. API and voice processes sharing that database cannot mutate the same
  location concurrently. Other locations/tenants/regions remain independent. No
  SQL transaction is held open across a provider call.
- Migration 11 adds `appointments.version` (existing rows default to `1`) and the
  claim table. New bookings start at version `1`; confirmation/failure advances to
  `2`. Successful reschedules, cancellations and office outcomes increment once.
  Failed provider reschedules/cancellations leave the saved revision unchanged.
- Cancel/reschedule/outcome HTTP endpoints accept the existing quoted `If-Match`
  format, for example `If-Match: "2"`. All shipped appointment/office controls send
  the revision they displayed. Malformed headers return `400 INVALID_IF_MATCH`.
- Under the guard, a stale revision returns `409 APPOINTMENT_VERSION_CONFLICT`
  before any provider mutation. An occupied claim returns
  `409 APPOINTMENT_OPERATION_IN_PROGRESS`. This is a version check under the shared
  lock, not a separate conditional SQL repository API.
- Office and Product appointment screens explain the conflict, keep details visible
  and let the operator refresh/review before choosing an action again. No automatic
  mutation retry or forced save is introduced. Office disables duplicate submissions
  and filter changes while its mutation runs.
- Voice appointment references retain the revision returned by the last list.
  Stale references require a fresh list and caller review; a successful reschedule
  advances the cached revision. Conflict tool results explicitly forbid claiming
  success. Public tool argument schemas and customer ownership checks are unchanged.

The original external event ID remains attached through repeated reschedules and
cancellation. Provider errors do not manufacture a successful local update or a
replacement event. Existing Google ownership, etag and route guards remain in place.

## Recovery and rollout boundaries

Claims release in `finally` when the operation returns or throws. They deliberately
have **no automatic expiry**: stealing a claim while a slow provider request is
still active would reintroduce the race. A killed process therefore fails closed.

For a persistent busy error after a crash:

1. Inspect the exact database/region, tenant and location claim (`owner_id`,
   `owner_pid`, `acquired_at`). Age or PID reuse alone does not prove it is stale.
2. Under an approved maintenance window, stop or quiesce all appointment writers
   for that location and verify the owning operation cannot resume. Do not restart
   or interrupt the working phone service without approval.
3. Take a verified SQLite backup. Compare the local appointment and history with
   the original mapped Google event and neighboring events. A timeout/crash may
   occur after Google accepts the write. Reconcile any uncertain outcome first;
   do not blindly retry, recreate or delete an event.
4. Only after reconciliation, remove that single verified claim using all four
   identifiers: `region_id`, `tenant_id`, `location_id`, `owner_id`. For a prepared
   statement: `DELETE FROM appointment_operation_locks WHERE region_id = ? AND
   tenant_id = ? AND location_id = ? AND owner_id = ?`. Require exactly one deleted
   row; never clear the table or remove an active owner's claim.
5. Resume the approved writers, reload current appointment details and verify a
   controlled operation. Retain the incident/backup evidence without credentials
   or customer data in Git.

All writers sharing a regional database must upgrade together. Older processes
ignore the claim table and revisions; mixed-version rollout is unsupported. Back up
before migration and use the existing [migration recovery](MIGRATION_RECOVERY.md)
procedure for rollback. Reverting code alone is not a safe concurrency rollback.

Compatibility and remaining limits:

- Legacy HTTP clients may omit `If-Match`; their operations are serialized and
  re-read, but their stale user intent cannot be detected. Require revisions in
  any new integration. All shipped UIs and prepared voice references supply them.
- In-memory applications retain their existing process-local guard. Persistent
  protection requires the configured application and one shared SQLite database;
  separate database copies or independent writers to the same Google calendar are
  not coordinated by this claim.
- Google and SQLite are not one transaction. Ambiguous network/local-write failures
  still require reconciliation; there is no new automatic recovery worker.
- Same-location mutations serialize even for different professionals, preserving
  the existing capacity boundary. A slow provider/notification can temporarily
  block another operation at that location.

## Validation

15 new tests cover the four reproduced races; stale cancel/reschedule/outcome;
repeated changes and cancel with the original event; provider failures without
revision advance; prepared voice references; UI refresh/review without automatic
retry; and invalid/mismatched location requests.

The SQLite fixture uses two configured application connections and a real child
process, verifies claim isolation, exception release, fail-closed process death,
targeted recovery on its disposable database, revisions after reload, original
event identity, no extra creates and an unchanged neighbor. Synthetic MX/US schema
9 copies migrate through 11 twice, preserve old data with revision `1`, and reopen.

Final suite: **679 passed, 1 optional live OpenAI test skipped**, 90 passing files.
Both typechecks and the production build passed. Provider, ARI and RTP tests are
isolated fixtures; this does not pass the real Google or phone release gates.

Browser acceptance used the private launch API/dashboard on 3113/5381, synthetic
SQLite and an in-memory Calendar. Two tabs loaded the same booking. Office moved
09:00→10:00; the stale Office cancellation was rejected and Refresh showed 10:00.
Product details then held that revision while Office moved 10:00→11:00. Product's
stale cancellation was rejected, its reload control showed 11:00, and only an
explicit reviewed cancellation succeeded. The booking disappeared from active
appointments and its slot reopened; history contains one create, two reschedules
and one cancellation. No live account, phone route, email or microphone was used.
