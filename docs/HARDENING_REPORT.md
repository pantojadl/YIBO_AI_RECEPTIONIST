# YIBO final hardening report

Branch: `grok/yibo-final-hardening`  
Pushed to the fork only: https://github.com/pantojadl/YIBO_AI_RECEPTIONIST  
Suite and production build were run on `373dbb235d50fe162d894adc1bf01a6917aeaddb`. This report is the only commit after that run.  
Draft review PR (fork `main` only): https://github.com/pantojadl/YIBO_AI_RECEPTIONIST/pull/1

Upstream `AlanCole1234/YIBO_AI_RECEPTIONIST` was fetched read-only. Its push URL is `DISABLED`. Nothing was pushed, merged, or commented there. `main` in the fork was not committed to. Live Telnyx, SIP numbers, Asterisk dialplans, Cloudflare, Google OAuth, and production databases were not touched.

Runtime for every command below: Node v22.14.0, pnpm 11.19.0.

## 1. Baseline

Base is fork `main` at `01dc29a7` (`Merge final release hardening`, 2026-09-27 13:03:37 -0600). `codex/yibo-launch-candidate` (`6ec8c020`, 2026-10-04 13:19 -0600) was merged into `grok/yibo-final-hardening` as `982ce2b`.

Commands after that merge and before the later fixes:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Success, 159 packages |
| `pnpm typecheck` (`tsc --noEmit && vue-tsc --noEmit -p dashboard/tsconfig.json`) | Exit 0 |
| lint | No lint script and no ESLint config. `package.json` scripts are `db:init`, `admin:create`, `dev`, `dev:api`, `dev:dashboard`, `dev:voice`, `dev:voice:transcript`, `build`, `typecheck`, `test`, `release:preflight` |
| `pnpm test` (`vitest run`) | 1 failed file, 91 passed, 1 skipped (93). 19 failed tests, 682 passed, 1 skipped (702). Every failure was `tests/integrations/regional-backup.test.ts`: `node:sqlite` has no named export `backup` on this runtime |
| `pnpm build` | Exit 0. Vite produced `dist/index.html` 0.49 kB, `dist/assets/index-B_GcMP9f.css` 91.59 kB, `dist/assets/index-DprdAmoq.js` 242.95 kB |

## 2. Bugs and risks, by severity

1. **High — a failed confirmed write left a bookable slot.** `src/modules/appointments/application/appointment-service.ts` saved `PENDING_CONFIRMATION`, created the calendar event, then saved `CONFIRMED`. If that last save threw, the pending row remained and `findConfirmedIntervals` counted only `CONFIRMED`, so a second create could take the same staff and time. Fixed.
2. **High — hangup did not stop an in-flight booking.** `src/modules/conversation/application/conversation-service.ts` cancelled the tool deadline on `close()` but the underlying create kept running and could return success. Fixed for voice creates.
3. **High — dashboard creates had no stable idempotency key.** `src/api/routes/appointments.ts` already honors `Idempotency-Key`, and generated `dashboard:<id>` when the header was missing, so two clicks were two appointments. Fixed on the client.
4. **Medium — clinic-local morning times shifted across DST.** `src/modules/scheduling/domain/time.ts` applied one offset correction. On `America/Chicago` 2026-03-08, 07:00 landed an hour later, and the skipped 02:30 hour was shifted forward. On 2026-11-01 the repeated 02:00 hour was shifted backward. Fixed.
5. **Medium — regional backup could not snapshot on the supported runtime.** `src/operations/regional-backup.ts` imported `backup` from `node:sqlite`. Node 22.14 does not export it, so all 19 backup tests failed before a file was written. Fixed.
6. **Medium — operational logs could copy a token-shaped string if a field were later allowlisted.** `src/shared/observability/operational-log.ts` already drops unknown keys. A denylist was added so bearer, refresh-token, access-token, and client-secret text is omitted even from an allowed field.
7. **Already enforced, now regression-tested — disabled staff.** Scheduling and appointment create already require an active professional and an active location assignment (`EMPLOYEE_UNAVAILABLE` / `EMPLOYEE_NOT_FOUND`). No calendar event is created.
8. **Already enforced, now regression-tested — cross-tenant read.** `src/api/admin-guard.ts` rejects a session whose `tenantId` is not the process tenant with `403 TENANT_ACCESS_DENIED` before the appointment handler runs.
9. **Not a code defect — no inbound webhook route.** Retried voice tool calls are deduped by tool-call id. There is no webhook handler to replay.

## 3. Changes

Hardening commits on top of the launch-candidate merge:

| Commit | Change |
| --- | --- |
| `982ce2b` | Merge launch-candidate onto main hardening |
| `cee4df4` | DST conversion repeats until the wall clock matches and rejects a time that does not exist |
| `0aa384b`, `c7e34d5` | Snapshot with `node:sqlite` `backup()` when that export exists, otherwise `VACUUM INTO` a new file. The second commit fixes the type of that probe |
| `da9cc42` | Pending rows occupy the slot. A failed confirmed save cancels the event from that request. Reconciliation fails pending rows that never received an event and holds rows that did, without deleting external events |
| `d300d55` | Hangup marks the call ended before cleanup. A voice create that sees the mark fails the row and removes the same-request event |
| `bb87140` | Dashboard booking sends one `Idempotency-Key` per click, outside the JSON body |
| `592f12e` | Disabled-staff regression tests |
| `e9e84e4` | Drop token-shaped log strings. OAuth status and callback results stay token-free. A foreign tenant session cannot read an appointment id |
| `373dbb2` | Phone fixtures reset hangup memory so reused call ids in tests stay live |

