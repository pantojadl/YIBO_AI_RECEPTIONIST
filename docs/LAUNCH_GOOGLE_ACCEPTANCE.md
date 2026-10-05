# Launch candidate — real Google Calendar acceptance

**PASS — 26 September 2026**, code commit
`3046c82db60d2672376af58f969d990b5b15e829` on `codex/yibo-launch-candidate`.
This is a real-provider release gate, separate from the simulated regression suite
and the earlier integration-branch test on September 22.

## Isolation and authorization

- Used the existing **YIBO Test Appointments** calendar. A read-only Google request
  confirmed its label and owner access before any event write.
- The earlier temporary acceptance database was missing. The original token store
  was opened read-only; the existing grant was copied to a fresh private encrypted
  token store. Refresh returned HTTP 200. No new consent, callback, client, scope,
  mapping or live token-store change was made.
- Built the current configured application with fresh private SQLite, synthetic
  business/customer/service data and the existing Calendar adapter/resolver. Its
  calendar route points only to the verified test calendar. Telephony, Realtime and
  email delivery remained disabled. No API server or PBX route was changed.
- The harness allowed event writes only for its two predeclared synthetic IDs and
  required `[YIBO TEST]` plus a unique run label. Existing event summaries/customer
  details were not needed: neighbor comparison used IDs and etags in memory.
- Credentials, encrypted database, event identifiers, cleanup manifest and raw
  diagnostic artifacts remain outside Git in a private directory. No live or
  synthetic customer records were added to repository files.

## Actual checks

| Scenario | Result |
|---|---|
| Existing OAuth refresh and access | PASS — token refresh/read HTTP 200; no configuration changes |
| Real availability | PASS — domain scheduling uses real Google FreeBusy, then revalidates before writes |
| Neighbor and primary booking | PASS — two Google inserts, HTTP 200; local rows confirmed at revision 2 |
| Retrieve / identity / local time | PASS — ownership fields, test label, exact start/end instants and America/Chicago clinic timezone match SQLite |
| First reschedule | PASS — primary 09:30→10:00 on October 12, 2026 clinic time; PATCH 200, original ID, revision 3 |
| Second reschedule | PASS — 10:00→10:30; PATCH 200, same ID, revision 4 |
| Stale cancellation | PASS — revision 2 rejected before any Google request; current booking retained |
| Reviewed cancellation | PASS — DELETE 204, local CANCELLED revision 5, original ID retained in local history |
| No duplicate / wrong event | PASS — one active matching event after each write; no extra inserts; neighbor unchanged throughout primary changes/cancel |
| Existing calendar contents | PASS — all 15 pre-existing active events retain their IDs and etags before/after the sequence and cleanup |
| History | PASS — primary has one CREATED, two RESCHEDULED and one CANCELLED record |
| Cleanup | PASS — neighbor cancelled separately (DELETE 204); both Google events confirmed cancelled/deleted and absent from active lists |
| Local cleanup | PASS — both SQLite records CANCELLED, revisions 3/5; original IDs retained; zero operation claims remain |

The synthetic neighbor occupied 09:00–09:30 on the same day/professional. The test
calendar's display timezone is America/Denver; the synthetic clinic is
America/Chicago. Exact instant and explicit clinic-zone checks passed despite that
difference. No calendar timezone configuration was changed.

Execution: 17:22:52–17:23:02 UTC. The harness invokes the actual appointment service,
shared SQLite guard, scheduling service, assignment resolver and Google adapter;
it does not replace the provider with a fake. It does not speak to a caller or
exercise browser microphone/phone transport. Synthetic two-tab browser acceptance
is documented separately under [RISK-001](APPOINTMENT_EDIT_PROTECTION.md).

All 38 live assertions passed. A focused rerun of the Google adapter, OAuth,
event-identity and callback tests passed **31/31** across four files. Backend and
dashboard typechecks, production build and the 679-pass full regression were already
green for this exact code commit; this gate adds documentation only, so they were
not repeated. No runtime fix was needed.

## Next gate and manual work

**ACCEPT-001 — real isolated phone call remains blocked/unverified.** Extension
7001's earlier change was rolled back after validation failed. Keep that stable
state. Before another attempt, diagnose the loaded test route and prepare a concrete
isolated ingress/media proposal; obtain explicit approval for any routing change.
Then a real caller must check turn-taking, interruption, contact, booking and spoken
confirmation, full goodbye and channel/bridge/RTP cleanup. Automated Google success
does not pass that gate. Main merge, deployment/restore and pilot approval remain
separate later steps in the launch plan.
