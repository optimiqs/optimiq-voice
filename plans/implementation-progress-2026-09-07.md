# Calling platform implementation progress

Scope: complete Telnyx-connected organization calling, including browser and SIP endpoints, routing, operational reliability and end-to-end verification. Baseline commit: 32b8499. The readiness audit is the baseline, not a description of the updated checkout. No commit, push, deployment, carrier call or changes to the user's databases have been performed.

## Implemented and locally verified

- Canonical API-to-Go trunk directory and fixture parity, including secret references and tenant/key validation.
- Telnyx credential-based REGISTER and outbound INVITE authentication. The private API responder verifies tenant/trunk identity and returns HA1 rather than raw carrier passwords. Bounded cache and challenge retries.
- Real UDP call lifecycle: 401/407 challenges, authenticated INVITE, response Contact and Record-Route routing, ACK delivery and retransmitted 2xx handling, BYE completion and cleanup.
- Service-specific NATS reply inbox permissions; a real broker test proves the media identity cannot request or consume SIP carrier credentials.
- Tenant-specific SIP realms, realm-bound nonces, digest request-URI binding, domain onboarding UI and phone provisioning. Global domain uniqueness is enforced by a generated migration; concurrent tenant-role claims were tested.
- Deterministic media ownership: concurrent call legs share a media instance; session, bridge and operation commands reach their owner; loss of an owner produces an explicit failure. Cross-call relocation remains outstanding.
- Engine native conversation recording and supervision capability handling. Recording stop leaves the live call intact; native supervision does not wait for a nonexistent virtual channel.
- SIP/media container builds, private health/readiness probes, carrier-facing SIP listener, shared prompt/recording volume, Compose overlay and image-release entries. Container builds passed; a complete application-container deployment is not yet proven.
- Readiness follows actual SIP listeners and NATS connectivity. Real-process tests exercise internal/carrier SIP OPTIONS and readiness after broker loss.
- Fresh disposable PostgreSQL: all PBX migrations and 119 checks pass, including tenant domain constraints. API: 1161 passing tests. Engine: 1529 passing tests. Typecheck: 29 tasks pass. These counts precede the ongoing WebRTC changes below.
- Real media cluster: two processes, concurrent placement, bidirectional RTP, recorded WAV samples, playback, 40 routed commands, engine reconnect, bridge cleanup, releases and owner loss pass with the production NATS permission configuration.
- Complete gated Go integration suite passed after updating the BLF fixture to sign the actual SUBSCRIBE URI. MWI subscription startup now flushes NATS and closes delivery only after callbacks finish.

## WebRTC and multiple devices

- Pion WebRTC 4.2.20 terminates ICE/DTLS/SRTP inside mediad. Secure sessions refuse plaintext injection. Real peer tests pass in both offer directions, including two-way RTP interoperation and cleanup.
- Chromium media-control tests pass in both offer directions, with measurable received audio energy and outgoing audio packets. Six repeated calls passed with finalized conversation recordings and zero recorder drops after fixing a blocked packet loop during ICE connection. The browser test is included in CI.
- Target resolution selects encrypted offers for browser registrations and addresses origination to the SIP process holding that WebSocket. Contacts are pinned and revalidated before origination.
- Browser capability is opt-in. The API issues expiring TURN HMAC credentials, and the product adapter refreshes credentials before calls. WSS and pinned coturn deployment configuration have been added; relay-only UDP and TCP acceptance now passes.
- Registrar updates use CAS across servers. Multiple Contacts, individual deregistration, independent expiry, stale CSeq refusal, query remaining lifetimes, device identity and SIP process ownership are implemented. Concurrent registration updates on the production NATS permission configuration passed.
- Extension registration limits reach the SIP edge. The contract supports the existing extension maximum of twenty; the edge-wide cap can be lower.
- The engine rings equal-priority contacts concurrently, gives backup groups a share of the destination ring budget, records separate legs and clears losers before bridging. Targeted walker tests: 149 passing. Engine before the latest timeout cleanup: 1532 passing; typecheck: all 29 tasks passed at that point.
- Failed origination now cleans up allocated media and addresses teardown to the resolved SIP owner even when the origination reply was lost.