### Merge resolutions

Only two conflicts, neither left a booking path half-applied:

- `docs/PROJECT_STATUS.md`: both parents' checkpoints are kept. The branch header states that this line is final hardening on main plus the launch candidate.
- `tests/e2e/booked-calendar-routes.test.ts`: the launch candidate's contact-confirmation rejection (no calendar event) is kept, and main's `confirmContact` plus `available()` run before a successful create. Availability is rechecked immediately before the 19:00Z create so an older `requestedStartAt` cannot override that start. The new event start is asserted as 19:00Z. The route still creates three events.

Cherry-picks of `447c667` and `619d051` from `codex/asterisk-development-phone` were attempted and aborted. Both conflicted across scheduling, calendar, the tool executor, telephony, and tests. They were not forced.

## 4. Tests added or changed

- `tests/scheduling/time.test.ts` — spring-forward 07:00, fall-back 02:00, and the skipped 02:30 hour.
- `tests/integrations/regional-backup.test.ts` — existing 19 cases, now passing on Node 22.14.
- `tests/appointments/appointment-service.test.ts` — confirmed-save failure, compensation failure, pending occupancy, reconciliation, hangup during calendar create, hangup before create, disabled staff.
- `tests/fixtures/sqlite-pending-slot.ts` and `tests/integrations/sqlite-pending-slot.test.ts` — SQLite interval stays occupied until the row is `FAILED`.
- `tests/conversation/conversation-service.test.ts` — close marks the call ended; the same tool-call id runs once.
- `tests/calls/call-orchestrator.test.ts` — hangup marks the call ended.
- `tests/integration/api-flow.test.ts` — replaying `Idempotency-Key` returns the same appointment id.
- `tests/dashboard/availability-search.test.ts` — the booking POST carries a UUID key and the JSON body does not.
- `tests/scheduling/scheduling-service.test.ts` — inactive professional and inactive assignment.
- `tests/observability/operational-log.test.ts` — token-shaped strings are absent from the record.
- `tests/integrations/google-oauth-service.test.ts` — status and callback JSON do not contain the stored token or the client secret.
- `tests/integration/auth-api.test.ts` — a session for another business gets `403` on `GET /api/appointments/:id` and the body does not include that id.
- `tests/helpers/phone-operations.ts`, `tests/e2e/voice-google-booking.test.ts` — reset hangup memory per fixture.

Existing coverage that still passes and was not weakened: `tests/appointments/appointment-concurrency.test.ts`, `tests/integrations/sqlite-appointment-concurrency.test.ts`, `tests/integrations/sqlite-security-isolation.test.ts`, `tests/e2e/phone-operations.test.ts` (one of two callers books the slot; RTP/ARI cleanup scenarios), `tests/telephony/asterisk-rtp-voice-media-gateway.test.ts`.

The dashboard booking change is a request header, not a layout change. It was exercised through the dashboard API tests. The browser was not driven.

## 5. Final verification

Recorded on `373dbb2` after the phone-fixture reset. The report commit on top of that does not change product code:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Exit 0. An earlier cast in `copyConsistentSnapshot` failed `tsc` (`backup()` is typed as `Promise<number>`). That was fixed in `c7e34d5` before this run. `pnpm build` runs typecheck again |
| lint | Not configured |
| `pnpm test` | Test files 94 passed, 1 skipped (95). Tests 717 passed, 1 skipped (718). Duration 23.99s. Exit 0 |
| `pnpm build` | Exit 0. Vite 7.3.6: `dist/index.html` 0.49 kB, `dist/assets/index-DVG_BZug.css` 91.59 kB, `dist/assets/index-DGZFpLFE.js` 243.26 kB, built in 1.05s |

No test was skipped, deleted, or weakened to get this result. The one skipped file was already skipped before this work.

## 6. Security and credentials

Scanners: gitleaks 8.28.0 over 177 commits, and trufflehog 3.90.5. No verified live credential. Values are omitted here on purpose.

- **Test fixture, not a live key.** gitleaks `generic-api-key`, two hits, `tests/release/release-preflight.test.ts` lines 16–17, commit `47419cbfc3eb16e301138a932dc3e5d7abe63bcd`. The names are `YIBO_TOKEN_ENCRYPTION_KEY` and `YIBO_ADMIN_SESSION_KEY`. Both values are sequential hex placeholders. Present on `main`. No rotation required unless the owner disagrees with that classification.
- **False positive, commit id.** trufflehog unverified `CloudflareApiToken` and `Github` on `docs/DEPLOYMENT_CHECKPOINT.md` line 57, commit `b100bbe7d250892ff08875afbedbaf966ac19963`. The 40-hex string is exactly commit `40f89423`. It is not on the current line of that file. No rotation.
- **Synthetic test URL.** trufflehog unverified URI in `tests/deployment/cloudflare-worker.test.ts` line 51, commit `40f89423`. The URL uses an example host. That file is only on `upstream/codex/cloudflare-deployment`, not on this branch.
- No private keys, GitHub PATs, AWS access-key ids, Google API keys, Slack tokens, or Telnyx API tokens were found. The working tree has `.env.example` only.

