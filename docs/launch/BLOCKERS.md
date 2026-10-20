# Blockers

Detail and the matrix are in `BASELINE_AUDIT.md`. This is the short list.

## P0 — stops a real call or a truthful sale

| ID | Blocker | $0 status | Paid or manual step |
|---|---|---|---|
| B-DID | No US number or trunk | Templates ready, trunk disabled | Buy one local DID. Ask first. |
| B-AI | No live model | Tests mock it; live test skipped | Capped OpenAI key. Ask first. |
| B-HOST | No public host proven | Local Docker demo | Owner machine or an approved VPS |
| B-NAT | SIP/RTP not proven on a network | Firewall table written | Run it on the chosen host |
| B-BOOK | PR #2 booking recovery not on this branch | DST bug is fixed here | Review PR #2 before live bookings |
| B-HIPAA | Healthcare not allowed | Copy and prompt say so | Do not sell to clinics |

## P1

Single process only. Recording off. Outbound off. Google and email not exercised live. No E911. No counsel sign-off. No final price.

## Not a blocker for the demo

The scripted page and the API health check do not need a DID or a model key.
