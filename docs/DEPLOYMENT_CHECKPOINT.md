# Checkpoint 6: persistent backend, backup and restore

4 October 2026. **Public dashboard verified; API connection and deployment gate OPEN.**
No server, DNS, Cloudflare, phone, Google/OAuth or production-data change is included.
Work remains on `codex/yibo-launch-candidate`; this is not approval to merge to main.

## Public Worker verification — 4 October 2026

The user supplied **https://yibo-ai-receptionist.28rc9ktmdp.workers.dev**.
Anonymous requests and the browser now verify the existing application directly;
no Cloudflare account access, new Worker, login or provider write was needed.

| Check | Observed result |
| --- | --- |
| HTTPS `/` | **PASS**: 200, valid TLS, YIBO HTML |
| Deployed assets | **PASS**: HTML, `index-B_GcMP9f.css` and `index-DprdAmoq.js` match the local launch build by SHA-256; CSS/JS return 200 with correct content types |
| `/index.html` redirect | **PASS**: 307 to `/`, then 200 without another redirect |
| `/appointments` and `/appointments/` | **PASS for SPA delivery**: 200 dashboard HTML; authenticated appointment behavior is not verified |
| Browser startup | Login screen renders; alert says **"Authentication is unavailable right now."** No credentials entered |
| `/api/health`, `/api/auth/me`, `/api/business`, `/api/admin/readiness` | **BLOCKED**: all return 503 JSON `API_PROXY_NOT_CONFIGURED`, with private/no-store cache headers |
| Browser HTTP navigation | **PASS**: entering the HTTP URL upgrades to the HTTPS URL and renders the same login screen without a loop |
| Raw HTTP `/` | **OBSERVATION**: HEAD/GET and curl return 200 without a server redirect; these clients do not apply the browser's HSTS preload behavior |