The browser acceptance harness now passes against two real SIP processes, two real media processes, the product browser adapter and the engine's actual media/SIP ports. Both incoming browser destinations and outgoing browser calls pass audio, DTMF, hold/resume and WAV recording. The same tests pass through authenticated coturn over UDP and TCP with relay-only policy; killing coturn stops the audio. Account lookup and initial admission remain fixtures in this harness.

Remote SDP now reaches the owning engine, validates tenant/call/SIP process identity, and renegotiates the existing media session. Media refusal preserves SIP hold and target state. WebRTC renegotiation preserves the established DTLS role, applies the negotiated audio direction through the media session gates, and keeps the Pion transceiver available for resume. Delayed SDP offers and engine-originated re-INVITE remain outstanding.

API, engine and web container builds pass locally. The API image needed its shared TypeScript config and an architecture-specific bootstrap helper. A migration job for all four journals, a fresh-volume database initializer and Linux coturn host networking have been added; fresh complete application startup is being verified. The standard codegen drift command reports uncommitted generated changes in this working tree; repeat-generation byte comparison is the appropriate local reproducibility check until commit.

## Full application startup and administration

Fresh disposable databases now pass all four migration journals. The actual API, engine, media and web containers start and become ready. Startup verification caught and fixed a missing optional WebhookDispatcher injection and engine media startup before Nest initialized NATS. Production engine configuration now validates its own broker credentials without requiring API authentication/database secrets; absent legacy Asterisk addresses no longer block a native deployment.

Extension assignments now have a permission-gated API and browser dialog. Assignment validates organization membership and uses the existing audited tenant/parent-scoped child repository. The authenticated browser assigns and removes members successfully. A user's credential endpoint changes from 404 to their assigned extension and back on removal. This does not rotate a shared extension SIP secret already known by a former assignee; per-device credential revocation remains a separate gap. The current browser invalidates its credential query and stops using stale data after a refusal.

Latest broad checks: API 1166 passing, engine 1539 passing, events with real NATS 388 passing, all 29 typecheck tasks passing, all Go modules passing with the race detector, and the full multi-node media harness passing. Subsequent focused changes have their own checks and still require the final broad run.

Carrier network regression tests pass for identical challenges (two INVITEs), changing nonces (four INVITEs maximum), caller cancellation during credential retrieval and ring timeout. Credential lookup now cancels when dialog teardown begins. An invalid mid-dialog session interval is refused with 422/Min-SE before media or target/hold state changes.

The native media adapter now carries paging/intercom Alert-Info and Call-Info headers to SIPD instead of dropping the ARI-shaped variables. Other channel-header variables are not forwarded. Full phone paging acceptance remains outstanding.

The deployment includes a separate migration image, an example environment and `docs/native-calling-deployment.md`. Compose syntax validates. The production engine and authenticated browser startup checks pass. Database runtime-role provisioning and public-network/Telnyx acceptance are still operator/deployment gates. A stronger acceptance run is in progress with two actual users, locally captured verification mail, membership, assignment, browser registration and full engine routing.

## Full application calling acceptance

The disposable full-stack harness now passes with two actual authenticated users, locally captured verification mail, organization membership, extension assignment, WSS registration, extension routing, answer, bidirectional measured audio, remote hangup and return to the dialer. No account lookup or routing admission fixtures are used. This exposed and fixed three native integration gaps: SIP leg IDs were rehashed as Asterisk IDs, outbound legs were not registered with the split-plane adapter, and callee SDP settlement was skipped for legs already in the aggregate registry. Inbound media context is now registered before the routing program can issue commands.

Engine regression coverage now passes 1542 tests. Native regression tests verify registration before signalling, unchanged SIP leg identity and negotiated-answer settlement for an existing aggregate. The full-stack harness remains the proof for outbound registration and browser media across services.

SIPD now retries attaching the control-plane-owned trunk directory and carrier ACL watchers when their buckets do not exist at startup. The dynamic ACL remains empty and refuses carrier traffic until configuration arrives. Race-enabled startup tests pass for delayed availability, single attachment and shutdown cancellation. Full-stack validation confirms late directory attachment and initial trunk replay.

The softphone page and active-call panel no longer claim that audio is unimplemented when WebRTC is enabled.

The full-stack test also passes hold/resume with restored bidirectional audio, both CDR legs under one call, and zero remaining media sessions after remote hangup. SIP server callbacks now retain the transaction until completion so asynchronous ringing/answer commands no longer hit a terminated transaction. The acceptance test refuses any dialog-effect errors. Go race tests cover callback retention and release.

