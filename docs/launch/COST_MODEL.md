# Cost model

Fetched 2026-10-20. Figures are published list prices, not a quote and not an invoice. Taxes, fees, minimums, and KYC are extra. Nothing here was purchased.

Run:

```bash
pnpm cost:model
```

The script prints the built-in scenarios. Change the inputs in code or call `estimatePilotCost` with your own numbers. Audio tokens per minute are a planning assumption: about 600 input tokens and 1,200 output tokens per audio minute, taken from older OpenAI "$0.06 / $0.24 per minute" mappings at the $100 / $200 per 1M prices. They are not a measured YIBO call. Override `audioInputTokensPerMinute` and `audioOutputTokensPerMinute`.

## Sources

| Item | List price | Source |
|---|---|---|
| `gpt-realtime-2.1` audio | $32 / 1M input, $0.40 / 1M cached input, $64 / 1M output | https://developers.openai.com/api/docs/pricing |
| `gpt-realtime-2.1` text | $4 / 1M input, $0.40 cached, $24 / 1M output | same page |
| Telnyx US local number | from $1 / month | https://telnyx.com/pricing/numbers |
| Telnyx US SIP | inbound from $0.0032 / min, outbound from $0.005 / min | https://telnyx.com/pricing/elastic-sip |
| Twilio US local number | $1.15 / month | https://www.twilio.com/en-us/sip-trunking/pricing/us (page says August 2026) |
| Twilio Elastic SIP US | origination local $0.0034 / min, 48-state termination $0.0100 / min | same |
| Lightsail Linux, public IPv4 | $5 (0.5 GB), $7 (1 GB), $12 (2 GB), $24 (4 GB) per month | https://aws.amazon.com/lightsail/pricing/ |

VoIP.ms was not priced. Their pricing page blocked the fetch. Do not treat a remembered rate as current.

Telnyx and Twilio both say a card is required for pay-as-you-go. A "free trial" that stores a card was not opened.

## How a minute is counted

For each inbound minute the example assumes the caller speaks 45% and the assistant speaks 45%. Silence is not billed as audio in this model. Realtime may still send audio during silence; treat the result as a floor, not a cap. Forwarded minutes default to 0 because external transfer is off. If you enable a transfer, add those outbound minutes yourself. They are a second bill.

## Built-in scenarios (example math)

| Scenario | Host | DID | Inbound minutes | Inside $20? |
|---|---|---|---|---|
| `demo-zero` | $0 | none | 0 | yes ($0) |
| `owner-hardware-50` | $0 (already owned) | Telnyx $1 | 50 | yes (about $3.32) |
| `owner-hardware-200` | $0 | Telnyx $1 | 200 | yes, before tax |
| `owner-hardware-1000` | $0 | Telnyx $1 | 1,000 | no — inference dominates |
| `lightsail-2gb-200` | $12 | Telnyx $1 | 200 | no |

Exact cents for the 50-minute case are locked by `tests/launch/cost-model.test.ts`: inference $2.16, telephony $1.16, total $3.32.

A $24 Lightsail 4 GB plan is outside the $20 envelope before a single call. This audit did not measure RAM. Do not assume 1 GB or 2 GB is enough for Asterisk plus Node plus a live call.

## What $0 buys

The demo container, the scripted page, the templates, and the test suite. It does not buy a phone number or a model response.

## What a first paid month needs, item by item

Ask before each line. Silence is not approval.

1. One US local DID and inbound SIP (Telnyx list about $1/month plus $0.0032/minute, or Twilio $1.15 plus $0.0034). Card on file. Outbound stays off.
2. OpenAI key with a hard cap the owner sets in the OpenAI dashboard. The application cap is not a substitute. Example 50-minute month is a few dollars of audio at the assumption above; a long or looped call can be more. Set the cap before the first live call.
3. Host: $0 if the owner's machine is acceptable, or a Lightsail/VPS plan the owner names. Do not start the $24 plan under a $20 envelope.

Emergency calling, recording, and outbound transfers are separate products with their own prices. They stay off.
