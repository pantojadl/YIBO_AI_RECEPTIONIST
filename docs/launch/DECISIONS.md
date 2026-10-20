# Decisions

Date: 2026-10-20. Each item is reversible.

## D1. Do not merge PR #2 wholesale

PR #2 (`grok/yibo-alan-four-fixes`, about 12,000 added lines) contains real booking fixes and also a large product-UI branch that never landed on `main`. Merging it blind would mix unreviewed dashboard work with the launch package. This branch ports only the isolated DST bug, plus inbound-safety controls that did not depend on that branch. The rest of PR #2 stays open for review.

## D2. Asterisk 22 LTS, inbound only

[Asterisk versions](https://docs.asterisk.org/About-the-Project/Asterisk-Versions/) (fetched 2026-10-20): 22.x is LTS and fully supported. Security-fix-only starts 2028-10-16. EOL is 2029-10-16. 20.x entered security-fix-only on 2026-10-19, so new templates target 22. The carrier endpoint is disabled. Unknown DIDs hang up before Stasis. `app_mixmonitor` is noloaded. ARI HTTP binds to 127.0.0.1.

## D3. External transfers do not dial `PJSIP/<number>`

That endpoint string is not a route to a carrier. Phone transfers go to `Local/<digits>@yibo-outbound-transfer`, which hangs up. Turning on `YIBO_EXTERNAL_TRANSFER=enabled` only lets the gateway send that redirect. It still does not buy an outbound leg. Outbound minutes need a separate approval because they are billable.

## D4. One process, one database writer

`YIBO_INSTANCE_LOCK=1` uses a hostname-plus-pid lock. Docker Compose sets it. A second live process on the same host exits. This does not make SQLite safe across hosts sharing a file.

## D5. Recording stays off

`YIBO_CALL_RECORDING` other than off/disabled/false/0 throws at startup. There is no recording pipeline to turn on. That is intentional.

## D6. AI disclosure is an instruction, not a hope

The prompt compiler adds an immutable rule: the first spoken turn says the caller is talking to an automated AI assistant. A custom greeting cannot remove it. This is a prompt, not a recording of what a live model will say. Live wording is ACCEPT-001.

## D7. Demo is a simulation

`/demo` is static scripted HTML. Status JSON says `DEMO_READY`, `pilotReady: false`, `livePstnVerified: false`, `hipaaClaim: false`. The first customer segment in the copy is a barbershop, not the dental fixture name.

## D8. $20 is a planning envelope, not a budget that was spent

Spent: $0. A credible pilot is one DID plus inference plus, if needed, a host. A 4 GB Lightsail plan is $24 before the number and the model, which is outside the envelope. See `COST_MODEL.md`. Owner hardware keeps the host line at $0.

## D9. No new database and no Kubernetes

SQLite stays. One container or one process. Cloudflare Workers cannot run this PBX unchanged, and this fork has no Workers branch to port.
