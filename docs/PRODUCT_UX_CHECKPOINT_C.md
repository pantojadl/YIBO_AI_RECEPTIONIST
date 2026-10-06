# Product/UX — Checkpoint C: Availability UI

Completed September 23, 2026 on `codex/product-ux-improvements`, after A/B
acceptance closure `25eb2f4`. Scope: the existing availability search and
Checkpoint A's existing per-location suggestion settings. No new scheduling
engine, configuration store, Calendar integration, or phone-route work.

## What the UI now does

- Select an active location, its offered service, and any or one eligible
  professional. Inactive/unassigned catalog entries are not search choices.
- Search a location-local date, optionally narrowing it to a start/end time on
  that date. Blank times search the whole day. Invalid/reversed/incomplete ranges
  produce an error. Whole-day ranges handle 23/25-hour daylight-saving days.
  Nonexistent or repeated local times are rejected with guidance rather than
  silently selecting a different instant; full-day search remains available.
- Show verified slots in two sections: **Within your requested period** and
  **Alternatives outside your requested period**. Every option shows its actual
  date, start/end time, zone abbreviation and professional. No automatic selection.
- Distinguish initial, searching, successful-empty, failed and populated states.
  Changing any filter clears results/selection; late responses cannot repopulate
  a newer search or a screen that has been left.
- Review and book a chosen slot for the current customer through the existing
  appointment API. Booking sends the selected location, service and exact slot
  instant. The domain revalidates it. Duplicate clicks and failures do not retry
  the mutation. Confirmed appointments open at the correct location for inspection.
- Tenant admins can jump to the selected location's settings and configure
  **Offer alternatives**, **Search ahead (1–14 days)** and **Maximum alternative
  options (1–5)**. Defaults remain off / 1 day / 3 alternatives. Settings use the
  existing versioned business API, validation, audit and conflict recovery.
  Copying a location now also copies nested policy values independently.

Suggestions remain the forward-only domain strategy from A. They supplement the
requested period and obey the same hours, assignments, capacity, booking limits
and Calendar conflict checks. Availability does not reserve a slot. Searching or
changing search filters does not save business configuration.

## Existing contracts extended

`GET /api/appointment-locations` adds an explicit operator-safe projection of
location services/durations/eligible professional IDs, professional names and the
effective suggestion policy. Existing fields and inactive locations remain for
appointment administration. Calendar IDs, closure reasons, transfer routes and
phone numbers are excluded. The search UI only offers active locations.

`POST /api/appointments` now accepts an optional validated `locationId`; omission
still means `default`. The existing authenticated tenant, operator role,
same-origin guard, domain service, Calendar adapter and mutation audit remain.
AI/phone tools still get their location from their trusted call context.

The browser consumes the existing `outsideRequestedRange` slot marker instead of
inventing alternatives. `GET /api/availability`, scheduling, rescheduling,
cancellation, Google event identity and configuration versions are unchanged.

## Validation

**67 distinct focused tests passed, including 28 new tests**, run in focused
batches. The final daylight-saving change reran the 24 availability tests.

| Test file | Passed |
|---|---:|
| `tests/dashboard/availability-search.test.ts` | 24 |
| `tests/dashboard/location-editor.test.ts` | 13 |
| `tests/dashboard/appointment-editor.test.ts` | 8 |
| `tests/integration/api-flow.test.ts` | 2 |
| `tests/integration/scheduling-policies-api.test.ts` | 4 |
| `tests/integrations/google-calendar-adapter.test.ts` | 8 |
| `tests/integrations/google-event-identity.test.ts` | 8 |

Backend `tsc --noEmit`, dashboard `vue-tsc --noEmit -p dashboard/tsconfig.json`,
production `vite build --config dashboard/vite.config.ts` and `git diff --check`
passed. Existing `../../node_modules/.bin/` executables were used. No full suite.

In the actual browser, using the private synthetic acceptance setup:

1. An unavailable evening shows next-day alternatives with correct dates/zones.
2. A second location filters service/provider choices and uses America/New_York.
   A 09:00–09:30 search shows one preferred slot and two labeled alternatives.
3. Selecting a 09:30 alternative displays its outside-period notice. Booking opens
   the correct location/professional/time and original USD 125.50 price.
4. That same appointment reschedules to 09:00 the next day and cancels successfully;
   its appointment ID remains unchanged. The synthetic booking was cleaned up.
5. Disabling suggestions produces a successful empty exact-period-only result;
   changed limits save and survive reload. Manage settings opens the chosen location.
6. Keyboard Enter selects a slot; changing the date clears selection/results.
   At 390px width, form/cards fit and document width stays 390px. Viewport restored.
7. A repeated local time during the autumn clock change shows the expected error;
   a normal search works immediately afterward.

## Limits and integration notes

- Browser verification used the isolated local calendar, not a new real Google
  write or phone call. Automated Google regressions use simulated provider responses.
  No live Calendar/OAuth, Asterisk, ARI, Telnyx, 7001 or main changes or deployment.
- Search preferences are local screen state. Returning from another screen requires
  another search. Slots can be taken before booking; the domain rechecks them.
- Existing appointment concurrency/version limitations remain; this checkpoint
  does not introduce appointment compare-and-swap or solve multioperator races.
- Shared dashboard/API files need review when integrating the teammate's branch;
  preserve its customer/business controls alongside this location-aware search.
  Fetched overlap includes `App.vue`, `LocationSettings.vue`, `services/api.ts`,
  `src/api/routes/appointments.ts` and `PROJECT_STATUS.md`. No teammate work was
  merged or modified.

Next proposed product checkpoint: Model Configuration Pipeline. It and the
Appointments Calendar redesign have not been started.
