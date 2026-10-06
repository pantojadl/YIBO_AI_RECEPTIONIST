# Launch phone acceptance — isolated setup and proposed 7001 route

27 September 2026. **Setup prepared; routing not applied; real call not performed.**
The approved permission repair is complete. This proposal requires separate user
approval because it changes extension 7001 and connects the isolated ARI application.
The earlier approval covered the file-group repair and module load only.

## Prepared setup

| Item | Verified state |
|---|---|
| Source | `codex/yibo-launch-candidate`, code `7a818be` (documentation commits since the validated runtime) |
| Private directory | `/private/tmp/yibo-launch-phone-7shsi4jf`, mode `0700`; environment, database and evidence files `0600` |
| API | `127.0.0.1:3114`, running in **standby**, no ARI connection or provider requests |
| Older processes | Existing API 3000, Voice Lab 4317 and acceptance 3101/5274 retain their original PIDs/listeners |
| ARI application, when separately approved | `yibo-accept001-isolated` |
| Media, when a call arrives | Private Mac interface, UDP **50500–50509**; all ten ports successfully bound and released without sending packets |
| Working media configuration | **40000–40020**, unchanged and separate |
| Database | Fresh synthetic US database, migration 11; zero customers, appointments, calls and operation claims at preparation |
| Clinic | YIBO Isolated Test Clinic; one 30-minute consultation, Dr. Alex; English, America/Chicago; Monday–Friday 09:00–18:00 |
| Calendar | Existing **YIBO Test Appointments** mapping from the completed real-Google gate |
| Authorization copy | Existing verified test grant read from the private test database in read-only mode, re-encrypted into this fresh store; source token row and source environment unchanged |
| Agent | Current configuration defaults v4: `gpt-realtime-2.1`, `marin`, wait for caller, existing confirmation/contact/turn-taking rules |
| Email | Delivery disabled; no notification-provider secret copied |

Only required provider credentials were copied privately. New local session and
encryption keys protect the isolated setup. No live business/customer database was
copied, and no credentials or private artifacts enter Git.

The private launcher imports the current configured application and API directly;
repository runtime code is unchanged. Standby denies outbound provider requests.
Enabling ARI additionally requires an explicit flag and a separately recorded
approval in its private manifest. The harness constrains Google requests to the
verified test calendar and event writes to this run's synthetic appointment IDs;
event summaries begin `[YIBO TEST] ACCEPT-001`. Provider adapters and scheduling
logic remain the actual application implementations.

The existing registered port-3101 callback value is retained in the private copy;
the copied grant is used directly. No new OAuth flow is started by this setup. If
fresh consent becomes necessary, stop to review callback routing rather than using
the older acceptance process as this new API's callback.

## Current PBX evidence

Read-only inspection at **18:35:54 UTC** verified:

- `/etc/asterisk/extensions.conf` remains `root:asterisk 0640`, SHA-256
  `4b2db3c0432dd74437e97d9b4b2e8248aa0578de6b37a801975f220624eba204`.
- `pbx_config.so` is Running. Loaded 7001 and public contexts match the preserved
  baseline. Zero active calls/channels; 7001 still targets normal `yibo`.
- Endpoint `yibo-audio-test` uses `from-yibo-test` and has one registered contact.
  Its reported state is `NonQual`; registration alone does not verify media or
  successful dialing.
- At **18:36:39 UTC**, all four ARI inventory reads returned HTTP 200, with zero
  applications/channels/bridges. Standby did not register an ARI application.
  The normal `yibo` application was not started or restarted.

## Exact proposed change

In `/etc/asterisk/extensions.conf`, **7001 in `[from-yibo-test]` only**:

```diff
- same => n,Stasis(yibo,+15125550100)
+ same => n,Stasis(yibo-accept001-isolated,+15125550100)
```

The complete current file and candidate are stored privately beside the launcher.
Local validation proves a single changed line, exactly the application argument
above; the rest of the file is byte-identical. Candidate SHA-256:
`760d7f353290ecb74872119914d07c25c6312d90aea1c758bff25969d3fc404b`.
No candidate file has been written to the PBX.

### Execution after explicit approval

