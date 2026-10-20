# Baseline audit

Audit date: 2026-10-20. This file prefers the code and tests in this branch over older READMEs.

## Provenance

| Item | Evidence |
|---|---|
| Repository | `pantojadl/YIBO_AI_RECEPTIONIST` (`origin`). The launch brief named `AlanCole1234/YIBO_AI_RECEPTIONIST`. This checkout's remote is the fork. |
| `main` at audit start | `01dc29a7fc2385126dc88018d4e213099480696f` (2026-09-27, "Merge final release hardening"). `git fetch origin main` matched that commit. |
| Working tree | Clean before this branch. |
| Other remote branches | `grok/yibo-final-hardening` (PR #1, draft), `grok/yibo-alan-four-fixes` (PR #2, open). There is no PR #19 and no `codex/cloudflare-deployment` branch on this remote. |
| GitHub Actions | `gh run list` returned no runs for this fork. A workflow file exists at `.github/workflows/release-gate.yml`. Absence of runs is not a green CI result. |

## What works (code and synthetic tests)

- TypeScript API (Fastify) and Vue dashboard. Node `>=22.13`, pnpm `11.19`.
- Regional SQLite (MX and US) with migrations through version 10, WAL, tenant and called-number lookup.
- Call path on a trusted DID: Asterisk `StasisStart` → `AsteriskTelephonyGateway` → `CallOrchestratorService` resolves the dialed number → answer → customer → agent instructions → RTP external media → conversation tools → hangup cleanup. Unknown or invalid called numbers are hung up before an AI session (`CallOrchestratorService.handleIncoming`).
- OpenAI Realtime adapter behind `YIBO_RUNTIME=openai-realtime`. Default model in code: `gpt-realtime-2.1`. The live test is skipped unless `OPENAI_API_KEY` is set. This audit did not set one.
- Google Calendar OAuth and event identity are implemented and covered by adapter tests. No live Google call was made.
- Admin sessions are signed. The active-session map is process-local (`SignedAdminSession`). A restart drops it.
- PCMU RTP conversion, pacing, and external-media channel exclusion from call ingress are implemented and tested with local UDP, not a carrier.
- Production preflight script refuses a release when required secrets, HTTPS origins, or the regional database file are missing.

## What is stubbed or simulated

- Default runtime is `in-memory` conversation, not OpenAI.
- E2E telephony uses a fake ARI client and real local UDP sockets. No SIP carrier, no Asterisk process, and no PSTN call was run here.
- Email is skipped when Resend is unset. Appointment success does not depend on it.
- The seeded businesses are development fixtures (`YIBO Demo Clinic`, `YIBO US Demo Clinic`) with dental service names. They are not a live customer and are not a healthcare offer.
- The new `/demo` page is a scripted browser sandbox. It does not open a model session and does not store what the visitor types.
- Asterisk config under `deploy/asterisk/` is a template. It is not a running PBX until someone installs Asterisk 22 and renders it.

## What blocks a real US call

1. No US DID and no SIP trunk. The template's carrier match is `203.0.113.10` (documentation range) and the outbound transfer context hangs up.
2. No approval to spend OpenAI credit. `OPENAI_API_KEY` is empty in the demo compose file.
3. No measured host. Docker Compose can start the API on `127.0.0.1:3000`. That is not a public PSTN path.
4. NAT, firewall, and RTP still have to be proven on a real network. See `DEPLOYMENT.md`.
5. Booking recovery bugs fixed only on unmerged PR #2 are still open on this line of work. See the matrix.

## Call path

```
Carrier INVITE (not configured)
  → PJSIP endpoint context yibo-inbound
  → extensions.conf matches +1NXXNXXXXXX, else "Rejected unknown called number" and Hangup
  → Stasis(yibo, ${EXTEN})
  → AsteriskAriClient ignores UnicastRTP / yibo-external-media
  → duplicate StasisStart for the same channel is ignored
  → US 10-digit called numbers become +1 E.164 when YIBO_REGION=US
  → BusinessDirectory lookup; unknown DID hangs up with no model session
  → External Media RTP on YIBO_ASTERISK_MEDIA_HOST and the configured UDP range
  → OpenAI Realtime only when YIBO_RUNTIME=openai-realtime and a key is present
  → tools use server tenant/location, not model-supplied IDs
  → hangup drops bridge, media, and the in-memory session
```

Phone-number transfers redirect to `Local/<digits>@yibo-outbound-transfer`, which hangs up. They do not dial `PJSIP/<number>`.

## Process-local state

One API process is the writer for a regional SQLite file. `YIBO_INSTANCE_LOCK=1` refuses a second live process on the same host. A lock from another container hostname is replaced. Horizontal replicas are not supported. Admin session revocation and the in-memory appointment concurrency guard do not cross processes. Do not run two containers against one database file.

## Secrets

No API keys, ARI passwords, or `.env` values were added. Templates use `__PLACEHOLDERS__`. Rendered output is gitignored (`deploy/asterisk/rendered/`). `.dockerignore` excludes `.env`.

## Contradictions (code wins)

| Document | What it says | What the code shows |
|---|---|---|
| Launch brief | PR #19 on `AlanCole1234` | This remote has PR #1 and PR #2. PR #2's tip is `2520609`. It was not merged. |
| `docs/PROJECT_STATUS.md` (2026-09-27) | 482 tests, schema discussed as 9 in the closure audit | Migrations on `main` already go through `010_office_operations.sql` (version 10). Test count must be taken from the suite run recorded in `RELEASE_CANDIDATE.md`. |
| `docs/RELEASE_CLOSURE_AUDIT.md` | "software roadmap complete" | That is an automated checkpoint. `PRODUCTION_RELEASE_ACCEPTANCE.md` still leaves DEPLOY-001 and ACCEPT-001 open. No live PSTN evidence was found. |
| Older transfer code | `PJSIP/<number>` | Replaced in this branch. A bare `PJSIP/` dial is not a trunk. |
| Seed name "Demo Clinic" / dental services | Looks like a clinic product | Launch scope is non-regulated appointment businesses. The fixture name was left in place so existing tests stay valid. Do not sell it as healthcare. |

## Blocker matrix

| ID | Severity | Capability | Status | Reproduction | Cheapest $0 path | Validation | Needs |
|---|---|---|---|---|---|---|---|
| B-DID | P0 | Telephony | Confirmed | No trunk credentials; template match is TEST-NET-3 | Keep inbound dialplan and blocked outbound context | `pnpm asterisk:check` | Owner buys one US local DID |
| B-AI | P0 | Conversation | Confirmed | Live test skips without `OPENAI_API_KEY` | Mocked suite only | `tests/integration/openai-realtime.live.test.ts` skipped | Capped OpenAI key, explicit approval |
| B-HOST | P0 | Deployment | Confirmed | No public host in this run | `./deploy/up.sh` binds localhost | `GET /api/health`, `GET /demo` | Owner hardware or an approved VPS |
| B-NAT | P0 | Media | Suspected until a host exists | RTP and SIP addresses are template fields | Document external_*_address and firewall | Layer C in `TEST_MATRIX.md` | A machine with UDP and a carrier IP allowlist |
| B-BOOK | P0 | Booking integrity | Confirmed on `main`, fixed only on PR #2 | Single DST correction booked 07:00 Chicago as 13:00Z on 2026-03-08 and accepted 02:30. That DST case is fixed here. Stuck pending rows, idempotent cancel/reschedule, and shared hangup marks are still only on PR #2 | Do not merge PR #2 blindly (12k lines, product UI plus fixes) | DST tests in `tests/scheduling/time.test.ts` | Review and port or merge PR #2's booking commits |
| B-SCALE | P1 | Multi-instance | Confirmed | `SignedAdminSession.activeSessions` is a `Map` | Instance lock and one-writer docs | `tests/launch/instance-lock.test.ts` | Stay on one process for the pilot |
| B-REC | P1 | Compliance | Confirmed control | `YIBO_CALL_RECORDING=on` throws | Default off | `tests/bootstrap/configuration.test.ts` | Counsel before any recording |
| B-OUT | P1 | Toll fraud / TCPA | Confirmed control | `YIBO_OUTBOUND_DIALING=enabled` throws; external transfer off | Inbound dialplan only | Gateway and template tests | Separate approval before any transfer leg |
| B-HIPAA | P0 if a clinic is sold | Compliance | Confirmed exclusion | Prompt forbids medical details; demo says not HIPAA | Do not onboard healthcare | Demo status JSON `hipaaClaim: false` | BAA review, which is out of scope |
| B-CAL | P1 | Google Calendar | Suspected live | Adapter tests pass; no live OAuth in this run | Keep synthetic tests | ACCEPT-001 checklist | Owner's Google OAuth client and a test calendar |
| B-911 | P1 | Emergency | Confirmed limit | No emergency trunk, no E911 registration | Prompt tells the caller to contact local emergency services | Prompt compiler test | Do not advertise 911 handling |

## Not claimed

Live PSTN, production readiness, HIPAA, TCPA compliance, SOC 2, FCC approval, or coverage of all 50 states.
