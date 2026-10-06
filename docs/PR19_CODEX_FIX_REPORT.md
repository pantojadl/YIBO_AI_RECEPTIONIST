# PR 19 Codex fix report

Head before this pass: `5de8c84`. This revision is the follow-up on `grok/yibo-alan-four-fixes`.

`pnpm typecheck`, `pnpm test` (739 passed, 1 skipped), and `pnpm build` all exit 0.

## The five findings

### 1. Recovery could undo a newer cancellation

Recovery used to read a `PENDING_CONFIRMATION` row, then later save that snapshot. A cancel that landed in between was overwritten.

Recovery now takes the same location lock as an edit, discards the pre-lock snapshot, re-reads, and writes with compare-and-swap on version and status (`PENDING_CONFIRMATION`). A row whose version or status moved is left alone. A row with `compensationRequired` is never confirmed.

Regression: a cancel (and, separately, a reschedule plus office outcome) commits while recovery is still on the old pending read. The database stays on the newer row. The cancelled event stays deleted.

That test fails on `5de8c84` and passes here.

### 2. Age-only lock delete allowed two writers

`releaseStaleLocks` deleted a claim because it was old. A live writer could still be inside the provider call.

The SQLite guard now uses one numeric clock (`heartbeat_ms`, unix milliseconds):

- The holder refreshes the lease every 30 seconds.
- The lease is 90 seconds (three missed heartbeats).
- A second writer gets `APPOINTMENT_OPERATION_IN_PROGRESS` while heartbeats continue, including after the claim is older than three minutes.
- After missed heartbeats the next writer steals the row and increments `fence`.
- The old writer's save checks that fence inside the write and does not commit.
- `finally` deletes only `owner_id` AND `fence`.
- Process id is not part of the decision.

Regression: `tests/appointments/live-lock.test.ts` plus `tests/fixtures/sqlite-live-lock.ts`. It fails on `5de8c84` (the old guard deletes the aged row) and passes here.

### 3. A failed calendar delete could become a confirmed booking

`FAILED` is written only after the event is gone: cancel succeeded, or inspect/delete reported `EVENT_NOT_FOUND` for that event id. A timeout, a thrown delete, or a 5xx/`PROVIDER_UNAVAILABLE` result leaves the row `PENDING_CONFIRMATION` with `compensationRequired` set. The slot stays occupied. The next recovery pass can retry.

Regression: delete fails twice, and a delete that throws. The row is not confirmed and not `FAILED`. Fails on `5de8c84`, passes here.

### 4. Caller speech could cancel the spend-cap shutdown

When the token or duration cap trips, a shutdown timer is armed outside `ending`. `cancelCallEnd()` clears the farewell deadline only. Caller speech and a cancelled farewell response may ask for the farewell again. They do not reset or skip the hard timer. The call closes when that timer fires (`SPEND_FORCED_SHUTDOWN_MS`, 45 seconds).

Re-requesting on every `assistant.response_created` would loop, because the new farewell's own `response_created` would request another. The re-request runs on `user.speech_started` and on a cancelled or failed `assistant.response_done`. `response_created` still cannot clear the hard timer.

Regression: spend cap, then speech and a cancelled response. The call still closes at the original deadline. Fails on `5de8c84`, passes here.

### 5. Cancel and reschedule receipts were not in the same commit as the row

The appointment update (`WHERE version = ?`), the replay receipt, and the history event commit in one SQLite transaction. The receipt is not written before the provider call.

Before the provider call the service writes a `CANCELLING` or `RESCHEDULING` intent. That is not a success receipt. A timeout or any other unproven provider result stores `OUTCOME_UNKNOWN` and no success receipt. A retry with the same key inspects Google first. If the event is already gone, or already at the new time, it does not call cancel or reschedule again. A version conflict is not reported as success.

