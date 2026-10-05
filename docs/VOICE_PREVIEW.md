# Saved-settings voice preview

The configuration panel opens the existing Voice Lab. Browser speech synthesis
is removed because it does not reproduce the selected OpenAI voice. Save edits
first: the preview deliberately uses the server's saved configuration, and does
not save or apply the draft implicitly. An active conversation keeps its original
settings; end it and open a fresh session to hear newly saved settings.

Opening the configuration page does not mount Voice Lab or open a provider
session. Clicking Open saved-settings Voice Lab connects the local audio harness;
starting the microphone or explicitly uploading a WAV starts the model and may
incur API charges. The UI states this before either action. This is a browser
voice preview, not an Asterisk phone call.

The harness reports its configured tenant, runtime, saved model and voice.

The dashboard also estimates the current test-session cost after each Realtime
response. It uses the provider-reported text, audio and cached token breakdown
and the versioned USD rates published with the selected model capability. The
counter resets for each Voice Lab conversation and shows duration, token mix,
tool calls and the current per-minute pace. This is an operational estimate;
the OpenAI organization billing result remains authoritative.
Microphone and WAV starts are disabled until those match the authenticated
tenant and a real OpenAI Realtime runtime. This readiness check prevents an
accidental preview of another local tenant; it is not an authentication mechanism.
The local harness remains bound to loopback and is not a public preview endpoint.
The server still chooses its tenant; the browser cannot select it.

Run the Voice Lab process from this integration checkout when testing this UI.
An older running harness does not publish the new readiness message and the UI
will remain disabled. Existing processes were not restarted during implementation.
No real API session was started by the automated validation.

Validation: 14 focused dashboard tests passed (8 new preview-readiness cases),
backend and dashboard typechecks passed, and production build passed. Saved
settings, existing capability validation, and the Voice Lab audio transport are
otherwise unchanged. Live listening requires the configured provider credentials.

## Product/UX Checkpoint B — repeatable tests

The Test screen and standalone Voice Lab share a browser session controller. Completed
and interrupted tests release their temporary media/connection resources and allow a
new test without a page reload. Every new connection checks saved tenant/runtime metadata
again; business settings survive. The dashboard retains activity across tests within
the mounted screen, in a bounded scrollable list with optional following of latest events.

Natural completion uses the existing `end_call` capability when the configured tool
policy allows it. Browser playback drain is acknowledged before automatic closure.
Manual End remains a fallback; ordinary response/tool completion never ends the test.
See [Checkpoint B](PRODUCT_UX_CHECKPOINT_B.md) for lifecycle, exact checks, synthetic
browser fixture and outstanding real microphone/model acceptance. Historical UI-008
validation above is unchanged; no working service was restarted for this checkpoint.


## Launch candidate integration

The shared Product/UX session controller remains responsible for microphone,
playback drain, socket cleanup, Recent Activity and repeatable starts. Operations
usage/cost reporting observes that lifecycle: `test.started` resets usage; one
`conversation.opened` starts timing; completion is idempotent and late usage after
completion is ignored. Provider/model rates are taken from the capability registry.
No browser speech synthesis or second session controller was introduced. Real
listening and microphone acceptance on the merged candidate remain a release gate.
