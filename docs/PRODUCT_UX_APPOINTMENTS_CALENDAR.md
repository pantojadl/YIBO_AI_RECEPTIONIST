# Appointments Calendar UI

Product checkpoint on `codex/product-ux-improvements`, September 24, 2026.
The user accepted the remaining Model Configuration Voice Lab manual checks for
now and explicitly authorized this checkpoint. Commits through `7510f7a` are retained.

## Scope and reuse audit

The existing UI-008 editor looked up appointments by customer/appointment ID.
Checkpoint C already provided location-local availability, eligible staff/service
selection, and booking. The appointment domain already owns booking validation,
location capacity, notice policies, Calendar writes, and persisted event identity.
The missing piece was a bounded, all-customer calendar read.

This checkpoint adds the front-desk calendar and a small read projection over the
existing appointment repositories. It does not introduce a second booking engine,
customer directory, availability store, provider adapter, or configuration system.

## Office workflow

- **Appointments → Day / Week / Agenda**: Monday–Sunday week and weekly agenda,
  date picker, previous/next period, Today and Refresh. Times always use the chosen
  location's timezone, including daylight-saving transitions.
- **Location / Staff member**: all staff by default; names and staff color markers
  appear on each booking. Inactive locations and historical staff remain readable.
  Confirmed, pending and failed bookings are shown; **Show cancelled** includes
  cancelled history. Pending/failed records say that they need review.
- **New appointment**, or **Find available times** on a day: reuse the existing
  availability search with that location/date/staff preference. Choose service,
  professional and an exact available time, review the customer and time, then book.
  Service duration, buffers, business/staff hours, closures, capacity, lead time,
  horizon, assignments, Calendar busy intervals and location policies still come
  from the existing services. A displayed time is not a reservation.
- **Customer** in the booking window uses the existing phone-based find-or-create
  action. An existing customer's saved name/normalized phone are retained. A new
  phone can create a customer using the entered name. No customer ID is required
  and the selected time is retained while choosing the customer.
- Open a booking to see customer/staff names, local start/end time, historical
  price/service and status. **Reschedule** retains its location, service, staff
  and event ID; choose a verified slot and explicitly confirm. **Cancel** also
  requires explicit confirmation and obeys the existing notice policy.
- Failures never claim success or automatically retry a mutation. Busy controls
  and consumed selections prevent duplicate submissions. Refreshed lists show
  the result; stale responses cannot replace another date/location's calendar.
- Native dialogs contain keyboard focus and block background interactions.
  Compact layouts stack days/cards, filters and booking controls.

## API and data contract

`GET /api/locations/:locationId/appointment-calendar?rangeStart=...&rangeEnd=...`
requires the existing operator/admin session. Both timestamps require explicit
timezones; the period must be positive and at most 31 elapsed days. The UI requests
one day or seven local days. Unknown/duplicate query fields and tenant selectors
are rejected.

The existing appointment application service validates the period and location,
normalizes bounds to UTC and calls `AppointmentRepository.findInRange`.
SQLite includes region, tenant and location in the query; in-memory storage uses
the same tenant/location contract. Overlap is half-open
(`appointment.start < rangeEnd && appointment.end > rangeStart`), so overnight
bookings remain visible. All matching rows and statuses are returned, sorted by
start time then ID; no availability-result cap silently truncates appointments.

Each entry retains the appointment's stored values and adds `customerName?`,
`customerPhone?` through the existing tenant-scoped `CustomerReader.get`, plus
`professionalName` from the existing business configuration. Missing labels do
not hide a record. No email, customer history or profile write is introduced.

Existing creation/lookup/reschedule/cancel endpoints and Google adapters are
unchanged. Configuration version/CAS and calendar-route protection remain intact.
AI tool permissions still apply to AI channels; office operators use their existing
authorization and scheduling/notice policies.

## Teammate integration boundary

No Customer Profiles or Email Notifications implementation is changed. The small
`booking-customer.ts` selection hook and `customerSelected` component event can
accept a future teammate-owned picker without changing scheduling. Shared files
that may need ordinary conflict review later: `App.vue`, `services/api.ts`,
appointment contracts/service/routes/repositories, and `PROJECT_STATUS.md`.
No teammate branch is merged.

## Verification

- Focused automated checks: initial **118 passed** across ten files; final UI
  follow-up **48 passed** after one added staff/service handoff regression.
  **119 distinct checks** cover calendar read isolation/bounds/history/snapshots,
  SQLite region isolation, DST/week navigation, stale responses, customer handoff,
  booking, double submission, capacity races, policy refusal, failed Calendar
  operations, repeated reschedules, original event IDs, neighbour preservation,
  cancellation and booked-calendar routing guards.
- Backend `tsc --noEmit`, frontend `vue-tsc --noEmit -p dashboard/tsconfig.json`,
  and `vite build --config dashboard/vite.config.ts`: passed.
- Browser acceptance uses only the existing synthetic setup: dashboard 5380, API
  3112, private SQLite, local calendar adapter. Only that API process was restarted
  to load the new read endpoint. No live Google credentials, phone service, Asterisk,
  ARI, 7001, routing, OAuth or main changes.
- Browser acceptance passed: new synthetic customer + Monday September 28
  09:00–09:30 America/Chicago booking; move to Tuesday September 29 10:30–11:00;
  dismiss a cancellation review without cancelling, then explicitly cancel.
  A separate authenticated page retrieved the persisted appointment. API checks
  at each stage found exactly one test record with the same appointment/event ID.
  The released 10:30 time was offered again after cancellation.
- Day/week/agenda, staff filters, cancelled history, location switch/reset and
  America/New_York versus America/Chicago labels passed. Mobile agenda, details
  and booking dialog were inspected at 390 px with no horizontal overflow;
  desktop layout was checked at 1440 px. Secondary form buttons were enlarged
  to 44 px touch targets. Old success messages clear when changing calendar filters.
- Only the synthetic test booking was cancelled; pre-existing synthetic history
  remains. No active appointment from this checkpoint remains.

## Limits and next checkpoint

- The calendar shows appointments recorded in YIBO. Other Google events still
  block availability through the existing adapter; they are not imported as YIBO
  appointment/customer records.
- Availability results retain the existing configurable search limit. Staff can
  narrow the date, professional or preferred time range to see later options.
- No drag/drop, recurring appointments, month view, customer directory or email
  delivery is added. Rescheduling keeps the same service/professional, as supported
  by the existing mutation contract.
- Appointments still have no revision/conditional-write contract. Existing
  single-process capacity serialization and provider ownership/ETag protection
  are retained; this checkpoint does not claim new multi-process or multi-tab
  appointment conflict guarantees.
- A real Google-backed front-desk create/reschedule/cancel smoke test remains
  manual before rollout. The Google adapter's focused tests passed; the local
  browser test does not substitute for a live-provider test.

Recommended next checkpoint: **Appointment edit conflict protection**—design
version-aware changes for concurrent office users, including cancellation versus
rescheduling. Coordinate the contracts with the teammate, without implementing
their profiles or notifications. Do not start automatically.
