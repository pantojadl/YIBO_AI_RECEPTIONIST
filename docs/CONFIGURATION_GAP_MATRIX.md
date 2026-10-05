# YIBO configuration and operations gap matrix

Verified against `codex/yibo-business-operations` after the REL-002 baseline.
This matrix distinguishes configuration that affects the runtime from controls
that merely exist in an administrative screen.

Status values: `EXPOSED_AND_USED`, `BACKEND_ONLY`, `FRONTEND_DISCONNECTED`,
`HARDCODED`, `MISSING`, `SECURITY_SENSITIVE_NOT_FOR_UI`.

| Area / setting | Source of truth and scope | Validation / API | Frontend | Runtime consumer | Status before this plan |
|---|---|---|---|---|---|
| Location hours, timezone and closures | Business profile, location | Versioned admin API and domain validation | Location settings | Scheduling | EXPOSED_AND_USED |
| Slot interval, lead time, horizon and result limit | Business profile, location | Versioned policy API | Location settings | Scheduling and phone tools | EXPOSED_AND_USED |
| Cancellation/reschedule notice | Business profile, location | Domain enforced | Location and appointment screens | Appointment service | EXPOSED_AND_USED |
| Same-day booking and allow/deny cancellation/reschedule | None | None | None | None | MISSING |
| Services, duration, buffer and active state | Business profile, tenant | Versioned CRUD | Catalog settings | Scheduling and tools | EXPOSED_AND_USED |
| Price and location offering | Business profile, location | Money validation and CRUD | Catalog settings | Appointment snapshot and service tool | EXPOSED_AND_USED |
| AI price disclosure | None | None | None | Tool currently always returns price | MISSING |
| Professionals, skills and weekly hours | Business profile, tenant/location | Versioned CRUD | Catalog settings | Scheduling | EXPOSED_AND_USED |
| Professional time off / exceptions | Location closures only | No professional exception model | None | None | MISSING |
| Calendar default / professional override | Business profile, location | Access verification and route guards | Calendar settings | Google adapter | EXPOSED_AND_USED |
| Transfer destination | Business profile, location | Validated admin API | Location settings | Transfer tool | EXPOSED_AND_USED |
| Model, voice, VAD, behavior and tool limits | Agent configuration, tenant | Capability validation and optimistic API | Agent settings | Realtime and tool policy | EXPOSED_AND_USED |
| AI book/reschedule/cancel/transfer permissions | Agent enabled tools, tenant/channel | Tool policy enforced | Agent settings | Tool executor | EXPOSED_AND_USED |
| AI describe services / collect email / quote price / after-hours policy | Partial prompt/tool behavior | No complete structured policy | None | Partial | FRONTEND_DISCONNECTED |
| Phone/DID to location mapping | Business profile, location | Trusted DID resolution | Location settings | Call orchestrator | EXPOSED_AND_USED |
| Asterisk/OpenAI/Google secrets | Environment / encrypted token store | Server startup and OAuth | Connection status only | Provider adapters | SECURITY_SENSITIVE_NOT_FOR_UI |
| Test mode | Trusted local Voice Lab context | Server-only authorization | Voice Lab | Isolated calendar/tools | EXPOSED_AND_USED |
| Live mode/readiness | Provider configuration only | No aggregate readiness contract | None | Startup | MISSING |
| Office agenda by range/status | Appointment repository only supports upcoming customer list | No operational range API | ID-based appointment screen | None | MISSING |
| Open slots on office calendar | Scheduling API | Availability endpoint | Single-day availability form | Scheduling | FRONTEND_DISCONNECTED |
| Manual booking by selected location | Appointment domain supports location | Legacy endpoint forces `default` | Basic form | Appointment service | FRONTEND_DISCONNECTED |
| Customer search and reusable profile | Customer repository by phone/id | Create-by-phone only | Create form | Phone identity | BACKEND_ONLY |
| Customer language, communication preference and source | None | None | None | None | MISSING |
| Appointment completed/no-show states and history | Four-state appointment row | No lifecycle API/history | None | None | MISSING |
| Confirmation/reschedule/cancellation email | None | None | None | None | MISSING |
| Notification delivery status | None | None | None | None | MISSING |
| Admin roles | Signed session with tenant_admin/operator | Endpoint guards | Two role views | API | EXPOSED_AND_USED |
| Owner/manager/secretary/read-only permissions | None | None | None | None | MISSING |
| Audit trail | Admin audit log, tenant | Mutations recorded | No timeline UI | Compliance only | BACKEND_ONLY |
| ARI reconnect/startup deadline | Process-local ARI client | HTTP controls bounded; websocket unbounded | Not applicable | Telephony ingress | BACKEND_ONLY |

## Implementation priorities

1. Add an office schedule API and calendar/agenda workspace using the existing
   Scheduling and Appointments services.
2. Expand customer profiles and provide tenant-scoped search/detail APIs.
3. Add lifecycle history and operational statuses to appointments.
4. Add event-driven notification delivery records and a configurable email
   sender without coupling appointment success to email success.
5. Add structured business capability flags and enforce them in domain/tool
   execution, then expose them in human-friendly settings.
6. Add readiness reporting and finer business-facing roles while keeping
   provider secrets server-only.
