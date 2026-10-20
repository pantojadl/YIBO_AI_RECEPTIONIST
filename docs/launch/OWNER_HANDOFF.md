# Owner handoff

You can show a simulation today. You cannot receive a real US call until you approve a number, a model key, and a host. Nothing in this branch spent money.

## Show the demo (no card)

1. Install Docker, or skip to step 3 with pnpm.
2. Run `./deploy/up.sh`.
3. Open http://127.0.0.1:3000/demo
4. Click Hours, Book, Person, Recording, HIPAA, and Emergency. The replies are scripted. Nothing is saved. Nothing is a real booking.
5. Open http://127.0.0.1:3000/demo/status and check `pilotReady` is false and `hipaaClaim` is false.
6. Stop with `docker compose down`.

## Before any real call

Do these yourself. Each one is a separate yes.

1. Pick one non-healthcare business. Not a clinic. The sample in the demo is a barbershop.
2. Read `OPERATOR_LEGAL_REVIEW.md` with whoever handles legal questions. Do not publish it as-is.
3. Choose a host you already own, or approve one server. A 4 GB Lightsail plan is $24/month before the phone bill. See `COST_MODEL.md`.
4. Approve one US local number. Cheapest list prices found on 2026-10-20: Telnyx about $1/month plus $0.0032/minute inbound, or Twilio $1.15/month plus $0.0034/minute. Both want a card. Do not turn on outbound.
5. Create an OpenAI key with a spend cap you set in their dashboard. Put it only in an untracked `.env`. Do not commit it.
6. Install Asterisk 22 on that host. Run `pnpm asterisk:check`, then `pnpm asterisk:render` with a public IP and long passwords. Replace the carrier match `203.0.113.10` with the carrier's real IPs. Keep ARI on 127.0.0.1.
7. Point firewall UDP 5060 and 10000–10100 at those carrier IPs only.
8. Set `YIBO_RUNTIME=openai-realtime` and the Asterisk variables from `.env.example`. Set `YIBO_INSTANCE_LOCK=1`. Leave recording and outbound disabled.
9. Create the admin user with `pnpm admin:create` on the US tenant.
10. Map the purchased DID to the location in the dashboard. The app rejects numbers it does not know.
11. Connect a test Google calendar, not a personal calendar you cannot wipe.
12. Call the number yourself. Listen for the AI disclosure. Book, reschedule, cancel, hang up halfway, and ask for a person. Use a fake name.
13. Run `pnpm db:snapshot` and write down the checksum.
14. Only then tell a prospect the pilot number exists.

## If something goes wrong

1. `docker compose down` or stop the API process.
2. Cap or delete the OpenAI key in the OpenAI dashboard.
3. Disable the DID in the carrier portal so calls stop arriving.
4. Do not delete the SQLite file until you have a snapshot, unless you intend to throw the test data away.

## What to tell the first prospect

YIBO answers inbound calls, says it is an AI, does not record, and can book an appointment when the calendar is connected. It is not HIPAA. It does not call people. The website demo is a simulation until you have finished the list above.

## Still on you

- PR #2 (stuck bookings, spend cap, idempotent cancel) is open and not in this branch. Read it before real appointments.
- A lawyer has not signed the drafts.
- No uptime promise. One process. If it restarts, callers in progress drop and admins sign in again.
