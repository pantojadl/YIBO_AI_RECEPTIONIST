# Product/UX — Checkpoints A/B acceptance

Closed September 23, 2026 on `codex/product-ux-improvements`, following A
(`5e578fe`) and B (`0e6ec37`). The user reported that the manual Voice Lab test
passed and explicitly accepted the remaining A/B checks. This records that report;
it does not claim independent observation of every spoken exchange.

## Verified browser checks

- USD/MXN/EUR preview and save; EUR survives reload. Existing USD 125.50 prices
  retain their denomination. A new offering draft uses the saved EUR default.
- Two-tab currency editing rejects the stale save, retains the draft, disables
  another stale write, and reloads the newer saved value on explicit recovery.
- Both phone-readback modes save; digit-by-digit survives reload. Grouped mode
  was restored and verified in the isolated test setup.
- At 390 × 844, the five layout assertions pass: bounded page height, retained
  scrollable history, following new entries, preserving older scroll position,
  and Show latest. All 301 entries remain; history height is 224px, with no
  horizontal document overflow. Keyboard Home and Show latest via Enter work.
- The real dashboard connects to the isolated Voice Lab with the saved model,
  voice, tenant and location timezone. The user subsequently reported the manual
  microphone test passed, closing speech and test-completion acceptance.

The currency editor legend incorrectly said “Assignment at [location].” It now
says **Display currency**. No save, pricing or conversion behavior changed.

Closure checks: four focused currency persistence/authorization tests passed
(25 unrelated catalog tests deselected), frontend typecheck and production build
passed, and the corrected legend was verified in the actual browser. The prior
checkpoint test suites were not redundantly rerun for this label change.

## Scope and evidence limits

Acceptance used a private synthetic database, a separate dashboard/API/Voice Lab,
and no Google, OAuth, Asterisk, ARI or Telnyx credentials. The local calendar was
used for this product acceptance. This closes product A/B acceptance; it is not
a new real Google write test, a real phone call, a production deployment, or
teammate-branch integration. The working phone and Calendar setup were untouched.

The original checkpoint reports retain their implementation/test evidence.
Their manual checklists are historical acceptance procedures, now closed by the
checks above and the user's report. Checkpoint C — Availability UI is authorized
next; configuration-pipeline and Appointments Calendar redesign remain separate.