1. Recheck the file hash/metadata, Running module, private port ownership and both
   contexts. Require no active PBX call/channel; stop if another operator changed
   the reviewed baseline. Record current application inventory and Asterisk PID.
2. Create a new private timestamped PBX backup with `cp -a`, metadata, hashes and
   loaded test/public snapshots. Verify **root:asterisk 0640** in the new backup;
   preserve the older backups too.
3. Restart only this private standby process with its isolated ARI mode enabled.
   Verify the exact `yibo-accept001-isolated` registration and loopback API health;
   preserve other registered applications. Do not start/restart normal `yibo`.
4. Apply the reviewed one-line change preserving owner/group/mode. Before reload,
   verify the candidate hash and exact diff, unchanged public context text and
   unchanged file syntax except for the Stasis application argument. This is not
   a claim that Asterisk has already parsed the candidate.
5. Run **`asterisk -rx 'dialplan reload'` only**. No restart, global reload, module
   unload, SIP/trunk change, Telnyx change or other PBX configuration edit.
6. Verify the loaded 7001 context equals its baseline except for the approved app
   argument, the loaded public context matches its original snapshot exactly,
   file hash/metadata match the candidate, Asterisk PID is unchanged and ARI/API
   remain healthy. Confirm no unexpected channels/bridges or listener overlap.
7. On any failed check, restore the **new metadata-preserving backup** and reload
   only the dialplan; verify original 7001/public contexts and readability. Stop
   the isolated app and report. Do not restore the old unreadable `root:root`
   metadata or broaden the change to production routing.
8. Only after all checks pass, tell the user 7001 is ready. Wait for their actual
   Linphone call; do not originate or simulate it.

These steps leave the public DID rules on normal `yibo`. Asterisk reload still
parses the full file, so the public-context comparison and rollback are mandatory.
Bidirectional PBX-to-Mac RTP remains a real-call acceptance requirement.

## Validation completed

- Fresh private bootstrap/migration, current agent defaults, test-calendar routing,
  encrypted grant copy equality, empty data/claim tables and unchanged source data.
- Standby `/api/health` **200** and unauthenticated admin readiness **401**.
- Ten private UDP ports bindable and closed after the probe; no packets sent.
- Read-only PBX module/routes/metadata/endpoint and ARI inventories above.
- **29 focused tests passed across four files**:
  `asterisk-modern-call`, `phone-operations`, `asterisk-ari-client`, and
  `asterisk-rtp-voice-media-gateway`. These use synthetic provider boundaries/local
  UDP; they are not a real call. Coverage includes normal lifecycle, booking,
  provider failures, repeated reschedule/cancel identity, double-booking prevention,
  early/duplicate hangup, startup failure, media cleanup and port reuse.
- No application code change; previously green typechecks/build and the 679-pass
  baseline remain the code evidence. No full-suite rerun was needed.

## Human test after the route is ready

Use the existing Linphone test account to dial **7001**, and speak first because
the current saved greeting behavior waits for the caller:

1. “Hello. I would like to book a test consultation with Dr. Alex on the next
   weekday morning.” Use synthetic name **Alex Test** and synthetic telephone
   **+1 915 555 0123** when asked. Confirm contact details when YIBO reads them back.
2. Select an offered time. Check that YIBO gives one clear success confirmation
   after Calendar succeeds, in the clinic's **America/Chicago** time zone.
3. “Please move that appointment to another available time that morning.” Confirm
   the offered change; then ask to cancel the same test appointment.
4. “That is everything. Thank you. Goodbye.” Let YIBO finish and end the call.

Observe natural pauses, interruptions/barge-in, repeated questions and the entire
goodbye. Private existing operational logs plus local appointment revisions and
owned Google event reads will establish tool/provider outcomes and cleanup. Do not
assume spoken wording from a tool success or record a synthetic call as human
acceptance. No audio recording is enabled by this preparation.

Afterward verify original event identity, no duplicates, cancellation/removal,
terminal call state, zero residual channels/bridges and released RTP ports. Clean
up only this run's labeled events after verifying ownership. If the user does not
exercise reschedule/cancel, record those phone scenarios as untested even though
the separate Google gate passed them.