OAuth tokens stay in the encrypted token store. `status()` returns `{ configured, connected }`. The authorization URL carries the client id and signed state, not the client secret. Appointment reads for another business stop at the admin guard.

## 7. Remaining risks

- **Phone branch not merged.** `codex/asterisk-development-phone` (`619d051`, 2026-10-04 22:49 -0600) split at `7df03e4` (2026-09-07). It is 108 commits behind `main` and has two unique commits, `619d051` and `447c667`. Clean cherry-pick failed. Unique material still absent includes `docs/reliability/*`, `scripts/reliability/live-confirmation-check.ts`, `tests/conversation/call-completion.test.ts`, `tests/conversation/conversation-lifecycle-regression.test.ts`, `tests/integrations/google-rescheduling-regression.test.ts`, `tests/scheduling/google-calendar-scheduling-regression.test.ts`, and `tests/voice/dev-voice-playback.test.ts`. RTP gateway code on `main` is a different line and was left in place.
- **Cloudflare Worker not merged.** `40f8942` (`chore(deploy): prepare Cloudflare dashboard with strict build approvals`) is not an ancestor of this branch. Missing: `deploy/cloudflare/worker.ts`, `wrangler.jsonc`, `tests/deployment/cloudflare-worker.test.ts`, `docs/CLOUDFLARE_DEPLOYMENT.md`. Merging that branch would drop later launch-candidate backup work, so it was not merged.
- **Other named release branches.** `codex/final-release-hardening` (`4729feb`), `codex/release-blockers` (`0f49d5c`), `codex/release-ops-closure` (`5267ac6`), and `codex/recovered-work` (`1ff998b`) are ancestors of `main`. Nothing on them is missing. `codex/integrate-telephony-and-finish` commits `46ce713` and `733d689` are ancestors of this branch through the launch-candidate merge.
- **Location locks do not expire.** `appointment_operation_locks` is fail-closed. A crashed writer leaves the lock until a human deletes that row after confirming the provider write is finished.
- **Reconciliation will not delete a Google event by itself.** A pending row that already has an external id is reported as held. The same-request failure path does cancel the event it just created. If that cancel fails, the row stays pending and the slot stays occupied.
- **DST gaps are rejected.** A local time that does not exist becomes an invalid instant (`null` from normalization). Callers must treat that as "not a bookable time". The repeated fall-back hour keeps the first occurrence.
- **No webhook ingress.** Idempotency covers dashboard retries and same voice tool-call ids. A future webhook needs its own replay key before it is allowed to book.
- **Live providers were not called.** Google, Telnyx, Asterisk, and Cloudflare were not exercised against production.

## 8. Human production checks

1. Review this branch and the fork PR. Do not deploy it, and do not merge it into upstream, until that review.
2. Confirm the secret classification in section 6. Rotate a credential only if you decide one of those hits is real. If you do, this recommendation drops to NOT READY until the rotation is done.
3. Run the existing live acceptance checklists (calendar connect, a real booking, a hangup during booking, a second booking of the same slot) against a non-production calendar and a non-production PBX. This pass did not place those calls.
4. After any process crash, check `appointment_operation_locks` before serving traffic. Clear a row only when the matching provider operation is known to be finished.
5. Review pending appointments that have an external event id. Confirm or fail them by hand. Do not assume reconciliation deleted the Google event.
6. If the Cloudflare Worker or the phone-branch reliability notes are required for launch, port them in a separate reviewed change. They are not in this branch.

## 9. Rollback

No production database or live route was changed, so rollback is git-only: reset the fork branch to `01dc29a7` or revert `373dbb2` back through `cee4df4`. Do not force-push `main`.

- Reverting the DST commit restores the one-hour morning shift around US transitions.
- Reverting the backup commits makes `pnpm test` fail again on Node 22.14 and stops snapshot creation.
- Reverting the appointment and hangup commits allows a pending row to stop occupying its slot and allows a create to confirm after hangup.
- The dashboard idempotency change is backward compatible: the server still generates a key when the header is absent.

## 10. Launch recommendation

**READY WITH CONDITIONS**

The automated booking, isolation, hangup, idempotency, DST, and backup paths covered above pass on this branch, and the production dashboard build is green. Launch still depends on a human review of this fork branch, a non-production live check of Google and the PBX, and an explicit decision about the unmerged phone-branch notes and Cloudflare Worker. No live credential was found in history, so the recommendation is not held at NOT READY for rotation. It becomes NOT READY if the owner decides any historical hit in section 6 is a real credential and has not rotated it yet.