The `.dev` top-level domain is on the browser HSTS preload list, as documented by
[Google Registry](https://www.registry.google/domains/dev/). The observed browser
upgrade is consistent with that protection. The initial raw-HTTP finding is not
classified as a broken browser redirect. Non-HSTS clients can still use HTTP;
an explicit server redirect would be separate hardening, not a fix applied here.

The reviewed proxy emits `API_PROXY_NOT_CONFIGURED` before contacting Fastify when
`API_ORIGIN` is missing/invalid/self-referencing, or only one Cloudflare Access
credential binding is present. This response alone cannot identify the incorrect
binding. Inspect the existing Worker's non-secret `API_ORIGIN` and credential
**presence only**. The login alert is not evidence of a wrong administrator password.

The backend's now-known dashboard setting is:

```dotenv
YIBO_DASHBOARD_ORIGIN=https://yibo-ai-receptionist.28rc9ktmdp.workers.dev
```

This was **documented, not applied**. The backend hostname and Worker `API_ORIGIN`
remain unresolved; neither this public Worker URL nor localhost is a valid substitute
for the reviewed HTTPS API origin. Hosted login, persistence and business workflows
remain blocked while the API is unconnected.

Required next steps before deployment changes:

1. Inspect existing `API_ORIGIN` and Access-binding presence. Approve/select the
   separate persistent backend host and off-host backup destination.
2. Preserve the verified HTTPS URL and browser upgrade behavior. If a future review
   requires server-side redirects for non-HSTS clients, test assets and API paths:
   current assets bypass the Worker outside `/api`, so script-only redirects would
   not cover them. See [Cloudflare's static-asset routing contract](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).
   No redirect code or live setting was changed during this inspection.
3. Reconcile future deployment targeting with **existing** `yibo-ai-receptionist`:
   local Wrangler still names `yibo-dashboard` and sets `workers_dev: false`, while
   the operator enabled the current URL. Confirm the account and preserve that route
   before running a deployment command. See [workers.dev configuration](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
4. Use the prepared Node/backup files and a new synthetic store on the approved
   backend. Configure its dashboard origin and the Worker's HTTPS API origin/Access
   credentials privately; keep live phone, Calendar and production databases intact.
5. Repeat public redirects; require health 200 and anonymous auth 401. Then perform
   approved synthetic hosted login/workflow/restart checks and actual off-host
   backup/restore. These blocked checks are not marked complete.

Latest local preflight: **28 Worker/proxy plus 6 authentication tests passed**;
backend/frontend/Worker typechecks, production build and Wrangler dry-run passed.
No upload occurred. The checked-out API/dashboard implementation matches the
Cloudflare branch; the launch branch adds standalone backup tools. No redundant suite was repeated
after these public checks because no runtime code changed.

## Current evidence and blockers

The user reported that 7001 worked and authorized starting Checkpoint 6. That is
manual evidence for the call, not a recording of every ACCEPT-001 variant. See
[the speakerphone repair and acceptance limits](LAUNCH_7001_SPEAKERPHONE_REPAIR.md).

Read-only inspection of the existing Ubuntu Asterisk VPS on October 2 at
23:56 UTC found:

| Resource | Observed |
| --- | --- |
| OS | Ubuntu 24.04.4 LTS, x86_64, systemd 255 |
| CPU | 1 vCPU; about 1% busy during a two-second idle sample |
| Memory | 961.5 MiB total; 558.8 MiB available; no swap |
| Storage | 23.17 GiB ext4 filesystem; 7.71 GiB free |
| Phone service | Running; zero active calls; same Asterisk PID as previous inspection |
| Pressure/history | No OOM kills since boot; no current memory/IO pressure |
| Backend dependencies | No Node, pnpm, cloudflared, restic, or YIBO deployment units installed |

A lightweight API could fit while idle, but this is insufficient evidence of safe
co-hosting during calls, builds and backups. Asterisk and the backend would share
one CPU and limited memory/disk. **Use a separate backend VPS under the requirement
to protect the working phone service.** No resizing, package install, swap, firewall,
benchmark load, restart or provisioning was performed. Host/region selection remains
with the operator; target capacity must be validated before a pilot.

The Cloudflare repository identifies a **Worker with static assets**, named
`yibo-dashboard`, on `codex/cloudflare-deployment` at `40f8942`. Its Wrangler config
has `workers_dev: false` and no custom domain/route or `API_ORIGIN` value. The
existing Tunnel/backend draft contains only `.invalid` placeholders. A successful
dashboard deployment did not identify its public hostname at that inspection;
the subsequently supplied URL is verified above.

### Read-only Cloudflare account inspection — 3 October 2026, 19:57 UTC

The browser is now signed in. The account switcher offers exactly one account;
its unfiltered Workers & Pages list says **"No projects found"**, Domains says
**"No data available"**, and Tunnels shows **"Get started with Cloudflare Tunnel"**.
The Workers page also prompts to set up Zero Trust. The local Wrangler CLI is
not authenticated. No account setting, resource, deployment or credential was changed.

This account does not expose the previously reported YIBO deployment. That does
not establish whether a deployment exists under another login/account. An account's
`workers.dev` subdomain alone is not a verified application URL. The public URL,
`API_ORIGIN` and API domain were unverified at this historical inspection. The URL
is now verified above; backend settings still need the owning account's session.
Do not recreate the Worker or set an origin based on a guessed hostname.

### GitHub follow-up — original build account identified

The GitHub check runs for Cloudflare branch HEAD `40f89423b4170d394db0b17d6fecd78b5637afe4`
identify **`yibo-ai-receptionist` in a different Cloudflare account**. The
[original project link](https://dash.cloudflare.com/cd9a637a5bc540ca195f7c8323cb81a1/workers/services/view/yibo-ai-receptionist/production)
comes from [Cloudflare's GitHub check](https://github.com/AlanCole1234/YIBO_AI_RECEPTIONIST/runs/109012888747).
Opening its linked build with the current login returns **"Page not found"**, with
Cloudflare explaining that the page may not exist or access may be missing.

The terminal check reports **failure on 28 September at 15:56:05 UTC**. Querying
all check runs also returns an older in-progress entry for the same build ID;
neither proves a successful deployment or that a build is still running. No checks
were returned for the preceding `2117c5d` commit. A later manual deployment may
exist, so the user's reported success is not disproved by these limited records.

The recorded Cloudflare project name differs from Wrangler's `yibo-dashboard`.
Do not rename either from this evidence alone: inspect the owning account's actual
project, build settings and deployed version first. Account settings need a session
connected to the owning account; the earlier Codex session is not evidence that
the user's own session lacks access. No build was
retried and no deployment, account membership or configuration was changed.

Required operator inputs:

1. A suitable separate backend host, access method and data region; no purchase is assumed.
2. Dashboard URL **supplied and verified** above. Access to the existing Worker's
   settings is still needed before changing deployment bindings; do not infer the
   deployed Worker name from the local Wrangler configuration.
3. **Settings -> Variables and Secrets:** copy the non-secret `API_ORIGIN` if set,
   or state that it is absent. Do not paste service-token or provider secrets.
4. The Cloudflare-managed domain available for a dedicated API hostname.
5. Approved off-host encrypted backup storage, data region, retention policy and
   independently recoverable secret storage.

## Deployment architecture and prepared files

```text
Hosted Vue dashboard + existing Cloudflare Worker
  /api/* -> protected HTTPS API origin -> named Tunnel
          -> loopback Fastify :3000 -> persistent regional SQLite
```

Reuse the existing Cloudflare proxy/Tunnel work on its deployment branch. Its
unfinished edits remain untouched. This checkpoint does not change Wrangler,
Worker routes or bindings, OAuth callbacks, or Voice Lab networking.

| File | Purpose |
| --- | --- |
| [Node service](../deploy/node/yibo-api.service.example) | One unprivileged Fastify process, automatic restart, private state directory and explicit environment file |
| [Backend environment](../deploy/node/backend.env.example) | Existing application settings; placeholders prevent accidental tenant startup |
| [Backup CLI](../src/cli/database-backup.ts) | Create, verify or restore explicit regional snapshots; no application bootstrap/provider calls |
| [Backup implementation](../src/operations/regional-backup.ts) | SQLite online backup, integrity/foreign-key/region checks, checksums and new-directory-only restore |
| [Backup job](../deploy/backup/run-backup.sh) | Verify snapshot, upload with restic, fail on any incomplete/failed upload and keep local evidence |
| [Backup environment](../deploy/backup/backup.env.example) | Explicit database paths, release SHA and private remote-storage credential file paths |
| [Backup service](../deploy/backup/yibo-backup.service.example) / [timer](../deploy/backup/yibo-backup.timer.example) | Hourly scheduling with up to five minutes jitter; ten-minute job limit |

The Node templates reuse the previously prepared Cloudflare backend draft. They
require Node **22.16+** for the backup API; use a supported, patched Node release
and validate it on the actual host. The application dependency floor is unchanged.
Install the complete approved source plus SQL migrations and `tsx`, using the
locked pnpm **11.19.0** install with development dependencies. `pnpm build` validates
the backend and builds Vue; it does not emit a standalone backend `dist`.

The API unit reads `/etc/yibo/backend.env`, binds through existing `src/main.ts` to
`127.0.0.1:3000`, and writes state only under `/var/lib/yibo`. It prevents implicit
checkout `.env` loading and unsets ARI/media variables. It starts neither Voice Lab
nor telephony. No clustered API replicas: active admin sessions are process-local.
Use a dedicated user, private 0600 environment files and a 0700 state directory.

Review these existing settings before any start:

- `NODE_ENV=production`, exact `YIBO_DASHBOARD_ORIGIN`, stable
  `YIBO_ADMIN_SESSION_KEY` and absolute regional database path(s).
- `YIBO_TENANT_ID` must be supported by the current bootstrap. `YIBO_REGION` alone
  does not select the tenant/database. New pilot-tenant provisioning is a later gate.
- Start hosting acceptance on new synthetic data. Real Google requires its complete
  existing configuration, stored grant, original encryption key and calendar mappings.
  The template's in-memory mode is not evidence of real Google operation.
- Do not import the working phone `.env` or set `GOOGLE_CALENDAR_ID` as a shortcut;
  the latter can write mappings on startup. Keep email disabled for synthetic checks.

After the host/configuration is approved, validate installed unit files with
`systemd-analyze verify` before starting anything. Check health 200, unauthenticated
`/api/auth/me` 401, real login/logout, origin restrictions, and persistence across
a supervised restart. Re-login after restart is expected. Review authenticated
`/api/admin/readiness`; health 200 alone does not certify provider readiness.

The origin hostname needs whole-host Cloudflare Access protection and the existing
Worker's service token. Tunnel ingress should expose only `/api` and `/api/*` to
loopback port 3000, with a 404 catch-all. Set Worker `API_ORIGIN` to the approved
`https://<api-hostname>` with no `/api` suffix. Set Node `YIBO_DASHBOARD_ORIGIN` to the
actual dashboard origin. Keep 4317, ARI, RTP and SSH outside that public route.
Exact hostnames remain blocked on the inputs above.

**Do not split real appointment writes between a new hosted database and the
working phone database.** A production cutover requires one authoritative regional
store and a coordinated compatible release for all writers. No phone migration or
live database transfer is included here. Hosted Voice Lab and fresh OAuth callbacks
also need their own reviewed networking plan.

## Backup contract and settings

The CLI never loads `.env` implicitly and never defaults to `data/`. `create`
requires `--regions`, an absolute, previously nonexistent `--directory`, a full
40-character `--release` SHA and an explicit `YIBO_DATABASE_<REGION>` for every
selected region. It rejects omission of another configured region, duplicate
sources, wrong-region data and missing files.

SQLite's online backup includes committed WAL data while the original remains in
use. Each regional snapshot is individually consistent; it is not a simultaneous
cross-region transaction. Use a coordinated maintenance window when a cutover
requires a common point across writers/regions. Only the newly owned snapshot is
converted to standalone DELETE journal mode. Original database/WAL bytes are not
copied unsafely, migrated or edited.

Snapshots have private directory/file permissions and a manifest containing release,
time, SHA-256, sizes, migration versions and table counts. No plaintext credentials
are added to the manifest. Database snapshots still contain sensitive business data;
local permissions are not encryption. Restic provides encrypted off-host storage.
Checksums detect corruption; they are not a signature against malicious replacement.

| Backup variable | Required value / behavior |
| --- | --- |
| `YIBO_BACKUP_ROOT` | Existing absolute private staging directory; template `/var/lib/yibo-backups`; no implicit default |
| `YIBO_BACKUP_REGIONS` | `US`, `MX`, `MX,US` or `US,MX`, with no duplicates; include every regional file on this host |
| `YIBO_DATABASE_US`, `YIBO_DATABASE_MX` | Existing absolute source files; missing selected paths fail rather than creating a database |
| `YIBO_RELEASE_SHA` | Exact deployed 40-character commit; update alongside each approved release |
| `RESTIC_REPOSITORY_FILE` | Private file containing the approved remote repository URI; local paths are rejected |
| `RESTIC_PASSWORD_FILE` | Private repository password file; explicit CLI argument prevents inherited defaults changing it |
| `RESTIC_CACHE_DIR` | Private local restic cache; template `/var/cache/yibo-restic` |

Storage-provider credentials belong only in the private backup service environment.
Do not put API/Google/ARI credentials there. Keep the repository password, original
token-encryption key, admin signing key and provider configuration recoverable from
separate protected storage outside Git and outside these snapshots. Keep each
region's destination consistent with its approved data-residency requirements.

The wrapper uses the exact reviewed repository/password files. Restic exit 3
(incomplete snapshot) fails just like any other nonzero exit. Provider diagnostics
go to a private log outside the uploaded snapshot; service output uses safe codes.
There is **no automatic deletion, retention pruning or repository initialization**.
Local copies/logs accumulate: set disk alerts and an approved retention procedure
before enabling hourly backups. A systemd timer does not overlap its own running
oneshot service; do not run independent copies of the wrapper concurrently.

## Restore procedure: new files first, cutover separately

The following are operator steps after host/storage approval, not actions already run:

1. Provision and initialize the approved restic repository privately. Run a manual
   backup, check its exit status, and record the exact off-host snapshot ID.
2. On a disposable/standby host, retrieve that snapshot into a **new** private
   directory using the repository's independently recovered password. Run restic's
   repository/data checks. Download the matching release and recover required keys.
3. Find the downloaded directory containing `manifest.json`, then run:

   ```sh
   node --import tsx src/cli/database-backup.ts verify --directory /absolute/downloaded/snapshot
   node --import tsx src/cli/database-backup.ts restore --snapshot /absolute/downloaded/snapshot --directory /absolute/new-restore
   ```

   The destination's parent must already exist. An existing destination, symlinks,
   mixed sidecars, changed checksums, invalid manifests or regional mismatch fail.
   Partial backups cannot be used as verified backups. No existing file is replaced.
4. Before reopening writes, verify admin login, customers, appointments/versions,
   services, staff/assignments, business and agent configuration, encrypted Google
   grants/mappings, appointment history and notification history. Check isolation
   and decrypt grants with the original key. Never print token contents.
5. Preserve and reconcile appointment operation claims. Restore does not clear them.
   Reconcile original Google event IDs before reopening booking: restoring SQLite
   does not roll back external Google events, emails or post-backup changes.
6. Record the recovery point, elapsed recovery time and any lost/reconciled writes.
   Enabling the restored database, changing live writers, or changing phone routes
   requires separate approval. Keep originals and their sidecars intact.

Verification checksums apply before starting writers; normal application startup
and later writes change the restored copy. Keep the original backup untouched.
Do not make a raw main-file copy of a running WAL database.

## Validation and remaining release gates

- **34 focused tests passed**: 19 new backup/job cases, existing regional isolation,
  launch migration, authentication API and bootstrap configuration tests.
- The real SQLite rehearsal created synthetic MX/US databases using current
  migrations, kept writers open, backed up/restored them, verified stored entities
  and encrypted tokens, rejected the wrong decryption key, and logged in through
  the real Fastify API using restored owner credentials. Source main/WAL bytes
  stayed unchanged. No provider calls or production/customer data were used.
- Failure coverage includes uncommitted WAL exclusion, omitted/missing regions,
  wrong-region data, overwrite refusal, corruption, traversal/duplicate manifest
  entries, symlinks, mixed sidecars, partial backups and safe CLI errors.
- Job tests use a **restic stub** to exercise success/failure, explicit credential
  files and retention of local evidence. They do not prove actual encryption,
  off-host delivery, credentials, bandwidth or restore from the selected storage.
- Shell syntax passed. Backend/frontend typechecks and production build results
  are recorded in [project status](PROJECT_STATUS.md). No application behavior was
  changed; the full unrelated suite was not repeated.
- Linux unit validation, actual Node/runtime version, automatic restart, firewall,
  Access/Tunnel, hosted browser acceptance, monitoring delivery, hourly execution,
  off-host storage and recovery using independently retrieved keys remain pending.

Checkpoint 6 closes only after **DEPLOY-001 plus a successful restore from the
actual backup destination**. Then proceed to customer #1 onboarding and its own
acceptance checklist, with approval before switching its real line or merging main.

References: [Node SQLite online backup](https://nodejs.org/api/sqlite.html),
[restic repository/password configuration](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html),
[restic scheduling and failure codes](https://restic.readthedocs.io/en/stable/040_backup.html),
[existing migration/recovery procedure](MIGRATION_RECOVERY.md).
