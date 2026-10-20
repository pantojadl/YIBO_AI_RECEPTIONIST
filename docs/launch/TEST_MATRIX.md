# Test matrix

Counts from the suite run are in `RELEASE_CANDIDATE.md`. A skipped live test is not a pass.

| Layer | What | Result in this run |
|---|---|---|
| A | `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm asterisk:check`, `pnpm cost:model` | See the candidate note |
| B | DST, AI disclosure, recording/outbound rejected, duplicate Stasis, US DID canonicalization, blocked phone transfer, instance lock, snapshot, demo page, cost math | New tests under `tests/launch`, `tests/scheduling/time.test.ts`, telephony and prompt tests |
| C | Real Asterisk, two extensions, echo, SIP | NOT EXECUTED. Asterisk is not installed here. Templates are checked as text |
| D | Carrier sandbox | NOT EXECUTED. No account |
| E | Live PSTN + live OpenAI + live Google | NOT EXECUTED. No spend approval. `openai-realtime.live.test.ts` skips without a key |
| F | Paying customer | NOT EXECUTED |

`pnpm release:preflight` without production secrets exits non-zero. That is the script refusing a release, not a failed unit test. The unit tests around it use fake env values.
