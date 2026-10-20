# Release candidate

Date: 2026-10-20. Branch: `cursor/yibo-us-launch-zero-cost-dd18`.

Suite commit: `be5ba9ab9a8021b0183508ba3937aeea8d6189ce`. The commands below were run on that tree. This file's SHA line is the only later edit.

Decision: **DEMO ONLY**. Not pilot ready. Not production ready.

## Commands run on this tree

| Command | Result |
|---|---|
| `pnpm test` | **500 passed, 1 skipped** (501). **82 files passed, 1 file skipped** (83). |
| Skipped test | `tests/integration/openai-realtime.live.test.ts`. It calls OpenAI only when `OPENAI_API_KEY` is set. The key was not set. SKIPPED, not passed. |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed |
| `pnpm asterisk:check` | Passed |
| `pnpm cost:model` | Passed. Demo scenario total $0. |
| `pnpm release:preflight` | Failed closed. No production secrets, no HTTPS origins, runtime not `openai-realtime`. Expected. NOT a production pass. |
| Real Asterisk / SIP / PSTN / live OpenAI / live Google | NOT EXECUTED |
| Docker | Not installed in this environment. `./deploy/up.sh` was not run. Compose file is unchecked by `docker compose config`. |
| Local API | Started with in-memory runtime on `127.0.0.1:3456`, US demo tenant, recording off. `GET /api/health` returned `{"status":"ok"}`. `GET /demo/status` returned `DEMO_READY` with `pilotReady: false` and `hipaaClaim: false`. |
| Demo clicks | Headless Chrome clicked Hours, Book, Person, Recording, HIPAA, Emergency, and submitted "What does a haircut cost?". Replies stayed inside the simulation: AI disclosure, no recording, no HIPAA claim, no saved booking, no card number, emergency redirected to local services. |

Spent: $0. No DID. No live model call.

Parent of the suite: `01dc29a7fc2385126dc88018d4e213099480696f` (`main`).
