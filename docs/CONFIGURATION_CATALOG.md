# Configuration catalog

Verified against repository code on 2026-09-19. This describes YIBO's supported
configuration, not an independent claim about current external provider capabilities.

## Process settings

| Setting | Current behavior / owner |
|---|---|
| `YIBO_TENANT_ID` | API and Voice Lab select a tenant from the bootstrap catalog; default `tenant-yibo-demo`. Profile determines region. US demo is `tenant-yibo-demo-us`. |
| `YIBO_REGION` | Historical local setting; current API/Voice Lab entry points do not independently read it to select a region. CLI uses explicit `--region`. |
| `YIBO_DATABASE_MX`, `YIBO_DATABASE_US` | Regional SQLite paths; default `data/yibo-mx.sqlite` and `data/yibo-us.sqlite` relative to process cwd. |
| `YIBO_RUNTIME` | `in-memory` default; `openai-realtime` requires `OPENAI_API_KEY`. In-memory is scripted, not a live voice model. |
| `OPENAI_API_KEY` | Secret for Realtime. `OPENAI_ADMIN_KEY` is a separate optional organization-cost credential. |
| `OPENAI_REALTIME_MODEL` | Initial model fallback; supported combinations come from the local capability registry and `/api/configuration`. Persisted settings take precedence for subsequent calls. |
| `YIBO_VOICE`, `YIBO_MAX_OUTPUT_TOKENS` | Parsed bootstrap defaults (marin / 512); output range 1–4096. These do not overwrite a persisted tenant configuration. |
| `YIBO_VAD_THRESHOLD`, `YIBO_VAD_PREFIX_PADDING_MS`, `YIBO_VAD_SILENCE_DURATION_MS` | Parsed bootstrap overrides; threshold 0–1, durations nonnegative integers. Use the agent editor for saved configuration. Configured startup forwards these via an explicit application config when supplied. |
| `YIBO_DASHBOARD_ORIGIN` | Default `http://localhost:5173`; exact HTTP(S) origin used for administrative mutations. No path/query/hash. |
| `YIBO_ADMIN_SESSION_KEY` | Stable secret for signed admin cookies; retain securely. Set it explicitly for deployment: the current bootstrap otherwise generates an ephemeral key, including in production, and sessions will not survive process/key changes. |
| `NODE_ENV` | Production enables Secure session cookies; serve the dashboard/API over HTTPS accordingly. |
| `PORT` | API port, default 3000; current entry point binds loopback `127.0.0.1`. |
| `DEV_VOICE_PORT` | Voice Lab service port, default 4317; loopback only. |
| `YIBO_LOCAL_DEVELOPER_TEST_MODE` | `1` authorizes isolated developer tools in local Voice Lab only; never normal phone tools. |
| `YIBO_VOICE_DEBUG` | `1` enables local harness diagnostics; avoid using debug output as production telemetry. |
| `RESEND_API_KEY`, `YIBO_EMAIL_FROM` | Optional transactional email provider and validated sender. Without both, appointment email is recorded as skipped and never blocks the appointment. |

Source: `src/bootstrap/configuration.ts`, `build-configured-application.ts`,
`src/main.ts`, `apps/dev-voice/server.ts`. API loads `.env` via dotenv; the package's
Voice Lab/admin commands use Node's `--env-file=.env`. `db:init` itself does not load
`.env`; export custom database paths in the invoking environment.

## Google Calendar

Provide `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and
`YIBO_TOKEN_ENCRYPTION_KEY` together, then connect OAuth for the tenant. The encryption
key must be 64 hexadecimal characters (32 bytes). Keep it with the protected backup
material: losing/changing it prevents decrypting stored tokens.

The configured bootstrap only constructs the Google integration when all four are
present; otherwise the default calendar adapter is in-memory. A healthy API therefore
does not prove Google is connected. Check connection status and an actual test event.

`GOOGLE_CALENDAR_ID` is a deprecated import into an empty default-location mapping,
not a global routing override. Saved professional calendar wins over saved location
default. Configure via [calendar administration](CALENDAR_ADMINISTRATION.md).

## Asterisk

`ASTERISK_ARI_URL`, `ASTERISK_ARI_APPLICATION`, `ASTERISK_ARI_USERNAME` and
`ASTERISK_ARI_PASSWORD` must all be present to enable ARI; all absent disables it,
a partial group fails startup. Supply `YIBO_ASTERISK_MEDIA_HOST` and integer
`YIBO_ASTERISK_MEDIA_PORT_START`/`END` in 1–65535, start ≤ end. Host must be a local
bindable interface reachable by the PBX. Restrict UDP to the PBX: RTP is unencrypted
and learns its first valid peer. Only the API process enables the integration.

There is no application Telnyx credential setting in this modern path. Carrier
trunk/dialplan configuration belongs to Asterisk deployment. Do not import legacy
phone-checkout settings into application configuration without checking ownership.

## Saved admin configuration

| Owner | Controls |
|---|---|
| Agent, schema/defaults v4 | Instructions, model/voice/VAD, behavior (including price disclosure, default true), tool/channel policy, confirmation gates, limits/retries/escalation. Saved per tenant; next conversation reads it. |
| Business, schema v2 | Active locations, DIDs, IANA zones, catalog, prices, professional/service assignments, hours/closures, booking policy, transfer destinations and optional location agent overrides (action restrictions, price disclosure, language, phone readback). |
| Calendar assignments | Professional override and location fallback; resolved from trusted call/location context. |
| Location operations | Same-day booking, cancellation/rescheduling, staff override, structured AI capabilities and after-hours behavior. |

Business writes use numeric version `If-Match`; agent writes use an opaque revision
`If-Match`. Schema version is not an edit revision. Defaults are defined in
`agent-configuration-defaults.ts`, not provider JSON or environment tuning after save.
PCM16 mono 24 kHz inside YIBO and PCMU 8 kHz at RTP are transport invariants.

See [Model Configuration Pipeline](MODEL_CONFIGURATION_PIPELINE.md) for every
added field/default/supported value, existing behavior controls, UI locations,
runtime consumers and the Customer Profiles/Notifications integration boundary.
Location overrides inherit when absent and cannot grant an action or price access
denied by the business/channel. They apply to new conversations; existing location
availability policies remain the scheduling source of truth.
