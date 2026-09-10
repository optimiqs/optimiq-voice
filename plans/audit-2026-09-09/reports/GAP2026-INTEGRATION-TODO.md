# Cross-area leftovers for the integration wave (after all packs land)

- security: hand `TollFraudGuardPort` to the plan walker (one line in apps/engine/src/calls/channel-orchestrator.service.ts).
- security: put `mediaEncryption` on the channel snapshot / live channel flags; softphone + wallboard lock icon.
- security: live proofs still owed — geo-block refusal on a softphone with the named cause; fraud-signal webhook delivery on a synthetic spike.
- security: `requireSrtpForTlsPhones` declared but unconsumed — wire to per-leg `srtpPolicy=require` for TLS phones.
- infra: any new stream/bucket added by a pack must get its nats.conf grants (check engine ensure list vs nats.conf on every boot).
- security pack reported failing tests owned by other packs: events-go parity, webhookSelectors.test.ts, validate.ts, 12 web specs — re-verify at final.
- compliance: stamp `expected_attestation` for handset-originated calls — ~3 lines in apps/engine/src/calls/cdr-leg.ts (trunk leg `from_number` must be the effective E.164 caller id, not the extension); API backfill already guards on E.164.
- compliance: one line in apps/api devices.service.ts so the E911 validated-address gate also applies on device location assignment.
- compliance: there is no platform-operator UI in apps/web (KYC review, traceback live only via API) — decide: minimal operator screens behind the platform scope.
- contact-centre: F6 post-call survey — the agent's hangup tears down the caller's leg before the survey plays; park the caller out of the bridge (engine src/calls + media) when a survey is configured, then run the survey runner; live proof owed.
- contact-centre: `GET /queue-agents/:id/session` should carry `callId` + disposition fields so the wallboard supervise button and wrap-up panel work without the socket.
- contact-centre: full api mocha suite could not load during its run because of the recording pack's in-flight org-settings.catalog.ts — re-run at final.
- security: sipd cert file-watch reload did NOT fire on a rename+copy replacement of cert.pem/key.pem (SIGHUP did). ACME tooling replaces files atomically (rename) or swaps symlinks; watch the parent directory and re-arm on rename/remove, then re-read both files; add a test for the rename case.
