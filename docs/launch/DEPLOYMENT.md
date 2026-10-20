# Deployment

Status of this repository: demo can be started locally. A public phone pilot is not started.

## One command (demo, $0)

From a machine with Docker:

```bash
./deploy/up.sh
```

That runs `docker compose up -d --build`. The API listens on `127.0.0.1:3000` only.

- Demo: http://127.0.0.1:3000/demo
- Status: http://127.0.0.1:3000/demo/status
- Health: http://127.0.0.1:3000/api/health
- Stop: `docker compose down`

The compose file sets `YIBO_RUNTIME=in-memory`, recording off, outbound off, US demo tenant `tenant-yibo-demo-us`, and the instance lock. It does not set an OpenAI key. `NODE_ENV` is not `production`, so this HTTP demo does not mark cookies `Secure`. A public site must sit behind HTTPS and then use production settings.

Without Docker:

```bash
pnpm install --frozen-lockfile
YIBO_REGION=US YIBO_TENANT_ID=tenant-yibo-demo-us YIBO_CALL_RECORDING=off YIBO_OUTBOUND_DIALING=disabled HOST=127.0.0.1 pnpm dev:api
```

## What the demo process is

```
Browser → 127.0.0.1:3000 /demo  (static simulation)
       → 127.0.0.1:3000 /api/*  (Fastify, SQLite on a volume)
Asterisk is not in the default compose file.
```

One container. One SQLite file at `/var/lib/yibo/yibo-us.sqlite`. Do not add a second replica.

## Asterisk, when a host exists

Templates: `deploy/asterisk/` for Asterisk 22 LTS. Check and render:

```bash
pnpm asterisk:check
YIBO_PUBLIC_IP=<public v4> YIBO_ARI_PASSWORD=<long random> YIBO_TEST_EXTENSION_PASSWORD=<long random> pnpm asterisk:render
```

Rendered files land in `deploy/asterisk/rendered/`, which is gitignored. Install Asterisk 22 from packages on the host. Do not publish port 8088. Point the API at `ASTERISK_ARI_URL=http://127.0.0.1:8088` on the same machine.

This environment did not install Asterisk and did not pull a PBX image. A guessed container tag is not a substitute for a version you have actually booted.

## NAT and firewall

Set these in the rendered `pjsip.conf` to the host's public IPv4:

- `external_signaling_address`
- `external_media_address`

`local_net` already lists RFC1918 ranges. If the host is on a cloud VPC, add that CIDR.

| Port | Protocol | Who may connect |
|---|---|---|
| 5060/udp | SIP | The carrier's signaling IPs only, after you replace `203.0.113.10` |
| 10000–10100/udp | RTP | The carrier's media IPs, and the API if media is bridged on this host |
| 8088/tcp | ARI HTTP | 127.0.0.1 only |
| 3000/tcp | API | Reverse proxy on localhost, or the operator. Not the open internet without TLS and auth |

`direct_media=no` so RTP stays on the PBX. `strictrtp=yes`. No guest access. No `allowguest=yes`.

TLS/SRTP is not configured. Add it only with the carrier's instructions. Do not open SIP to `0.0.0.0/0`.

Fail2ban is not installed by these files. If the host is reachable, restrict 5060 with a firewall before any trunk password exists.

## E911 and number ownership

The pilot does not register an emergency address and must not be used to call 911. The business keeps its existing phone for emergencies. The DID, once purchased, belongs to the carrier account the owner controls. Porting a live business number is out of scope until the owner asks.

## Backup

On a copy, not on the only file:

```bash
pnpm db:snapshot -- --source /var/lib/yibo/yibo-us.sqlite --dest /safe/yibo-us-YYYYMMDD.sqlite
```

`VACUUM INTO` writes a consistent snapshot. The command prints SHA-256, `integrity_check`, and `foreign_key_check`. Keep `YIBO_TOKEN_ENCRYPTION_KEY` with the backup or Google tokens will not decrypt. Restoring means stopping the process, moving the snapshot to a new path, and starting one instance against that path. Practice on a copy.

## Shutdown

Demo: `docker compose down`.

Pilot, once it exists: stop the API (SIGTERM closes telephony and the HTTP server), then stop Asterisk. Revoke or cap the OpenAI key in the provider dashboard if a runaway session is the problem. The process lock is released on shutdown. A crash on the same host is replaced on the next start; a live second process is refused.

## Host comparison (not purchased)

| Option | Monthly list | Fits a phone pilot? |
|---|---|---|
| A. Machine the owner already has | $0 extra | Yes, if it has a public IPv4 or a VPN the carrier can reach, and UDP is open to the carrier only |
| B. Lightsail Linux IPv4 1 GB / 2 GB | $7 / $12 | Possible pilot host. RAM was not measured. 4 GB is $24 and is outside the $20 envelope before the DID and the model |
| C. Other small VPS | Varies | Same constraints: one instance, UDP, persistent disk |
| D. Static demo only | $0 | This branch. Phone backend stays on localhost without a trunk |

Cloudflare Workers can serve a static page. They do not run this Node, SQLite, and UDP media path. No Worker was deployed.