If the local commit fails after Google accepted the change, the intent stays `OUTCOME_UNKNOWN`. Recovery or the same-key retry finishes the local row from the inspection and stores the receipt. A later retry returns that receipt.

Regression: cancel saves would have left a cancelled row with no receipt on `5de8c84`, and the retry version-conflicted or cancelled Google again. Here the first attempt returns a retryable error, the row is not cancelled, there is no success receipt, and the retry returns the original success with one Google cancel. The reschedule case is the same, with one Google reschedule. Both fail on `5de8c84` and pass here.

## Addendum map

| Item | Result |
| --- | --- |
| Recovery lock, re-read, CAS on version and `PENDING_CONFIRMATION` | Fixed |
| Never confirm `compensationRequired` | Fixed |
| Lease, heartbeat, monotonic fence, one numeric clock | Fixed |
| Do not use PID liveness or a longer TTL as the steal rule | Fixed. An earlier PID check was removed because a live process can still be the stale writer after a steal |
| Failed or unknown Google delete stays pending and retryable | Fixed |
| `FAILED` only after a proven delete or `EVENT_NOT_FOUND` | Fixed |
| Hard spend shutdown timer that `cancelCallEnd()` cannot clear | Fixed |
| Barge-in may re-request the farewell and must not reset the hard timer | Fixed, with a narrower trigger. Re-request runs on speech and on a cancelled or failed response. Re-requesting from `assistant.response_created` loops on the farewell's own event. That event still cannot clear the hard timer |
| Appointment mutation and receipt in one transaction | Fixed |
| Unknown provider outcome stores `OUTCOME_UNKNOWN`, no success receipt | Fixed |
| Retry inspects before cancelling or moving again | Fixed |
| Do not map a version conflict to success | Fixed |
| Do not write the receipt before the provider call | Fixed |
| Recovery also races create, reschedule, and outcome | Fixed. Covered by the lock and CAS. Tested with a reschedule plus outcome landing during recovery |
| `CANCELLING` intent before the provider delete | Fixed. Reschedule writes `RESCHEDULING` the same way |
| Hangup mark stays until the in-flight tool finishes | Fixed. `pin` / `unpin` on the shared hangup store. Expired marks with `in_flight > 0` still count as ended |
| Ambiguous Google result must not fall through to confirm | Fixed |
| Reschedule receipt gap | Fixed in the same transaction as cancel |
| Notify can double-send on retry | Fixed for the retry. A same-key retry returns the stored receipt before `notify`. A second distinct reschedule still sends, which the office flow needs. The email itself stays after the commit because it is a remote send and cannot sit inside the SQLite transaction. A crash between commit and send can skip one email; it cannot send the same change twice |
| SQLite-backed lock tests | Fixed. `tests/fixtures/sqlite-live-lock.ts` |
| Docs match the new contract | Fixed in `docs/APPOINTMENT_EDIT_PROTECTION.md` and `docs/HARDENING_REPORT.md` |
| Single-flight recovery | Fixed inside one process. Create and cancel share one recovery chain, so two scans do not run at once. Two processes can still scan; each appointment write still takes the location lock and the compare-and-swap |

Nothing in the addendum was rejected. The `response_created` re-request and the remote email send are the two places the literal wording was narrowed, both for the reasons above.

## Tests that must fail on `5de8c84` and pass here

- Cancel commits while recovery still holds the old pending row: the row stays `CANCELLED` and the event stays deleted.
- Lock held past three minutes with heartbeats: the second writer gets `APPOINTMENT_OPERATION_IN_PROGRESS`. After missed heartbeats the steal works and the old save fails on the fence.
- Hangup, create event, delete fails twice: the row stays pending, the flag stays set, the slot stays occupied.
- Delete timeout: not confirmed, not `FAILED`.
- Spend cap, then speech and a cancelled response: the call closes at the hard deadline.
- Cancel commit fails before the receipt exists: retry returns the success and does not call Google cancel a second time.
- Reschedule receipt failure: same, one Google reschedule.
- Hangup mark still set when a tool finishes after the old TTL.
- Reschedule/outcome lands during recovery: the newer row is kept.
- One stuck-booking scan at a time.

