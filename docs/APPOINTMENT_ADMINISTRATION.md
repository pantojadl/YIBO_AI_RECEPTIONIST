# Appointment administration — UI-008

**Current front-desk UI:** the Product/UX
[Appointments Calendar checkpoint](PRODUCT_UX_APPOINTMENTS_CALENDAR.md) replaces
ID-based navigation with day/week/agenda views and inline manual booking. It reuses
the editor and mutation contracts below and adds a bounded all-customer calendar
read. The following UI-008 implementation/validation record is historical.

Operators and tenant administrators use **Appointments** to select a location,
list a customer's upcoming confirmed appointments by customer ID, or look up an
appointment by ID. The existing customer creation flow supplies the current
customer ID, and a newly created appointment opens automatically for inspection.
The existing domain supports a per-customer upcoming list, not a general customer
directory or all-history search; cancelled/past appointments remain accessible by ID.

Details show location/time zone, customer/professional identifiers, the historical
service name and price captured at booking, start/end time and current status.
Current catalog prices do not replace historical snapshots. Times and reschedule
date searches use the selected location's time zone rather than the browser's zone.

## Operations and existing contracts

- Cancellation requires an explicit confirmation in the page.
- Rescheduling searches available slots for the appointment's current service and
  professional at its location. The admin selects a slot and confirms the move.
- Both operations call the existing appointment domain service. Notice policies,
  current appointment state, slot validation, calendar ownership/event identity,
  calendar failures and repository updates remain in that service.
- Success appears only after the mutation returns successfully. Failures retain the
  displayed appointment, show a safe error, and clear the pending confirmation and
  proposed slots. No mutation is automatically retried. On an uncertain calendar
  outcome, refresh and verify with staff before retrying.
- Switching locations clears selected details, slots and pending actions. Busy
  requests disable forms and duplicate submissions.

New thin HTTP adapters expose:

- `GET /api/appointment-locations` — safe location names/time zones/notice policies;
  Checkpoint C also adds offered services, eligible professional choices and the
  effective availability-suggestion policy.
- `GET /api/locations/:locationId/appointments?customerId=...` — existing upcoming list.
- `GET /api/locations/:locationId/appointments/:appointmentId` — scoped lookup.
- `POST /api/locations/:locationId/appointments/:appointmentId/cancel` — empty JSON body.
- `POST /api/locations/:locationId/appointments/:appointmentId/reschedule` — `startAt` only.

The existing availability endpoint accepts an optional location ID; omission still
uses `default`. Checkpoint C also adds optional `locationId` to appointment creation;
omission preserves default-location booking. Newly created appointments open at
their booked location. The legacy lookup endpoint is unchanged. Endpoints reuse the operator role guard,
authenticated tenant, same-origin protection and redacted mutation auditing.
Location IDs are admin selections within the authenticated tenant; they do not
change AI/telephone trusted-context rules. Extra mutation fields and tenant
selectors are rejected.

Configuration version/CAS contracts remain unchanged. Appointments currently have
no version field or conditional-write contract; UI-008 does not invent one or claim
multi-tab appointment conflict protection. The domain revalidates operations at
execution. UI-009 adds leave protection for pending confirmations; appointment domain concurrency is unchanged. No changes were made to the
appointment domain, Google adapters, routing resolver, telephony or Realtime.

## Validation — 2026-09-17

Eight new tests exercise the editor through the real authenticated API with an
operator session, including multi-location isolation, historical snapshots,
reschedule then cancel with retained event ID, notice policies, lost slots,
calendar failure, authentication/origin/trusted-field rejection, malformed query
selectors, state clearing and local time display. Focused suite: 31 tests passed.

Because this task adds API adapters, the full suite was run: **374 passed, 1 optional
live test skipped**, across 66 passing test files. Both backend and dashboard
typechecks and Vite production build passed using the installed executables
matching package scripts. No real Google events or customer data were changed.

Manual browser/live-provider checks remain: with a test customer, inspect a booked
appointment, verify its stored price and location-local time, reschedule to an
available slot, cancel, and confirm Google retains one event through rescheduling
and removes it on cancellation. Check policy rejection and operator/admin access.
CLOSE-002 now blocks mapping changes that would change an uncancelled booking’s
effective calendar; see `BOOKED_CALENDAR_ROUTES.md`. It cannot repair mappings
changed before this protection was deployed. UI-009 is now complete; see `OPTIMISTIC_EDITING.md`.
