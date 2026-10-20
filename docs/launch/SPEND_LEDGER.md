# Spend ledger

| Date | Item | Approved | Incurred |
|---|---|---|---|
| 2026-10-20 | All work in this branch | $0.00 | $0.00 |

No DID, SIP trunk, VPS, domain, OpenAI call, Google call, or paid GitHub feature was created.

## Not incurred, not approved

These are planning numbers from `COST_MODEL.md`. They are not charges.

- Telnyx US local number, list from $1/month, inbound from $0.0032/minute.
- Twilio US local number, $1.15/month, origination $0.0034/minute.
- OpenAI `gpt-realtime-2.1` audio, $32 / $64 per 1M tokens.
- Lightsail Linux with IPv4, $5 to $24/month depending on size. $24 is outside the $20 planning envelope before telephony.

Worst case if someone later enables a live key with no cap: OpenAI and the carrier bill until the owner stops them. This repository cannot enforce a provider cap. Do not put a live key in the demo compose file.
