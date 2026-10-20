# Privacy data flow

Pilot scope: one inbound US number, one business, appointments only. No recording. No healthcare.

## What moves

| Data | Where it comes from | Where it goes | Stored? |
|---|---|---|---|
| Called number (DID) | Carrier → Asterisk dialplan → Stasis argument | SQLite `called_numbers`, used only to pick the tenant | Yes, as configuration |
| Caller number | SIP caller ID | Customer row, call row | Yes |
| Caller name | Spoken, then `update_customer` | Customer row | Yes, after the tool succeeds |
| Appointment time, service, staff | Tools, after a calendar check | SQLite appointments; Google Calendar if connected | Yes |
| Email | Only if the tool policy allows it | Customer row; Resend if configured | Optional, off unless configured |
| Call audio | RTP in memory, then the model provider if live mode is on | Not written by this application | No local recording |
| Transcript | Not a product feature in this build | — | No |
| Admin password | Operator | scrypt hash in SQLite | Hash only |
| Google refresh token | OAuth | SQLite, encrypted with `YIBO_TOKEN_ENCRYPTION_KEY` | Yes |
| OpenAI audio | Live runtime only | OpenAI, under their terms | Not in YIBO's database |
| Demo page text | Browser only | Nowhere. The script does not POST it | No |

## What the demo must not collect

Payment cards, government IDs, symptoms, diagnoses, insurance, or a recording. The prompt forbids asking for those. A live model can still misbehave; that is why ACCEPT-001 has to be heard by a person before a customer is live.

## Retention

There is no automatic purge job. For a pilot, the operator exports or deletes the regional SQLite file when the business leaves. Snapshot first (`pnpm db:snapshot`) if a copy is required, and keep the encryption key with the copy or the Google grant is unreadable.

Deleting the database deletes customers, appointments, and sessions. It does not delete a Google event that was already created. Cancel those in the test calendar first.

## Subprocessors, if the paid pilot is turned on

| Party | Role | Status |
|---|---|---|
| SIP carrier (not chosen) | Call delivery | Not contracted |
| OpenAI | Speech model | Not called in this branch |
| Google | Calendar | Optional, OAuth |
| Resend | Email | Optional, skipped if unset |
| Host (owner machine or a future VPS) | Disk and process | Demo is local Docker only |

International transfer: OpenAI and Google may process data outside the US. Do not turn them on for a customer until the owner accepts that.

## Incident

If a key leaks, revoke it at the provider, rotate `YIBO_TOKEN_ENCRYPTION_KEY` and `YIBO_ADMIN_SESSION_KEY` only with the owner's approval, and restore from a snapshot taken before the leak if the database was copied. Do not rotate a live key as part of this repository change. None was found in git during this work.

## Recording notice (draft, not in use)

"This call is not recorded." That is the true statement for this build. Do not publish a recording notice until recording exists and counsel has approved the states where it would run.
