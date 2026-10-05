# Product/UX — Model Configuration Pipeline

Completed September 24, 2026 on `codex/product-ux-improvements`, following
Checkpoint C. Commits `25eb2f4` and `904dc11` remain unchanged ancestors.

## Audit and design

The existing architecture already supplies tenant `AgentConfiguration` v4,
location/business configuration v2, admin-only APIs, SQLite persistence, versioned
writes, a shared agent factory for Phone/Voice Lab, compiled instructions, tool
permissions and a domain availability policy. These are the sources of truth.
There is no new configuration store, endpoint, migration or scheduling engine.

Booking/cancellation/rescheduling were already controlled by `enabledTools` and
channel policy. Language, phone readback, greeting, style, offer count and pacing
were already saved and consumed. The missing pieces were price disclosure and
optional location restrictions/presentation overrides. The UI now presents the
three appointment permissions and price disclosure as plain-language business
rules; existing advanced permissions and behavior controls remain available.

## Added fields

| Field | Default / supported values | UI | Runtime consumer |
|---|---|---|---|
| Agent `behavior.allowPriceDisclosure` | Missing → `true`; boolean only | AI agent → 04 Business rules → Tell callers service prices | `resolveBusinessAgentPolicy`, `AgentPromptCompiler`, `PriceDisclosureToolExecutor` |
| Location `agentOverrides` | Absent → inherit business rules; strict optional object with only the following four keys | Settings → Locations → AI rules at this location | `AgentDefinitionService` resolves the trusted tenant/location |
| `agentOverrides.disabledTools` | Absent/empty → no extra restrictions; unique subset of `create_appointment`, `cancel_appointment`, `reschedule_appointment` | Book / Cancel / Reschedule appointments: Use business setting or Block at this location | Effective tool list and `PolicyEnforcingToolExecutor`; blocked actions return `TOOL_DISABLED` before execution/confirmation |
| `agentOverrides.allowPriceDisclosure` | Absent/`true` → inherit business permission; `false` → withhold prices | Service price disclosure: Use business setting or Do not disclose prices here | Effective price permission is business AND location; same prompt/output consumers as above |
| `agentOverrides.phoneReadback` | Absent → business setting; `natural_grouped` or `digit_by_digit` | Phone number readback | Compiled instructions and existing `PhoneReadbackToolExecutor` output after a successful contact update |
| `agentOverrides.locale` | Absent → `identity.locale`; valid nonempty BCP 47 language tag (e.g. `en-US`, `es-MX`, `pt-BR`) | Agent language override; blank restores inheritance | Effective `AgentDefinition.locale` and compiled response-language instruction |

Removing every override removes the optional object. A newly copied inactive
location inherits business AI settings; copying booking policies does not copy
AI overrides. Invalid values, duplicate/unknown actions and unknown override keys
are rejected by the existing business validation before persistence.

Location price rules apply to the conversation serving that trusted location,
including all branch prices returned to that conversation. They do not change
office access, catalog prices, historical appointment prices or monetary values.

## Existing settings reused

Defaults below describe new/unconfigured businesses; existing saved values win.

| Existing field | Default / supported values | UI | Runtime consumer |
|---|---|---|---|
| `enabledTools` + `toolPolicies.channels.{phone,voice_lab}.enabledTools/toolChoice` | All eight public tools enabled, `auto`; choice `auto`/`required`/`none` | Business rules for three appointment actions; Other capabilities; Confirm for channel choice | `AgentDefinitionService` intersects business/channel/location permissions; `PolicyEnforcingToolExecutor` enforces actual execution |
| `identity.locale` | Initial business/default-location locale; saved value retained | Identity → Language and region (existing six language choices) | Effective definition and prompt; explicit location override takes precedence |
| `behavior.phoneReadback` | `natural_grouped`; or `digit_by_digit` | Silence → Phone readback | Prompt and successful contact-update presentation; stored customer number unchanged |
| Location `policies.availabilitySuggestions` | Missing → `{enabled:false, expansionDays:1, maximumAlternatives:3}`; boolean, integer 1–14 days, integer 1–5 alternatives | Settings → Locations → Availability suggestions | Existing scheduling search and `check_availability`; verified extra slots carry `outsideRequestedRange` |
| `behavior.slotOffering.maximumOptions/strategy` | `1` (1–5); `earliest_first` / `spread_across_day` / `match_requested_time` | Identity → Options per offer; Silence → Slot strategy | Compiled spoken-offer instruction; returned supplemental alternatives retain the existing separate location limit |
| `behavior.greeting` | `wait_for_caller`; or `automatic` with message | Silence → Greeting mode/message | Existing Realtime opening behavior and compiler |
| `behavior.responseStyle` | `brief`/`warm`/`balanced`; brevity brief/balanced/detailed, tone warm/professional/direct, pace slow/balanced/fast | Identity | Compiled speech/style instructions |
| `behavior.silence` | One prompt, localized default message; maxPrompts 0–3 and saved message | Silence | Existing Realtime idle handling and compiler |
| `toolPolicies.confirmations.requiredFor` | Empty; enabled mutating tools only | Confirm | Existing two-turn confirmation gate, now filtered to effective tools so a blocked action cannot ask for confirmation |

