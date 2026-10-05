# REL-002 follow-up — readiness for a real business test

## Launch candidate update — 26 September 2026

The September 22 audit below is historical. The combined launch candidate now
includes the Office/Customers and Product appointment calendar workflows with
isolated synthetic browser acceptance. RISK-001 is reproduced and fixed with
appointment revisions, a shared SQLite location guard and stale UI/voice rejection;
679 tests pass, one optional live test is skipped, both typechecks/build pass.
See [release gates](LAUNCH_CANDIDATE.md) and [conflict/recovery details](APPOINTMENT_EDIT_PROTECTION.md).
The earlier ID-only workflow and missing concurrency protection are not the current
candidate's state. Staff acceptance and the real Google/phone release gates remain
separate; prior authorization history does not certify this combined candidate.
7001 remains rolled back; no live routing or OAuth configuration was changed here.

## Historical audit

Date: 2026-09-22. Baseline `ea3ef50`, plus the small route-activation guard fix
in this audit. Scope: repository evidence and targeted closure review, not a new
live acceptance run. **Not yet ready to start a real end-to-end call in the current
test environment.** The software is a candidate for a controlled synthetic trial
after the access/routing blockers below are resolved; this is not office rollout approval.

## READY — automated evidence

- Incoming ARI call → trusted DID/tenant/location → agent configuration → Conversation
  → appointment tools → routed Google adapter → result → final audio drain → hangup
  is covered through real application modules with simulated provider boundaries.
- Booking confirmation instructions prohibit success before the tool succeeds;
  pending/failing Google cases, confirmation sequencing and completion are covered.
  Scripted E2E does not establish the wording or behavior of a live model.
- Sequential reschedules PATCH the original Google event, retain its ID, check
  ownership/etag, and cancel that event. Multiple neighboring appointments and
  no-extra-insert regressions pass. No implicit move/delete/recreate is introduced.
- Calendar-ID changes that would strand non-cancelled bookings are guarded atomically
  in SQLite. Historical, pending and failed bookings are included. This audit also
  closes the activation bypass described below.
- Admin UI exposes locations/DIDs/timezones/hours/closures, booking policies,
  service descriptions/durations/prices, professional/service/location assignments,
  provider hours, calendar mappings, agent policies and transfer destinations.
  Role/tenant controls, validation, version conflicts and retained drafts are tested.
- Appointment UI shows scoped status, local time and historical service/price, and
  supports lookup/list/reschedule/cancel through the existing domain service.

## Small closure fix

The route guard compared IDs but did not account for the resolver rejecting an
inactive business/location/professional assignment. A full configuration save could
therefore preserve the ID while disabling access to existing bookings. Three valid
configuration regression cases failed before the fix. The same persistence guard
now rejects a transition from accessible to inaccessible for referenced routes.
Uncancelled references still use ADR-009's policy and existing error contract.
Reactivation with the same ID remains allowed; cancellation releases protection.
No schema, provider, Realtime or telephony change was needed.

Five new tests cover business/location/assignment deactivation, safe deactivation
after cancellation and restoration of an already-disabled route. The SQLite fixture
also checks both versioned and unversioned writes. Initial focused run: 38 passed;
after the final restoration case, one complete checkpoint: **482 passed, 1 optional
live skipped**, 75 passing files. Both typechecks and production build passed.

## NOT YET VERIFIED / remaining gates