## Round 2 — Codex final re-review

Head before this pass: `888f100`. The two attached specs (`uploads/alan-codex-round2.md` and `uploads/heavy-answer-round2.md`) were not on disk and PR #19 had no review text. The seven steps below are the design from the request. Where the implementation is narrower, the answer says so.

The Codex interleaving was reproduced on `888f100` before the fix. The same fixture, run against that commit, fails: writer A blocks inside the reschedule re-fetch, the lease expires, writer B steals the fence and commits 12 August, then A reads B's etag and PATCHes Google back to 11 August (`Google 2026-08-11T10:00:00-06:00 diverged from row 2026-08-12T16:00:00.000Z`). That fixture now keeps Google and the row on the same instant, sends no PATCH, returns `NEEDS_RECONCILE` for A, and rejects B with `APPOINTMENT_OPERATION_IN_PROGRESS`.

### 1. Is the etag stored at intent time and never re-fetched?

Yes for the value sent to Google. `captureIntentEtag` reads once. `intent_etag` (migration 14) is stored with `CANCELLING` or `RESCHEDULING`. Cancel and reschedule send that stored value as `If-Match`. A later inspect still reads the event so a same-key retry can see that the change is already present. That read is not copied into `If-Match`. A direct adapter call that omits `expectedEtag` still reads once so older identity checks keep working. The service does not use that path.

### 2. Do open intents block a different key?

Yes. A different idempotency key is `APPOINTMENT_OPERATION_IN_PROGRESS` and does not call Google. The same key still continues, including after `OUTCOME_UNKNOWN`.

### 3. Is the fence checked before every Google call?

Yes before create, before the intent-time read, and again before the mutating cancel or reschedule. In the interleaving fixture the stolen fence returns `NEEDS_RECONCILE` with zero PATCH requests.

### 4. Does If-Match treat HTTP 412 as NEEDS_RECONCILE?

Yes. The calendar port returns `NEEDS_RECONCILE`. Cancel and reschedule return that code, keep the original intent and etag, and do not mark `OUTCOME_UNKNOWN`. HTTP status is 409.

### 5. Does a fence reject keep the intent?

Yes. `markUnknown` runs only while this writer still holds the fence. A stolen fence leaves `CANCELLING` or `RESCHEDULING`, the key, the fingerprint, and the etag on the row.

### 6. Does recovery repair Google toward the committed row?

Yes, with two bounds. After this process steals an expired lease, recovery may inspect appointments updated in the last 15 minutes and PATCH or DELETE Google back to the committed row. It uses the etag from that repair read while it holds the new fence. It does not refresh the etag stored on the original intent. The steal flag is cleared only after every appointment at that location has been considered, and only when none of those repairs is still held and the location has no live lease. Scanning every historical row on every booking was rejected because it would read Google for the whole book. The steal flag is process memory: a restart before the next recovery pass drops it.

### 7. Does recovery skip a live heartbeat?

Yes. `hasLiveLease` is checked before any recovery Google call. A heartbeat inside the 90 second lease is left alone, including when the claim is older than three minutes.

### 8. Is create deduplicated by a private operation id?

Yes. The event's private `yiboOperationId` is a hash of the tenant and idempotency key. A retry looks that property up first and returns the existing event instead of inserting another. A 409 whose operation id differs, or whose times differ, is a mismatch.

Nothing from the round 1 contract was reverted. Mocked Google only. No live provider call.

Round 2 verification: `pnpm exec tsc --noEmit` exit 0, `pnpm exec vue-tsc --noEmit -p dashboard/tsconfig.json` exit 0, `pnpm test` 745 passed and 1 skipped, `pnpm build` exit 0.