Business action switches reuse `setToolEnabled`: enabling adds that action to both
channels; disabling removes it and its per-tool limit/confirmation entry. Other
tools retain their settings. Channel status is shown on each switch; `none` still
blocks all tools. A location can only restrict actions, never grant a tool disabled
by the business/channel. If a location removes a phone channel's final tool,
`required` resolves to `auto` for that conversation instead of demanding an
impossible tool call. Existing disabled-channel behavior is unchanged.

## Persistence and runtime path

1. Tenant admin saves agent settings via existing `PUT /api/configuration` with
   an opaque `If-Match` revision. Location overrides use existing
   `PUT /api/admin/business-configuration` with its numeric `If-Match` version.
   Each form saves its own document; there is no cross-document transaction.
2. Authentication, trusted tenant selection, same-origin checks, audit, validation,
   CAS and stale-draft recovery remain on those existing paths.
3. `AgentDefinitionService.prepare` loads the tenant configuration and trusted
   active location, then `resolveBusinessAgentPolicy` builds the effective locale
   and behavior without changing the stored configuration. The trusted call
   context selects the location; caller text never selects or overrides it.
4. Compiled rules and permitted tools reach the existing Conversation/Realtime
   path. Tool calls pass through the effective confirmation and permission gates.
   When prices are disabled, `PriceDisclosureToolExecutor` removes nested `price`
   fields from successful public results before they reach the model, including
   catalog branches, upcoming appointments and booking confirmation. Failure
   semantics, confirmed flags, dates and domain snapshots are preserved.
5. Price/action/language/readback rules are snapshots for the **next conversation**.
   Active calls keep their prepared definition. Existing availability searches
   continue reading current location scheduling policies on each search.

Legacy agent documents normalize the missing price flag to `true` through the
existing upgrader. Locations without overrides retain their exact prior agent
behavior, even when their date/currency locale differs from the saved agent locale.
Schemas remain v4/v2; these are additive optional JSON fields.

## Teammate boundary and future integration

No Customer Profiles, customer search/dedup/history UI, customer preferred-language
storage, Email Notifications or delivery tracking was implemented or substantially
modified. Existing customer tools are used in focused tests, not redesigned.

This checkpoint needs no profile or notification data. `resolveBusinessAgentPolicy`
is the pure business-rule resolution seam for future integration. If verified
customer language is later added, supply it through a trusted application-owned
resolver/port after tenant-scoped identity verification; agree on precedence and
consent before implementation. Never let customer preferences or model arguments
enable blocked actions or prices. Notifications should continue using the existing
appointment lifecycle service/events; no notification hook is required here.

Read-only comparison with fetched `origin/codex/yibo-business-operations` identifies
shared-file overlap in `AgentConfigurationPanel.vue`, `LocationSettings.vue`,
`services/api.ts`, `theme.css`, `agent-definition-service.ts`, `agent-prompt-compiler.ts`,
`multi-location-business.ts`, `AGENT_CONFIGURATION_AND_CAPABILITIES.md`,
`CONFIGURATION_CATALOG.md` and `PROJECT_STATUS.md`. A future integrator must preserve
both changes in those files. No teammate branch was merged or modified.

## Validation and acceptance