| Gate | Evidence and next step | Owner |
|---|---|---|
| Google test authorization | Updated September 22: stale isolated grant rejected; newer original grant refreshed successfully and restored only to isolated storage. Scope-compatible access probe now reports accessible; 13 focused tests pass. Cloud MFA and registering the additional port-3101 callback remain necessary for fresh authorization. Real writes remain unverified. See [diagnosis](GOOGLE_AUTH_DIAGNOSIS.md). | Operator / Google account owner |
| Dedicated test phone path | Isolated API/dashboard were started with telephony disabled. No dedicated test DID/extension or reachable test RTP path was established. Live routing changes still require explicit user approval. | PBX/carrier operator |
| Natural speech and timing | No real phone call has yet established sufficient answer time, no repeated questions, accurate confirmation, graceful interruptions, intelligibility or complete goodbye playback. | Operator/caller, ACCEPT-001 |
| Real Google operations | No live acceptance booking/reschedule/cancel sequence has run against the new branch. Provider fakes do not establish current write permission, authorization or network reliability. | Operator, ACCEPT-001 |
| Browser office use | Auth/API/editor tests are not manual browser acceptance. Validate roles, location selection, local-time display, drafts and two-tab conflicts, and whether staff can actually find their appointments. | Secretary/admin tester |
| Target rollout | Durable backups/keys, actual deployment data, admin provisioning, network restrictions and single-instance operating plan remain necessary. | Deployment operator, DEPLOY-001 |

## Known risks and partial coverage

1. **Concurrent appointment edits (RISK-001).** Appointment records have no version/CAS.
   Rescheduling reads the appointment before entering a process-local location guard;
   cancellation does not acquire that guard. Google etags protect individual provider
   writes, not ordering of local saves. For example, a successful PATCH response delayed
   locally while a cancellation deletes that event can allow a later local CONFIRMED
   save after cancellation. This is a code-review risk, not a reproduced live incident.
   Do not permit competing operators/instances to edit the same booking in the first
   trial. **Owner: Appointments implementation; address serialization/re-read/conditional
   persistence before multi-operator trials.** No broad concurrency redesign in this audit.
2. **Ambiguous external outcomes.** Google may accept a write before the network or local
   save fails. There is no distributed transaction or automatic reconciliation worker.
   Timeout is not proof of failure; inspect the actual event before retrying. Failed and
   past confirmed rows intentionally retain route protection. Previously stranded
   bookings cannot be reconstructed automatically. **Owner: operator for reconciliation;
   Appointments implementation for any future recovery workflow.**
3. **Secretary workflow (RISK-002).** Lookup requires customer/appointment IDs; details
   use customer/professional identifiers. There is no general customer directory,
   name/phone search or full daily agenda in this workflow. Core settings are exposed,
   but suitability for routine office work is not established. **Owner: product/office
   operator; assess with staff before proposing a separate UI task.**
4. **Development substitutes are intentional.** Scripted runtime and in-memory calendar
   are available; missing Google configuration can select the in-memory adapter.
   An HTTP health response and a stored-token `connected` flag are not provider proof.
   Confirm real runtime and actual calendar read/write on the isolated instance.
5. **Completion conditions.** end_call requires tools enabled, serial phone tool calls
   and playback-idle transport. It relies on the model emitting its farewell/tool in
   the intended order; local RTP drain cannot prove remote acoustic playback. Live
   default-policy testing is still required.

No obvious TODO/FIXME/HACK/not-implemented marker was found in src, dashboard/src or
apps during this audit. That search is not evidence of feature completeness; the
mock boundaries and missing office/concurrency capabilities above remain explicit.

## Manual acceptance sequence

Use one synthetic customer, one test calendar and one caller at a time. Ensure the
isolated process loads the new fix (it was not restarted during this audit).

1. Call the dedicated test number. Pause naturally, interrupt once and verify YIBO
   waits appropriately without repeated questions or freezing.
2. Ask availability and book. Hear one clear confirmation only after success; verify
   exactly one Google event, correct location/provider, local date/time and price.
3. Reschedule twice, then cancel. Record the original event ID; verify it stays the
   same until cancellation and neighboring events are untouched.
4. Finish normally. Hear the entire goodbye, one hangup, and verify ARI bridge/media
   cleanup. Separately test caller hangup and a controlled provider failure.
5. In the browser, test operator/admin restrictions, appointment retrieval, retained
   failed drafts, blocked route/deactivation changes and two-tab configuration conflicts.

Next three priorities: (1) restore isolated Google access, (2) approve/establish the
dedicated phone path, (3) run and record this controlled acceptance sequence with
an office user. Preserve the working phone service and do not merge to main yet.
