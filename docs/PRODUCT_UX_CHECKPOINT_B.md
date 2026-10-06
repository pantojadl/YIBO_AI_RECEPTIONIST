# Product/UX — Checkpoint B

Completed September 23, 2026 on `codex/product-ux-improvements`, following
Checkpoint A (`5e578fe`, preserved). Scope: Recent Activity, test-session lifecycle,
and automatic test completion. No deployment or changes to Asterisk, 7001, OAuth,
Calendar scheduling, business configuration, or the working phone service.

## Before this change

The dashboard connected one WebSocket on mount. The harness allocated one call ID
and inbound audio queue per socket. Microphone/WAV input started the conversation;
`listening`/`speaking` represented activity, while microphone pause only stopped input.
Manual close set the UI to `closed`, disabled starting again, and asked for a reload.
`conversation.closed` only changed a connection badge. Transport closure did not tell
the browser to finalize. Startup disconnects could miss server cleanup; late permission,
file reads and playback promises could revive stopped browser state. The dashboard
also discarded all but six activity entries instead of making history scrollable.

## Current lifecycle

`connecting → ready → starting → active → completed/error → connecting → …`

- Opening the screen only connects the local harness and reads readiness metadata.
  Microphone/WAV input starts a test. Pause/resume stays in the same test.
- The dashboard and standalone Voice Lab both use `VoiceLabSession`. Each socket
  owns its resources and completion flag. Manual end, terminal call events, network
  failure and unmount use the same idempotent finalizer.
- Completion stops microphone tracks, source/processor callbacks and **all** scheduled
  playback nodes, closes the AudioContext/socket, removes socket listeners, cancels
  the readiness timeout, and clears metadata/drain/fixture/playback state. Late async
  work checks the owning test before doing anything; a late microphone stream is stopped.
- A new test creates a fresh WebSocket, call ID, queue and audio context. Tenant/runtime/
  saved-configuration readiness is checked again before sending input. The browser
  cannot change the server-selected tenant. No business or agent-setting write is added.
- The server's `attachHarness` owns a single terminal transition too. It closes the
  inbound queue (discarding pending audio), cancels fixture pacing and interrupt-ack
  timers, releases the registered media transport, and reports `conversation.closed`
  once. Disconnect during startup still sends the orchestrator a hangup; that existing
  orchestrator waits for startup and then closes the new runtime. Transport close
  does not await a second orchestrator close, avoiding a shutdown dependency cycle.
- Completed test activity remains visible, labeled by test number, until the screen
  is unmounted. Existing server call/usage history is preserved. There is no new durable
  browser-history store, transcript capture, or audio persistence.

## Automatic completion

The existing Conversation `end_call` capability now also supports `voice_lab` when
its sink reports playback idle. The existing serial-tool, pending/uncertain-action,
matching farewell audio, response completion, deadline and interruption checks remain.
The Realtime payload validator accepts this same Voice Lab capability; sessions with
no product channel, disabled tools or parallel tool calls remain rejected.

When final audio is generated, the harness sends `playback.finish` with a request ID
and assistant turn ID. The browser acknowledges `playback.idle` only after queued
playback has finished. The harness ignores an acknowledgment for a different request
or turn. An interruption invalidates queued audio and the old acknowledgment.
Conversation then performs its existing close; the harness informs the browser.

An accepted end tool with farewell audio returns with `requestResponse: false`.
September 24 isolated acceptance also found function-only end requests: these now
request one following farewell response, then wait for its matching audio/drain.
Failures close as failed tests. See [call completion](CALL_COMPLETION.md).
There is no transcript matching, silence heuristic, or hangup after ordinary
response/tool completion. Existing phone eligibility and cleanup ownership remain.
A live model must still choose the end tool. Manual End remains available
when tools are disabled, parallel tool policy prevents automatic ending, or the model
does not end naturally.

## Recent Activity

The dashboard keeps every emitted activity entry in chronological order, grouped by
test number. The list is capped at **14rem**, scrolls internally, wraps long text, and
is keyboard focusable. New entries follow the bottom when already near it. Scrolling
up suspends following; **Show latest** resumes it. The fixed-height header prevents
that button from moving the page. The standalone console retains its existing bounded
height and now respects an older scroll position instead of forcing the bottom.

No server logging semantics were removed to achieve the layout. As before, audio bytes
are not shown and transcript text appears only when the server explicitly enables it.
September 24 acceptance corrected tool activity labels: `started`, `completed` and
`failed` are distinct. Starting a successful tool no longer appears as a failure.

## Automated checks

**96 tests passed:** 95 across eight focused files, plus one selected Realtime-adapter
completion test. There are **33 new cases**. The adapter run deliberately deselected its
27 unrelated tests. The full repository suite was not run.

