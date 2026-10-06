# 7001 speakerphone echo — repair and acceptance evidence

Updated 3 October 2026. **Approved codec repair applied; user reports 7001 worked.**
Detailed live acceptance variants are not all recorded. Source baseline:
`codex/yibo-launch-candidate`, `29dcace5d40cd5d04babfae39c03c965a870732a`.

## Approved repair and subsequent user report

On October 1 the user explicitly approved changing only the `yibo-audio-test`
endpoint from `allow=ulaw` to `allow=speex16`, followed by a `res_pjsip.so` reload.
Fresh hashes, metadata, codec translation support, routes and zero active calls
matched the reviewed baseline below. A verified metadata-preserving backup was
saved privately on the PBX before writing the exact one-line candidate.

The reload succeeded. Both endpoint configuration snapshots matched their baseline
except for the approved codec; public/test routes, dialplan hash, file metadata and
Asterisk PID stayed unchanged. Linphone had a registered contact. The isolated API
on 3114 was reconnected after its stale ARI subscription; working service listeners
were preserved during that repair. The isolated app registered correctly, no call
resources remained, and RTP 50500–50509 was free and separate from 40000–40020.
No application source, Cloudflare or Calendar configuration changed.

The bounded diagnostic window ended October 1 at 16:42 UTC without observing a
call. On October 2 the user reported **“the 7001 worked”** and authorized starting
Checkpoint 6. Record this as user-reported call success; it does not prove a captured
codec/audio trace, every scheduling/transfer/language/failure scenario, or measured
cleanup for that later call. Those ACCEPT-001 details remain manual acceptance work
before the pilot. No further PBX change was made during deployment preparation.

The sections below preserve the reviewed diagnosis/procedure as historical evidence.

## Evidence

- The two September 30 Linphone calls reached isolated YIBO. Its logs show
  repeated speech-start events shortly after assistant RTP starts, followed by
  response cancellation/truncation. Both calls released their media resources.
- The caller used Mac speakers and the built-in microphone. Linphone 6.2.2 logged
  that its WebRTC echo canceller could not support 8000 Hz and was disabled on
  **both** calls, despite the UI's echo-canceller switch being enabled.
