# Optimiq Voice Current-State Reference (frozen 2026-08-05)

Inventory of the repo before the PBX build. Fork of Fonoster, `@optimiq-voice/*` scope, v0.22.3, pnpm+lerna+turbo, Node ≥22.13.

## Architecture (as-is)

PSTN → **Routr** (SIP proxy/registrar, own Postgres `routr`, gRPC mgmt :51907 via @routr/sdk, publishes call events → NATS) → peer `voice` = **Asterisk 20** (PJSIP wizard trunk registers outbound to Routr; context local-ctx → MixMonitor → `Stasis(mediacontroller)`; ARI :8088; CDR disabled) + **rtpengine** (RTP relay 10000-10100/udp). **apps/api** (one process: NestJS+Fastify HTTP :9876 bridge + hand-rolled gRPC :50051) consumes ARI: `VoiceDispatcher` → per-call `VoiceClient` → gRPC bidi `Voice/CreateSession` to the app's endpoint (customer voice app or autopilot :50061) + AudioSocket TCP (ephemeral port per call) via Asterisk ExternalMedia for raw media; STT/TTS engines (Deepgram/Google/Azure/ElevenLabs). NATS `calls.create` → originate. Routr events → InfluxDB CDRs (bucket `calls`). Envoy :8449 fronts gRPC-web + HTTP. Identity is a standalone service (packages/identity built into apps/identity image; gRPC 50051 + Fastify 9000, file-configured).

## Databases

1. `optimiq-voice` (apps/api): applications (ref, access_key_id, name, type EXTERNAL|AUTOPILOT, endpoint), products (vendor/type catalog), tts_services / stt_services / intelligence_services (config jsonb + Cloak-encrypted credentials, 1:1 with application), secrets (Cloak-encrypted). Drizzle baseline is `SELECT 1`; real DDL in Prisma-era `migrations/`.
2. `fnidentity` (packages/identity): users, workspaces, workspace_members (PENDING/ACTIVE; roles USER/WORKSPACE_ADMIN/WORKSPACE_OWNER/WORKSPACE_MEMBER), api_keys, verification_codes. RS256 id/access/refresh JWTs; exchanges: credentials, apiKey, oauth2 (GitHub), refresh; RevokeToken in proto but NO handler. accessKeyId prefix US/WO encodes owner type; every telephony resource tagged with owning accessKeyId.
3. `routr` (upstream-owned): agents/domains/numbers/trunks/credentials/acls/peers — all SIP config lives here, reached only via @routr/sdk (packages/sipnet adapts + tags `extended.accessKeyId` and filters lists by it; numbers get `aorLink=sip:voice@default` + `x-app-ref` header).
4. InfluxDB `calls`: CDR measurement (ref, accessKeyId, status, type, from, to, duration, direction, startedAt, endedAt) — write-only, no leg detail.

## Call flows (as-is)

- Inbound: carrier→Routr; number matches w/ x-app-ref → peer voice (Asterisk); local-ctx reads X-App-Ref/X-Call-Direction/X-Call-Ref, derives INGRESS_NUMBER, MixMonitor record, Stasis; api VoiceDispatcher StasisStart → lookup app (DB + integrations.json) → mint per-call JWT → gRPC CreateSession to app endpoint → AudioSocket server + externalMedia channel + mixing bridge → verbs drive ARI handlers (answer/hangup/play/say→TTS/gather/record/dial/mute/stream/sgather). StasisEnd → cleanup. Routr event → NATS → InfluxDB CDR.
- Outbound: Calls/CreateCall → NATS calls.create → runCallManager → ari.channels.originate (PJSIP/routr, X-headers, local-ctx-common) → same as inbound from Stasis.
- dial verb: second mixing bridge + originate via same trunk (TODO: request validation).

## Packages

types (proto-mirroring TS types) · logger (winston+fluentd) · common (all 12 protos, gRPC service defs, auth interceptor, GrpcError, Zod validators, assistant schema, STASIS_APP_NAME/CALL_CONTEXT/header constants, notifications, TTS voice catalogs) · identity (the service lib) · identity-client (lightweight stateless gRPC client) · sipnet (Routr facade: agents/domains/trunks/numbers/acls/credentials CRUD) · voice (VoiceServer framework + VoiceResponse verbs: answer hangup play playDtmf playbackControl gather say stopSay record dial stream sgather mute unmute + on(event)) · streams (AudioSocket TCP protocol impl) · authz (optional external authz/billing hook: CheckSessionAuthorized/CheckMethodAuthorized/AddBillingMeterEvent, Dummy handler) · sdk (dual node/web gRPC client) — plus apps ctl (oclif CLI incl. Twilio number linking), mcp (4 tools), dashboard (RR7+MUI+TanStack over gRPC-web; full CRUD for workspaces/applications/trunks/numbers/domains/agents/acls/credentials/secrets/api-keys + CDR list + sip.js test softphone; design system w/ Storybook).

## Known defects (fix list)

1. Effect in one file via relative node_modules import, dynamic .mjs load (dev needs prior build).
2. Nest is a shell; gRPC server hand-rolled; Nest DI/guards unused.
3. Drizzle migrations fake (SELECT 1 baseline over Prisma DDL).
4. Multi-tenancy = accessKeyId string filtering in app code; no RLS; Routr DB has no tenant column beyond extended JSON.
5. GET /api/recordings/:id — NO authorization; recordings on container-local disk, no volume, no table, no retention.
6. VoiceDispatcher in-process Map + random local AudioSocket ports → stateful single instance, no drain.
7. Two Postgres DBs + Routr's third, no cross-DB transactionality/compensation.
8. Asterisk 20 (security-only 2026-10-19); features.conf placeholder; app_queue/app_voicemail/confbridge/res_parking NOT loaded; no WSS/WebRTC transport; API_SIGNALING_SERVER env declared but never consumed.
9. Routr crash-looping (autoheal sidecar workaround), upstream velocity down ~88%.
10. No OTel/metrics/tracing; winston logs only.
11. RevokeToken unimplemented; dial handler TODO validation.
12. PBX features entirely absent (voicemail/IVR-entity/queues/ring groups/conference rooms/park/BLF/extensions/time conditions/MOH/E911/fax/provisioning/billing rating) — grep-verified zero hits.

## Compose services

dashboard 3030, api 50051/9876, autopilot 50061, routr 5060-5063+51907, rtpengine, asterisk 6060/8088, postgres 16.10, influxdb 2.7, nats 2.11, envoy 8449 (+dev: adminer, mailhog, local builds). ~85 env keys grouped API_/AUTOPILOT_/ROUTR_/ASTERISK_/RTPENGINE_/INFLUXDB_/POSTGRES_/DASHBOARD_.

## OpenSpec

Workflow in place (`openspec/`): archived identity spec; landed changes identity-standalone-service, identity-client; proposed-not-implemented identity-multi-product (Realms: per-realm issuer/audience/keypair). Use OpenSpec change proposals per phase of the PBX build.