The media watchdog now skips intentional hold/direction suppression and gives resumed legs a fresh RTP recovery interval. A regression test advances through a two-minute hold, checks immediate resumption is preserved, then verifies that a resumed call with no recovering audio still times out. All mediad packages pass race tests. The 35-second full-application hold acceptance run passes, including restored two-way audio, both CDR rows, zero remaining media sessions and no SIP dialog-effect errors. This run also exposed and fixed the outbound ringing timer surviving answer: answered dialogs now cancel that timer, and the timeout callback and installation both check serialized dialog state. A real UDP carrier regression holds an answered call beyond its short ringing deadline and verifies that no BYE occurs until explicit hangup.

Latest validation for this pass: engine 1542 tests, web 741 tests, engine/web typechecks, SIPD and mediad race tests, full application long-hold acceptance, and the web production image build pass. All containers and synthetic databases from the harness were removed. Local source and image proof does not establish Telnyx or public-network readiness.

## September 8 follow-up

Full application acceptance now also passes sequential and simultaneous ring groups with an offline member and a reachable browser agent, and a queue with an authenticated agent login. Each checks measured two-way audio, hold/resume, hangup, shared call history and release of both media sessions. Queue projections now carry the logical extension number separately from legacy media endpoint strings, so native registration lookup does not attempt to resolve `sip:PJSIP/1002@realm`. External queue-agent endpoints still need native trunk routing coverage.

SIP dialog requests now implement strict as well as loose Route sets, including secure IPv6 next hops. Race-enabled SIPD tests cover ACK, BYE, UPDATE and re-INVITE target and route ordering.

Native click-to-call now claims and registers the caller leg before originating, waits for the caller's SDP answer, and then starts ordinary organization routing. Full application acceptance passes audio, hold/resume, returned API IDs matching CDR rows, hangup and cleanup. An unanswered caller rings for five seconds, never rings the destination, produces one unbilled CDR and releases media. Answered callers no longer receive an invalid SIP ringing command when routing begins.

New CDR rows use the domain leg ID; event IDs remain separate UUID v7 values, persisted for retries. Existing reporting snapshots retain their previous CDR ID. The event consumer must be upgraded before or alongside the engine because the CDR contract now accepts domain UUIDs of other versions. Tests cover UUID versions 3, 4 and 7 and recovery with stable event and row IDs.

Queue recording policy now reaches call control. Recording completion is watched from start, so media-session release cannot discard the completion before call cleanup asks for it. Duration and finalized byte counts pass through the native event adapter into recording metadata. Full application acceptance passes a recorded queue call, call-leg linkage and signed WAV download from shared storage. Extension recording policies still need runtime wiring and acceptance.

Latest checks: engine 1545 tests; API 1166 tests; events 383 tests (12 gated integration cases skipped in this run); all 29 workspace typecheck tasks before the final recording changes, followed by a passing engine typecheck; SIPD race tests; local API, engine and SIPD image builds. Earlier gated broker, media-cluster, TURN, and web results remain separately documented above.

Read-only Telnyx inspection found two active numbers assigned to fax services, one inactive fax SIP connection, and an active Default outbound profile. No account configuration was changed. The dedicated voice connection plan and live-test prerequisites are in `plans/telnyx-setup-2026-09-08.md`.

## Remaining work

- Expand authenticated UI acceptance beyond extension assignment and the passing softphone lifecycle; verify production deployment configuration.
- Further carrier interoperability and session refresh lifecycle beyond the passing authentication/cancellation tests.
- Shared-line runtime, conference capacity/media targeting and cross-call media relocation.
- Early media, delayed offers and local SIP session refresh; browser hold/resume renegotiation now passes the full application test.
- Carrier emergency activation and approved test procedure.
- Distributed quotas/CPS, abuse controls, observability, recovery and backup/restore.
- Extend passing two-user application calling acceptance to transfers, voicemail, load and fault scenarios; queue and ring-group calling now pass.
- Authorized Telnyx and physical endpoint verification, public DNS, TLS certificates, reachable media addresses and final deployment.

The question about hosting and the public SIP domain remains pending. Independent local implementation continues. Logs are under /tmp/optimiq-voice-audit-20260907/; no live deployment is represented by these local results.
