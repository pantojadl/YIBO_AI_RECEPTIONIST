# PBX dialplan read-permission repair — completed

27 September 2026. The user separately approved **permission repair and module
load** after reviewing this proposal. The exact repair below passed at
18:21:53 UTC. The earlier Tailscale reconnect approval was not treated as PBX
repair authorization. No isolated routing change was made.

## Execution and verification

- Rechecked the expected hash, `root:root 0640`, inactive module and zero active
  calls/channels before applying the approved action.
- Created `/root/yibo-dialplan-permission-backup-20260927T182153Z-hwm70629`
  with private directory permissions. Its `cp -a` file copy matches the original
  hash, owner, group and mode; private metadata and before/after CLI snapshots
  preserve the verification evidence. The September 23 backup remains intact.
- Changed only `extensions.conf`'s group to `asterisk`. Owner remains `root`,
  mode remains `0640`, and the SHA-256 below is unchanged. Readability as the
  actual service user now passes.
- Loaded the inactive `pbx_config.so` once; it is now **Running**. Both loaded
  context displays match the September 23 baseline snapshots after whitespace
  normalization. Extension 7001 and the explicit public DID rules target normal
  `yibo`; no rule was edited.
- Asterisk's systemd PID is unchanged. No restart, global reload, module unload,
  other configuration change or call was performed.
- At 18:22:28 UTC all four ARI inventory reads returned HTTP 200, with zero
  channels, bridges and registered applications. The normal `yibo` application
  was not started by this repair. This is not a completed phone-call test.

## Verified problem before repair

| Read-only check | Result |
|---|---|
| SSH and ARI | Reachable after the approved reconnect; all four ARI inventory reads HTTP 200 |
| Service identity | Asterisk 20.6.0, running as user/group `asterisk` (UID 109 / GID 112); ARI listener and systemd share the same PID |
| Text dialplan module | `pbx_config.so`: **Not Running**, use count 0 |
| Loaded contexts | Both `7001@from-yibo-test` and `from-pstn` absent |
| Configuration file | `/etc/asterisk/extensions.conf`, owner/group `root:root`, mode `0640` |
| Reproduced read failure | Opening that file as user `asterisk` raises `PermissionError`; `test -r` fails |
| Parent / comparison file | `/etc/asterisk` traversable (`0755`); `modules.conf` readable by the service |
| Preserved contents | Current file exactly matches the existing September 23 rollback backup |
| Activity at inspection | Zero channels, calls, bridges and registered ARI applications |

The current file SHA-256 is
`4b2db3c0432dd74437e97d9b4b2e8248aa0578de6b37a801975f220624eba204`.
Its text still sends extension 7001 and the explicit public DID rules to the normal
`yibo` application. The isolated application is not selected by that text.

The observed service user has neither root ownership nor membership in group root.
Mode `0640` therefore denies access to the text dialplan. Asterisk's version-matched
source confirms that failing to read this configuration causes `pbx_config` to
decline loading. A stopped/declined module is skipped by ordinary module reload;
explicit module load can initialize it again. See
[pbx_config 20.6.0](https://github.com/asterisk/asterisk/blob/20.6.0/pbx/pbx_config.c#L1567-L1587)
and [module loader 20.6.0](https://github.com/asterisk/asterisk/blob/20.6.0/main/loader.c#L1717-L1736).

## Historical limits

The backup's saved CLI snapshots show both contexts existed on September 23.
The file's metadata-change time is September 23 at 04:33:24 UTC, in the recorded
rollback window; its preserved content-modification time is September 12.
The current Asterisk process started September 26 at 06:36:58 UTC.

This proves today's read-permission failure and preserved file contents. It does
not identify which historical command changed ownership, nor prove this was the
only cause of the earlier `test_route_not_loaded` check. Comparing restored text
and already-loaded routes did not establish that the service could reread the file
after a restart. No server metadata or content changed during this inspection.

## Exact approved repair

The separate approval covered a maintenance action on the existing PBX, including
activation of the **whole existing text dialplan**, not just extension 7001.

1. Recheck the expected file hash, owner/group/mode, module state and active calls.
   Stop if another operator changed the file/state or any call is active.
2. Create a private timestamped backup preserving file metadata (`cp -a`) and record
   service/module/context state. Preserve the older rollback backup too.
3. Change only the file group:

   ```sh
   chgrp asterisk /etc/asterisk/extensions.conf
   ```

   Owner remains root; mode remains `0640`; contents/hash stay identical. Confirm
   the actual Asterisk user can now read the file before touching the module.
4. If `pbx_config.so` is still **Not Running**, initialize only that module:

   ```sh
   asterisk -rx 'module load pbx_config.so'
   ```

   No Asterisk/PBX restart, global reload, module configuration edit or forced
   unload. The explicit load handles a previously declined module in this version.
5. Verify module Running; both contexts loaded; 7001 still
   `Stasis(yibo,+15125550100)`; existing explicit public DID entries still target
   `yibo`; file contents unchanged; ARI reachable; channels/bridges checked again.
   Compare loaded rules with the preserved snapshots rather than only the CLI
   process exit code (Asterisk can print a failed command while returning exit 0).

If permission/read validation fails before loading, restore the original group and
stop. If module/context validation fails afterward, capture the actual state and
stop; reverting file group alone does not undo a loaded dialplan. Returning to the
previous inactive module state would require an ordinary unload of this module
only after confirming it is unused and there are no active calls. Never force
unload or interrupt a call. Do not broaden the repair to other configuration.

## What this does not complete

- It does not route 7001 to `yibo-accept001-isolated`; that needs a separate exact
  proposal and approval after the baseline works.
- No `yibo` ARI application is currently registered. Restoring contexts alone does
  not prove that the normal phone service can complete a call. No existing service
  was started, stopped or restarted in this diagnosis.
- The previous temporary isolated environment file is now absent. A fresh private
  launch setup must be prepared before isolated ingress is enabled. Its planned
  RTP range remains 50500–50509, separate from working configuration 40000–40020;
  no listeners were observed in the isolated range. Bidirectional media is untested.
- Real conversation, goodbye and resource cleanup still require the user's call.
  Main and Google/OAuth configuration remain untouched.
