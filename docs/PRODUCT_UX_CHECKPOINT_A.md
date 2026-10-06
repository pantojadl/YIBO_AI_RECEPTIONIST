# Product/UX — Checkpoint A

Completed September 23, 2026 on `codex/product-ux-improvements`, based on
integration commit `46ce713`. This branch is separate from phone-route work and
`codex/yibo-business-operations`.

## Configuration and defaults

| Source of truth / field | Effective default | Allowed values |
|---|---|---|
| Business `locations[].policies.availabilitySuggestions.enabled` | `false` | Boolean |
| Business `locations[].policies.availabilitySuggestions.expansionDays` | `1` | Integer 1–14 |
| Business `locations[].policies.availabilitySuggestions.maximumAlternatives` | `3` | Integer 1–5 |
| Agent `behavior.phoneReadback` | `natural_grouped` | `natural_grouped`, `digit_by_digit` |
| Business `displayCurrency` | `USD` | `USD`, `MXN`, `EUR` |

An omitted availability policy uses `DEFAULT_AVAILABILITY_SUGGESTIONS` and leaves
exact-range results unchanged. When adding the policy, supply all three fields:

```json
"availabilitySuggestions": {
  "enabled": true,
  "expansionDays": 1,
  "maximumAlternatives": 3
}
```

Configure it through the existing tenant-admin business-configuration API or location
policy API, preserving the current document and its `If-Match` version. There is no
new availability screen in this checkpoint. Agent configuration retains its existing
revision checks; old documents receive grouped readback through the existing upgrader.
There is no schema migration, additional configuration store, or environment switch.

## Availability suggestions

`SchedulingServiceImpl.findAvailableSlots` first runs the existing exact-range
search. With expansion enabled, fewer preferred results than `maximumAlternatives`
triggers one additional forward search from the requested end, bounded by
`expansionDays` (24-hour periods). It adds up to `maximumAlternatives` results, also
subject to the existing per-search location result cap. Preferred results remain
first. Alternatives carry `outsideRequestedRange: true`; `requestedPeriod` is unchanged.
The normal requested-result limit and alternative limit apply to their respective
searches; a zero query limit disables both.

Both searches reuse service/professional assignments, tenant/location selection,
lead time, booking horizon, hours, closures, capacity and Calendar conflict checks.
Provider failures remain errors rather than fabricated suggestions. No appointment
is selected or booked automatically. The first strategy is deliberately forward-only;
additional strategies can reuse `findWithinRange` without changing its constraints.

Consumers: the existing availability API and AI `check_availability` tool call the
same scheduling service. The agent prompt explicitly distinguishes alternatives,
prioritizes the requested period, and permits returning the verified supplemental
options even when the normal conversational option limit is lower. Booking validation
and confirmation gates are unchanged.

## Phone readback

Agent Settings includes **Phone readback**. `formatPhoneReadback` formats presentation
only: grouped `915, 555, 1234`, or separate `9 1 5 5 5 5 1 2 3 4` digits. Country codes
and all digits are retained. Ten-digit numbers and +1/+52 prefixes use familiar groups;
other lengths use groups of three without inferring a country code.

`AgentDefinitionService` supplies the setting to the prompt and wraps the approved
tool executor with `PhoneReadbackToolExecutor`. Only a successful `update_customer`
gets an additional `phoneReadback` field derived from the validated caller input.
Failed updates do not generate a readback. The original tool arguments, customer
normalization/storage and authorization/confirmation wrappers remain unchanged.
The same definition path is used for phone and Voice Lab sessions. Manual speech
acceptance was subsequently reported passed; see [A/B acceptance](PRODUCT_UX_AB_ACCEPTANCE.md).

## Currency presentation

Catalogs now includes **Edit currency**, a currency preview, explicit currency-code
price labels and a configurable default for new offering prices. The setting saves
through the existing versioned business API. `money-presentation.ts` consumes it;
`money.ts` owns the initial supported choices so the list can be extended centrally.

**This is not a currency conversion feature.** Existing service Money values,
appointment price snapshots and provider billing already have a denomination. Their
recorded currency always wins. Changing the default to EUR does not turn an existing
MXN 125.50 price into EUR 125.50. It changes currency-unspecified presentation and
the initial currency selection for new prices. New unspecified prices default to USD,
including on existing MX installations; already recorded MXN prices remain MXN.

## Validation

**136 tests passed across 11 focused files**, including 27 added cases:

- Scheduling service: disabled/default behavior, preferred ordering, empty/limited
  results, bounded expansion, alternative cap, conflicts, booking horizon, tenant
  isolation, provider failure and invalid policy values.
- Phone readback: both styles, country codes, prepared-call instructions/tool output,
  default upgrade, invalid values, tenant isolation and failed updates.
- Currency/catalog editor: USD/MXN/EUR formatting and versioned save/reload,
  unchanged existing prices, unsupported currency and role restrictions.
- Business configuration API: saved policy consumed by the real AI tool, with stale
  version rejection. Location-policy API round-trips expansion settings through
  existing edits, rejects malformed blocks and preserves version protection.
  Existing tool, agent definition/prompt/configuration and Google
  adapter regressions also pass.

Executed files:

```text
tests/scheduling/scheduling-service.test.ts
tests/agents/phone-readback.test.ts
tests/dashboard/catalog-editor.test.ts
tests/dashboard/money-presentation.test.ts
tests/agents/agent-definition-service.test.ts
tests/agents/agent-prompt-compiler.test.ts
tests/agents/tool-executor.test.ts
tests/agents/agent-configuration-service.test.ts
tests/integration/business-configuration-api.test.ts
tests/integration/scheduling-policies-api.test.ts
tests/integrations/google-calendar-adapter.test.ts
```

Backend `tsc --noEmit`, frontend `vue-tsc --noEmit -p dashboard/tsconfig.json`,
production `vite build --config dashboard/vite.config.ts` and `git diff --check`
passed. The full suite and live external-provider calls were not run for this change.

## Manual acceptance and integration risks

**Acceptance complete, September 23, 2026.** Browser checks and the user's manual
Voice Lab pass are recorded in [A/B acceptance](PRODUCT_UX_AB_ACCEPTANCE.md).
The following checklist is retained as the procedure used; teammate integration
remains a separate task.

1. In a separate development environment, enable expansion for a location, ask for
   a narrow unavailable period, and verify that the model labels alternatives and
   still prioritizes any preferred slots. Check disabling restores exact-range behavior.
2. In Voice Lab, compare both readback settings with a synthetic ten-digit number
   and +1/+52 numbers. Confirm intelligibility, country-code preservation and no
   extra confirmation loop. Automated tests prove configuration consumption, not speech.
3. In Catalogs, save each currency, reload, open a new offering, and check its default
   currency. Verify existing differently denominated offerings/bookings remain unchanged.
   Check conflict handling in two tabs and the agent-setting dropdown visually.

Known overlap with the fetched teammate branch: `AgentConfigurationPanel.vue`,
`dashboard/src/services/api.ts`, `agent-definition-service.ts`, `agent-prompt-compiler.ts`,
`multi-location-business.ts` and `PROJECT_STATUS.md`. A future integration must preserve
that branch's booking/locale controls alongside these additions. Nothing was merged,
rebased, or copied from the teammate branch, and its live preview path is not validated here.

Recommended Checkpoint B: manual product acceptance of these three controls and
agreement on their integration with the teammate branch. Do not start Recent Activity,
test-session lifecycle, automatic completion, availability UI, configuration-pipeline
work, calendar redesign or phone-route diagnosis without a new assigned scope.