```text
vitest run --silent \
  tests/dashboard/voice-lab-session.test.ts \
  tests/dashboard/voice-preview.test.ts \
  tests/voice/dev-voice-harness.test.ts \
  tests/voice/voice-media-gateway.test.ts \
  tests/conversation/conversation-service.test.ts \
  tests/conversation/realtime-session-payload.test.ts \
  tests/calls/call-orchestrator.test.ts \
  tests/bootstrap/build-application.test.ts

vitest run --silent tests/conversation/openai-realtime-adapter.test.ts \
  -t 'acknowledges call end without another response'
tsc --noEmit
vue-tsc --noEmit -p dashboard/tsconfig.json
vite build --config dashboard/vite.config.ts
git diff --check
```

In this worktree the commands use the existing `../../node_modules/.bin/` executables.
Both typechecks and the production build pass. Tests cover repeated tests, retained
history/configuration, fresh call IDs, tenant guards, duplicate/manual/automatic races,
startup disconnect, runtime failure, late permissions/file reads/resume callbacks,
queued audio cleanup, pause/resume, matching farewell drain, and no second response.
Harness tests use the real call orchestrator and validate the real Realtime payload
before opening a scripted runtime; they make no provider calls.

## Browser regression fixture and observed results

Run the synthetic fixture from the product worktree on an unused port:

```text
../../node_modules/.bin/vite . --config dashboard/vite.config.ts \
  --host 127.0.0.1 --port 5378 --strictPort
```

Open `/tests/dashboard/fixtures/checkpoint-b.html`. Only this test page replaces
WebSocket, microphone/audio context and readiness reads with synthetic IO. It renders
the actual dashboard component, makes no provider/API requests, and is not included
in the dashboard production entrypoint.

The **Run layout regression checks** button executes five repeatable assertions in
the real DOM: bounded page height, retained/scrollable entries, follow-latest, older
scroll position preservation and Show latest. These five assertions passed.

Also verified in the in-app browser:

1. Start a synthetic test, append 100 activities twice: 104 then 204 entries, list
   height stays **224px**, page height unchanged after the list reaches its cap.
2. Scroll to the oldest entry, append another 100: scroll position stays at zero;
   all **304 entries** remain present. Show latest returns to the bottom.
3. Send duplicate terminal events: one completion entry, completed status, restart enabled.
4. Start again: Test 2 starts without a reload; Test 1 results and all earlier activity remain.
5. Manual End then restart works; a simulated socket disconnect shows interrupted status
   and enables retry. The readiness configuration/timezone remains visible.
6. No browser error/warning logs during these checks. Header height was fixed at 40px
   after observing the Show latest button otherwise causing a small layout jump.

## Manual acceptance procedure

**Acceptance complete, September 23, 2026.** Compact/mobile and keyboard checks
passed, and the user reported the manual Voice Lab test passed and accepted the
remaining A/B checks. See [A/B acceptance](PRODUCT_UX_AB_ACCEPTANCE.md) for evidence
and limits. The checklist below is retained for repeat testing.

- Test the dashboard and standalone Voice Lab with real browser microphone permissions:
  allow, deny, pause/resume, end while permission is pending, and start again immediately.
  Confirm the browser microphone indicator turns off at completion.
- With an isolated configured Voice Lab, finish a natural conversation, listen to the
  full farewell, and verify automatic completion once with no follow-up question.
  Repeat after booking/confirmation using the already verified Calendar setup.
- Interrupt the farewell with another request; the conversation must continue. End it
  afterward and immediately run a second test. Check for stale audio, repeated greetings,
  doubled input or clipped final speech. Reconnect/failure UX needs an actual network test.
- Check compact/mobile layout, keyboard scrolling and long real activity histories.
  Activity is intentionally retained in memory for the current mounted screen; very
  long sessions may eventually merit virtualization, without dropping entries.
- These browser checks are not a real phone call. Phone-route diagnosis remains frozen.

## Integration risks and next scope

Overlap with the last inspected teammate branch includes `AgentVoiceLab.vue`,
`build-application.ts`, `conversation-service.ts`, `VOICE_PREVIEW.md` and
`PROJECT_STATUS.md`. The UI now delegates lifecycle/audio ownership to the shared
controller; a later merge must preserve the teammate's cost/business UI alongside that
controller. Shared backend changes are limited to the completion eligibility/validation
and returning a disposer from media registration. No teammate branch was changed.

Suggested next product checkpoint: **Availability UI**, after manual acceptance of
Checkpoints A/B and agreement on teammate integration. Availability UI, the Model
Configuration Pipeline, Appointments Calendar redesign and phone-route work were not
started by this checkpoint.
