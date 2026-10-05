# Location administration — UI-005

Tenant administrators use **Settings → Locations** to select and edit a location.
The form covers name, active state, address, IANA time zone, locale, incoming phone
numbers, split weekly hours, local closures with administrative reasons, all
existing booking policy fields, and the human-transfer phone/extension.

Product Checkpoint C adds **Availability suggestions** to this same editor:
enabled (default off), search ahead (1–14 days, default 1), and maximum alternative
options (1–5, default 3). These edit the existing per-location policy consumed by
the agent and availability API, preserving validation and version/conflict checks.
The Availability screen's settings shortcut opens its selected location.
See [Checkpoint C](PRODUCT_UX_CHECKPOINT_C.md) for subsequent browser/test evidence.

New locations start inactive and copy the selected location's service offerings
and policies. They receive a new ID and do not copy phone numbers, professionals,
or calendar routes. Complete their assignments before activating them. Catalog
and professional administration belongs to UI-006; calendar mapping belongs to
UI-007. Neither task is implemented by this change. Remove phone numbers before
deactivating an existing location, as required by the existing domain contract.

Saving uses the existing authenticated business-configuration API with the loaded
version in If-Match. The editable payload excludes trusted tenant/region/business
identifiers and preserves untouched catalog, price, professional and calendar
fields. The backend remains the source of validation and audit logging.
The UI never silently retries a version conflict: it retains the draft, blocks
further saves and offers **Discard draft and load latest settings**. Copy edits
that should be retained before taking that explicit discard action. Navigation/unsaved-change protection is provided by UI-009; see `OPTIMISTIC_EDITING.md`.

Successful saves refresh displayed business information and clear stale
availability selections. They do not move existing appointments or restart
active calls. No domain, Calendar, Realtime, PBX or persistence implementation
changed. The old timezone-only backend endpoint remains available for compatibility.

## Validation

24 tests passed across six focused files: the new location editor (9), existing
admin session (3), multi-location domain validation (6), business configuration
API (2), scheduling policy API (2), and transfer destination API (2). The editor
tests drive the real authenticated API through an injected HTTP transport and
verify round-trip settings, untouched fields, version conflicts, invalid input,
new locations, duplicate numbers and operator denial.

Backend tsc, dashboard vue-tsc, and Vite production build passed. Installed package
executables were used directly, matching the package scripts. A full suite was
not rerun because this is dashboard-only behavior using existing backend contracts.
No live production data, phone calls, or Google Calendar events were changed.
Manual browser interaction was not exercised during this task.