- A test against the installed Linphone libraries reproduced that mismatch:
  `MSWebRTCAEC` requests 16000 Hz when offered 8000 Hz; it accepts 16000 Hz.
  This matches the upstream [sample-rate check](https://github.com/BelledonneCommunications/mediastreamer2/blob/master/src/voip/audiostream.c).
- The media gateway uses one caller and one bidirectional External Media channel
  per mixing bridge. External Media Stasis events are ignored as caller ingress.
  The test endpoint has `direct_media=no`; External Media uses PCMU/8 kHz.
- A bounded synthetic probe on the actual PBX created two temporary External
  Media channels under the isolated application and one `simple_bridge`. Each
  side received 97 packets from the other side and **zero** copies of its own
  payload. Its private Mac UDP ports were 50508/50509; the two PBX RTP ports were
  distinct. All probe channels, bridges and UDP sockets were released.
  This verifies transport direction for that probe; it does not replace a real
  speakerphone call or prove acoustic echo cancellation.
- These results support acoustic speaker-to-microphone feedback as the cause of
  the repeated interruptions. No server-side bridge loop was reproduced.

## Client-only attempt and rollback

The bundled Speex echo canceller accepts 8 kHz, but Linphone's packaged factory
configuration forces `MSWebRTCAEC` again after local provisioning. The attempted
local XML override therefore did not take effect. Linphone was closed, its
original settings were restored byte-for-byte from a private 0600 backup, and
the client was reopened. Original accounts/credentials were preserved. The
provisioning URL is empty again. The installed application was not modified.
Private backups and diagnostic files remain outside Git.

The user requires Mac speakerphone testing, so headphones are not the proposed
resolution.

## Reviewed change

Change **one line**, only in the `type=endpoint` section named
`[yibo-audio-test]` in `/etc/asterisk/pjsip.conf`:

```diff
-allow=ulaw
+allow=speex16
```

Keep `disallow=all`, `context=from-yibo-test`, `direct_media=no`, authentication,
and all other sections unchanged. This test context contains only extension
7001. Requiring the wideband codec prevents a fallback to the known-broken 8 kHz
client echo-canceller path.

Linphone already offers `speex/16000` in its real 7001 SIP offers, and its current
UI has **Speex 16000 Hz enabled**. No further Linphone setting change is needed.
Asterisk reports `speex16` as the supported 16 kHz Speex format, `codec_speex.so`
is Running, and the translation matrix has paths in both directions between
`speex16` and `ulaw`. YIBO's External Media format and RTP range stay unchanged.

Before approval, the in-memory candidate had exactly that one-line diff:

- Current `pjsip.conf` SHA-256:
  `975b0628f98366e9234b632819b19a70c9c788b22c47de8b8d23d43ad575f46a`.
- Candidate SHA-256:
  `5bc203e79d86cd58076c9b92b5489585023fa8646d9fa5efdec771bc46a24ae5`.
- Current file metadata: uid 109, gid 112, mode 0640; preserve it exactly.
- Dialplan SHA-256, unchanged:
  `760d7f353290ecb74872119914d07c25c6312d90aea1c758bff25969d3fc404b`.
- 7001 still targets `yibo-accept001-isolated`; public `from-pstn` targets `yibo`.

This required separate approval because it edits shared PJSIP configuration and
reloads a SIP module, beyond the earlier dialplan-only approval. That approval was
subsequently given and the procedure below completed. No public endpoint or route
was included.

## Reviewed execution procedure (completed October 1)

1. Recheck the hashes, metadata, codecs, loaded endpoint/public routes, Asterisk
   PID, registered applications, and zero active calls/channels. Stop if the
   reviewed baseline differs. Save private snapshots of the other endpoints.
2. Back up `pjsip.conf` with metadata to a new root-only timestamped PBX directory;
   verify the backup hash. Preserve existing backups.
3. Construct the one-line candidate and assert all other bytes are identical.
   Verify its hash, supported format name, unique endpoint match and metadata
   before reload. These static checks do not claim Asterisk has loaded it.
4. Apply it preserving metadata, then reload **`res_pjsip.so` only** with
   `asterisk -rx 'module reload res_pjsip.so'`. No restart, global reload,
   transport change, dialplan edit, or public endpoint edit.
5. Verify the test endpoint now allows only `speex16`; compare other endpoint
   snapshots, route snapshots, dialplan hash and Asterisk PID with the baseline.
   On any mismatch or failure, restore the private backup and reload only the
   same module. Verify the original state and stop.
6. Recheck and, if needed, restart only the isolated API process on 3114. Its
   October 1 inspection found the API still listening but no ARI application
   registered. Verify its subscription as `yibo-accept001-isolated`, private RTP
   range 50500–50509, and no collision with working services. Preserve normal API
   3000, Voice Lab 4317, their settings and their processes.
7. Confirm Linphone registration and zero leftover channels/bridges. Only then
   tell the user 7001 is ready, and wait for their real call.

## Validation and remaining acceptance

**37/37 focused tests passed in six files**: ARI client, RTP media gateway, RTP
packet helpers, RTP pacer, modern Asterisk integration, and phone operations.
The two-direction live-PBX synthetic probe and the installed-library sample-rate
checks passed. No YIBO runtime code changed; no broad suite/build rerun is needed
for this diagnostic proposal.

For the actual retest, verify the negotiated caller format is `speex16` and
Linphone's WebRTC echo filter is active without the 8000 Hz disabling warning.
The caller should listen silently to the opening, answer naturally, interrupt once
deliberately, and finish with a goodbye. Check for repeated self-interruptions,
one completion, and complete channel/bridge/RTP cleanup. If booking is exercised,
use only the existing labeled isolated test appointment and verified test calendar.
Do not mark this gate passed before the real audio and resource checks succeed.