**105 distinct focused tests passed, including 27 new tests**, in focused batches:

- 11 new runtime-policy tests: safe defaults, actual tool denial, both channels,
  effective confirmation rules, tenant/location isolation, no impossible required
  tool, locale/readback consumption, next-conversation snapshots and price/failure
  output handling.
- 15 new dashboard/API pipeline tests: persistence/reload, inheritance recovery,
  validation, permissions, stale versions, actual synthetic booking → list →
  reschedule → cancel, and preserved stored prices/event association.
- One new SQLite test closes/reopens a real temporary database, then checks saved
  rules, both tenant documents, CAS rejection and runtime consumption.
- 78 existing focused tests: agent configuration/definitions/compiler/phone
  readback/permissions/confirmation gates, admin APIs/conflicts, policy/location UI
  controllers, existing availability policy consumption and Realtime session payload.

Backend typecheck, frontend typecheck, production Vite build and `git diff --check`
passed. One exact-shape legacy test fixture was updated to include the new `true`
default. No full suite or real provider writes were needed.

Browser acceptance used the private synthetic localhost setup (dashboard 5380,
API 3112), with no Google/phone integration:

- All four business switches saved and survived a full reload, with correct
  Phone/Voice Lab status. Tested switches were restored afterward.
- All six location controls saved/reloaded for East Acceptance Clinic. Invalid
  language was rejected while retaining the draft; valid correction saved.
- The other location retained inheritance. Clearing overrides restored inheritance.
- Keyboard Tab reached the next rule; 390px viewport had 390px document width;
  mobile controls were visually inspected. A pre-existing theme rule forced the
  agent preview over the narrow form; a scoped responsive override now places it
  below the form. Desktop 1280px layout remains side by side. Viewport restored.

### Changed files

- Admin UI: `dashboard/src/components/AgentConfigurationPanel.vue`,
  `LocationAgentRules.vue` (new), `LocationSettings.vue`;
  `dashboard/src/services/api.ts`, `business-agent-controls.ts` (new),
  `location-editor.ts`; `dashboard/src/theme.css` (responsive correction only).
- Agent pipeline: `src/modules/agents/application/agent-configuration-defaults.ts`,
  `agent-definition-service.ts`, `agent-prompt-compiler.ts`, `contracts.ts`,
  `upgrade-agent-configuration.ts`, `business-agent-policy.ts` (new).
- Business model: `src/modules/business/domain/multi-location-business.ts`,
  `location-agent-overrides.ts` (new).
- Tests: `tests/agents/agent-configuration-service.test.ts`,
  `tests/agents/business-agent-policy.test.ts` (new),
  `tests/dashboard/business-agent-pipeline.test.ts` (new),
  `tests/fixtures/sqlite-business-agent-policy.ts` (new),
  `tests/integrations/sqlite-business-agent-policy.test.ts` (new).
- Documentation: this document (new), `docs/PROJECT_STATUS.md`,
  `docs/CONFIGURATION_CATALOG.md`, `docs/AGENT_CONFIGURATION_AND_CAPABILITIES.md`.

### Remaining acceptance / limits

- Follow-up [isolated Voice Lab acceptance](MODEL_CONFIGURATION_VOICE_ACCEPTANCE.md)
  ran seven real-model synthetic audio conversations, verified the saved business
  rules and corrected narrow completion/activity/date-guidance issues separately.
  Human microphone, readback cadence and browser barge-in checks remain pending.
  No live phone or Google operation was performed in that follow-up.
- Price filtering covers structured public `price` fields, not arbitrary free text
  in service descriptions, caller speech or custom instructions. Do not embed
  prices in an exact scripted greeting when disclosure is disabled. Saved custom
  greeting/silence messages are not automatically translated by a language override.
- Future tool changes must preserve the public price-field contract or extend the
  output guard. Admin/secretary appointment operations intentionally retain their
  existing authorization and are not restricted by AI tool permissions.
- No live Calendar/OAuth, Asterisk, ARI, Telnyx, routing, `main`, deployment or merge.

Recommended next step: finish the manual Voice Lab checks linked above, then agree
on the Appointments Calendar UI scope with the teammate before starting that product
checkpoint. No next checkpoint has been started.
