# ACCEPT-001 — launch candidate phone preflight

**BLOCKED / real call not performed — updated 27 September 2026.**
RISK-001 is complete (`3046c82`), and real Google acceptance is complete
([evidence](LAUNCH_GOOGLE_ACCEPTANCE.md), `a437ea2`). The ordered next gate is the
real isolated phone call. Deployment/restore and pilot onboarding have not begun.

## Current result — approved reconnect and dialplan recovery

The user explicitly approved reconnecting the existing Tailscale profile. On
September 27, `tailscale up` with no flags returned success: backend Running, Mac
online, private address restored and PBX traffic through the VPN interface.
At 18:07:27 UTC all four ARI reads returned HTTP 200; SSH also worked. No saved
Tailscale settings were changed.

Read-only diagnosis reproduced the next blocker: Asterisk runs as `asterisk`, but
`/etc/asterisk/extensions.conf` was `root:root 0640` and unreadable by that user.
At that inspection `pbx_config.so` was Not Running and both required contexts were
absent from memory. File contents exactly matched the rollback
backup, which includes the original `yibo` destinations. Zero active calls,
channels, bridges and ARI applications were reported.

The user then explicitly approved the exact
[permission repair and module load](PBX_DIALPLAN_RECOVERY_PROPOSAL.md).
It passed at **18:21:53 UTC**: verified metadata-preserving backup, file group
changed to `asterisk` with root owner/0640 mode/contents preserved, service read
access restored, and the previously inactive module loaded once. Both loaded
contexts match the September 23 snapshots, including 7001 and the explicit public
rules targeting normal `yibo`. Asterisk's PID stayed unchanged; no restart,
global reload or routing edit occurred.

At **18:22:28 UTC**, all four ARI reads again returned HTTP 200 with zero channels,
bridges and registered applications. No working YIBO process was started or
restarted. The baseline dialplan is restored; isolated ingress and real audio
remain untested. The earlier temporary environment was missing; a fresh private
setup has now been prepared as described below.

## Isolated setup prepared — awaiting separate routing approval

The launch code now runs in a new private **standby API on 3114**, with fresh
synthetic SQLite, copied/re-encrypted test-calendar authorization, current agent
defaults and email delivery disabled. No ARI connection or provider request occurs
in standby. Older processes on 3000, 4317 and 3101/5274 retain their PIDs/listeners.
All ten private UDP ports **50500–50509** were bindable and released; this does not
prove remote RTP delivery. Existing working configuration 40000–40020 is unchanged.

Read-only PBX inspection reconfirmed module/readability and unchanged loaded
contexts, with a registered contact for the existing `yibo-audio-test` endpoint.
The exact one-line 7001 candidate was prepared **locally only**. Health/auth checks
and **29 focused phone/ARI/media tests** passed. No real call or new Google write
was performed. [Reviewed change, rollback, evidence and human test script](LAUNCH_ISOLATED_PHONE_ROUTE_PROPOSAL.md).

## Historical read-only evidence — September 26

- Attempted SSH to the previously configured PBX with batch authentication,
  strict existing host-key verification and an 8-second connection deadline.
  Connection timed out before any remote command ran. The requested commands were
  read-only dialplan displays and active-channel count, with no reload/restart.
- At **17:28:41 UTC**, attempted the exact ARI endpoints used by the current client:
  `GET /ari/asterisk/info`, `/ari/applications`, `/ari/channels`, `/ari/bridges`.
  All four timed out after 6 seconds. Credentials were read privately; no headers,
  secrets, endpoint payloads, caller identifiers or recordings were displayed.
- No websocket subscription, call originate, channel/bridge/media operation,
  service start/restart, configuration edit or dialplan reload occurred.
- Therefore current loaded routes, active calls and media reachability **cannot
  be verified from this Mac**. These timeouts do not establish that the phone
  service is down, nor distinguish an offline PBX from a network/firewall issue.

The last recorded routing attempt restored 7001 and verified the original file,
`from-yibo-test` and `from-pstn` snapshots after its validation failure. No fresh
claim is made about current live state. That rollback remains the required stable
baseline; do not repeat the old routing change automatically.

## Follow-up: local network blocker identified

Read-only checks later on September 26 again timed out for SSH and all four ARI
endpoints. Tailscale's local status and preferences now establish a specific
prerequisite that is missing:

- Backend state `Stopped`, `WantRunning=false`, `LoggedOut=false`.
- This Mac reports offline with no active Tailscale IP. The route to the configured
  PBX uses the ordinary Wi-Fi interface/default gateway, rather than a Tailscale path.
- The saved profile accepts private routes and Tailscale DNS; no exit node or
  advertised routes are configured. No setting was changed during inspection.

Reconnect the existing profile before drawing conclusions about PBX health. This
finding explains the absent local private connection, but does not prove the PBX
will be reachable afterward or resolve the earlier 7001 validation failure.

The installed CLI documents that `tailscale up` **with no flags** reconnects without
changing saved settings. Proposed action: run
`/Applications/Tailscale.app/Contents/MacOS/Tailscale up`, then repeat only status,
route, SSH and ARI reads. Do not use `--reset`, change profiles, enable an exit node
or alter Asterisk. Reconnection activates the saved DNS/private routes on this Mac,
so approval was requested under the user's working-phone preservation constraint.
At that checkpoint no reconnect was performed. The September 27 update above
supersedes that pending reconnect; real call/RTP verification is still pending.

## Operator action and next safe steps

1. **Completed:** approved Tailscale reconnect and separately approved permission
   repair/module load. Existing baseline contexts and destinations are verified.
2. **Completed:** fresh isolated standby API/database with separate ports and
   synthetic data. No ARI application is registered; the working service is intact.
3. Obtain separate explicit approval for the reviewed 7001-only change and isolated
   ARI activation in the proposal above. Historical approval to attempt 7001 does
   not override the later instruction to preserve its rollback.
4. After approval, recheck the baseline, back up metadata, enable only the isolated
   app, apply the exact change and verify/roll back as specified. Bidirectional
   media reachability remains unverified until an actual call.
5. After approved setup passes its safety checks, have the user place a real call
   from Linphone. Verify incoming/audio both ways, natural turn-taking and barge-in,
   no repeated questions, contact/availability/booking, one success confirmation,
   reschedule/cancel if exercised, full goodbye and clean channel/bridge/RTP teardown.
   Do not substitute a scripted or synthetic conversation for this manual gate.

No merge to main or deployment is authorized by this preflight.
