# Optimiq Voice — Master Migration & Productization Plan

**Date:** 2026-08-05 · **Status:** DRAFT for review · **Owner:** Jaya Raj Srivathsav Adari
**Mission:** Turn this repo into a complete, end-to-end, multi-tenant phone system for organizations — a 100% TypeScript control plane (NestJS 11 + Fastify 5 + Effect 4) and a Next.js 16 admin frontend — using FreeSWITCH as capability inspiration and FusionPBX as the feature spec, then deleting both source trees.

---

## 1. Executive Summary

Today this repo is a CPaaS/voice-AI platform (Fonoster fork): Routr does SIP signaling, Asterisk 20 does media via ARI + AudioSocket, rtpengine relays RTP, and a thin NestJS shell fronts a hand-rolled gRPC server. It has **zero PBX features** — no extensions, voicemail, IVR-as-product, queues, ring groups, conferencing rooms, park/pickup, time conditions, provisioning, or real tenant enforcement.

The plan builds the PBX as a new set of bounded-context TypeScript services following the oikos-care architecture exactly (Effect runtime seam, Drizzle RLS multi-tenancy, guard-then-execute services, UUID v7, oxlint/oxfmt/turbo), models every feature as a first-class entity that _compiles_ to routing config (never hand-edited dialplans), and replaces the FusionPBX PHP admin with a Next.js 16 app on Base UI + Tailwind 4 + TanStack.

**Polyglot by design (revised per owner direction 2026-08-05):** TypeScript is the default for all product/control-plane code; **Go is used where the 2026 industry consensus is Go** — the RTP media plane and the SIP edge (LiveKit SIP and jambonz mediajam both converged on Go+Pion; pure-TS RTP is not production-viable due to V8 GC tail latency vs 20ms frame deadlines); **Rust is reserved for proven hot paths** (str0m/rsipstack watch list — adopt only when a measured bottleneck justifies it). Asterisk 22 LTS serves as _scaffolding_ to ship the PBX fast, then our owned Go services (`mediad`, `sipd`) replace it feature-by-feature. The system is microservices on a **NATS JetStream backbone** (typed events, durable consumers, KV for live state, request-reply for inter-service RPC).

---

## 2. Current State (from full-codebase inventories)

### 2.1 What exists and works (keep/extend)

| Asset                                         | State                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity (`packages/identity`)                | **REMOVED (owner decision 2026-08-05):** the custom RS256 gRPC identity service, `apps/identity`, `packages/identity`, `packages/identity-client`, and the `fnidentity` DB are all retired. Auth layer = **better-auth 1.6.23** (drizzle adapter; plugins: organization→workspaces, apiKey, admin, twoFactor, jwt+bearer for service/per-call tokens) hosted in `apps/api`, consumed by `apps/web` via better-auth/react. Simpler, one DB, matches oikos. |
| Call session substrate (`apps/api/src/voice`) | ARI dispatcher + per-call VoiceClient, AudioSocket media streaming, verb handlers (answer/play/say/gather/record/dial/stream). Works; single-instance stateful.                                                                                                                                                                                                                                                                                           |
| Voice app framework (`packages/voice`)        | gRPC bidi `CreateSession` stream + verb API. This is our ESL-outbound equivalent.                                                                                                                                                                                                                                                                                                                                                                         |
| Autopilot (`apps/autopilot`)                  | XState 5 + LangChain AI voice agent w/ Silero VAD. Keep as an app type.                                                                                                                                                                                                                                                                                                                                                                                   |
| SIP CRUD (`packages/sipnet`)                  | Thin facade over Routr SDK (agents/domains/trunks/numbers/ACLs/credentials). Survives until Phase 6.                                                                                                                                                                                                                                                                                                                                                      |
| Dashboard (`apps/dashboard`)                  | RR7 + MUI + gRPC-web. CRUD patterns/auth flow good; framework+transport wrong for the PBX product. Superseded by new Next.js app.                                                                                                                                                                                                                                                                                                                         |
| SDK/CLI/MCP                                   | Regenerate against the new API surface.                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 2.2 Critical defects to fix in place

1. Effect used in exactly one file, imported via a relative `node_modules` path (`apps/api/src/runtime/app-runtime.mts`) — replace with the oikos runtime seam.
2. Drizzle "migrations" are a `SELECT 1` baseline over Prisma-era DDL — rebuild journals properly.
3. Nest is a shell; real gRPC server is hand-rolled — move to proper NestJS modules + controllers (HTTP-first, see §4.4).
4. Multi-tenancy is `accessKeyId` string-matching — replace with Postgres RLS per the oikos tenant-role pattern.
5. `GET /api/recordings/:id` has **no authorization check**; recordings on container-local disk — S3-compatible object storage + signed URLs + ownership checks.
6. Voice dispatcher state is an in-process `Map` (single instance, no drain) — session state to Redis; graceful drain.
7. Asterisk 20 → security-only 2026-10-19 — upgrade to 22 LTS in Phase 0.
8. Routr crash-loops (autoheal sidecar as "fix"); upstream velocity down ~88% — contain, then replace (Phase 6).

### 2.3 Reference inventories (research artifacts)

- **FreeSWITCH:** 67-capability checklist in 4 tiers; channel state machine (`NEW→INIT→ROUTING→EXECUTE→EXCHANGE_MEDIA→HANGUP→REPORTING→DESTROY`); call states driving BLF; A/B legs + 4 bridge modes; media bugs; Q.850+ hangup-cause taxonomy; ESL inbound/outbound model; dialplan contexts/conditions/actions with time-of-day predicates; vanilla feature-code map.
- **FusionPBX:** 77 apps + 20 core subsystems, ~110 tables; settings cascade (default→domain→user→device_profile→device); domain_uuid on everything; ~940 permissions (to be collapsed); the compiled-dialplan + cache-invalidation contract; 29-vendor provisioning template library (~947 provision settings).
- **Ecosystem (verified 2026-08):** No pure-TS media plane in production. LiveKit SIP = Go+Pion, no REGISTRAR/SIPREC. jambonz v11 replaced FreeSWITCH with closed-source Go "mediajam" (2.6× density). FreeSWITCH public tree near-dormant (77 commits/52wk), MPL 1.1, open-core. Asterisk 22 LTS healthy (289 commits/52wk, supported to 2028). Kamailio healthiest signaling (1,492 commits/52wk). rtpengine + mediasoup healthy. Routr declining sharply.

---

## 3. Target Architecture

### 3.1 Principles

1. **Right language per plane, TS by default.** Control plane, routing brain, feature logic, APIs, frontend, tooling: TypeScript on the oikos stack. **Data planes in Go**: `mediad` (RTP/media server on Pion — the mediajam/LiveKit-proven path) and `sipd` (SIP registrar/proxy/edge on sipgo). **Rust only for measured hot paths** (candidate: RTP relay/SRTP crypto via str0m if Go profiling demands it). No C/C++ code of our own; Asterisk 22 is temporary scaffolding with a hard retirement path.
   1b. **Microservices with a proper NATS backbone.** Every service is independently deployable, communicates via NATS (JetStream events + KV live-state + request-reply RPC) or versioned REST/gRPC contracts, owns its own data, and emits schema-validated events. No shared databases across service boundaries; no ad-hoc HTTP calls between backends.
2. **oikos conventions are law.** Effect runtime seam (`ModuleEffectRuntime` + `runEffect` + `Schema.TaggedErrorClass.toHttpException()`), repositories as `Context.Service` layers, guard-then-execute, explicit `VALID_TRANSITIONS` state tables, UUID v7, kebab-case+role-suffix files, `…Failure/…Exception/…Error` naming, granular `effect/*` imports, pnpm catalogs, oxlint/oxfmt/turbo, Bun tests.
3. **Features are entities; routing is compiled.** Every PBX feature (IVR, ring group, queue, time condition…) is a first-class table. A **Routing Compiler** materializes them into the runtime routing model with FusionPBX-style cache keys and invalidation on save. Nobody edits "dialplan rows."
4. **One call-control protocol.** The FreeSWITCH ESL model and the existing Voice gRPC stream unify into a single typed, Effect-based session protocol (events in, verbs out) that the PBX engine, Autopilot, and customer apps all speak.
5. **Tenant isolation in the database.** Every org-scoped table gets RLS with a tenant role + `set_config` transaction wrapper + boot-time preflight, per oikos `atlas-db`.
6. **Clean breaks.** No FreeSWITCH/FusionPBX code, schemas, or naming survive. `apps/freeswitch/` and `apps/fusionpbx/` are deleted once inventories are frozen in `plans/reference/`.

### 3.2 System topology (target)

```
                      PSTN / carriers                Desk phones / softphones / WebRTC
                            │ SIP                            │ SIP / WSS
                            ▼                                ▼
                ┌──────────────────────────────────────────────────┐
                │  SIP EDGE  (signaling: registrar/proxy/auth/NAT) │  Scaffold: Routr (contained)
                │                                                  │  TARGET: apps/sipd (Go · sipgo)
                └───────────────┬──────────────────────────────────┘
                                │                    ┌─────────────┐
                                ▼                    │  rtpengine  │ RTP relay/SRTP
                ┌──────────────────────────┐         └─────────────┘
                │  MEDIA ENGINE            │  Scaffold: Asterisk 22 LTS (ARI + AudioSocket)
                │  bridges·play·record·moh │  TARGET: apps/mediad (Go · Pion; mediajam pattern)
                └───────────┬──────────────┘
                            │ ARI events/commands + AudioSocket PCM
                            ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  apps/engine  — THE PBX BRAIN (NestJS+Fastify+Effect, horizontally     │
   │  scalable, session state in Redis)                                     │
   │  · Channel/session state machines (FS-inspired, Effect fibers)         │
   │  · Routing executor: consumes compiled routing model                   │
   │  · Feature runtimes: IVR, ring groups, queues/ACD, voicemail, park,    │
   │    pickup, conferences, follow-me, time conditions, feature codes      │
   │  · Session protocol server (typed events/verbs) → autopilot, apps      │
   │  · CDR writer (per-leg, Postgres partitioned)                          │
   └───────┬───────────────────────────┬────────────────────────────────────┘
           │ NATS (typed events)       │
           ▼                           ▼
   ┌───────────────────┐    ┌─────────────────────────────────────────────┐
   │ apps/identity     │    │  apps/api  — CONTROL PLANE (NestJS+Fastify) │
   │ (existing, kept)  │    │  · All PBX CRUD (extensions, devices, DIDs, │
   └───────────────────┘    │    trunks, routes, IVR, queues, VM, …)      │
                            │  · Routing Compiler + cache invalidation    │
   ┌───────────────────┐    │  · Provisioning endpoint (device configs)   │
   │ apps/autopilot    │    │  · Recordings/voicemail media API (S3+sign) │
   │ (kept, speaks the │    │  · CDR query/reporting API                  │
   │  session protocol)│    │  · WebSocket fan-out (permission-filtered)  │
   └───────────────────┘    └─────────────────────────────────────────────┘
                                       ▲ REST (OpenAPI) + WS
                                       │
                            ┌──────────────────────────┐
                            │ apps/web — Next.js 16    │  replaces FusionPBX + dashboard
                            │ Base UI · Tailwind 4 ·   │
                            │ TanStack · better-auth-  │
                            │ style session bridge     │
                            └──────────────────────────┘
Infra: Postgres 17 (RLS), NATS 2.11+ JetStream+KV (events, live state, RPC — see §3.5; replaces Redis),
S3-compatible object store (recordings/voicemail/greetings), InfluxDB → retired after CDR moves to Postgres.
```

### 3.3 Monorepo layout (target)

```
apps/
  api/          # control plane (rebuilt in place, NestJS modules per feature slice) [TS]
  engine/       # NEW — realtime PBX brain (feature runtimes, session protocol, media driver) [TS]
  sipd/         # NEW (Go · sipgo) — SIP edge: registrar/proxy/auth/NAT/TLS/WSS → retires Routr
  mediad/       # NEW (Go · Pion) — media server: RTP/SRTP, codecs, bridges, conf mixing,
                #   play/record, MOH, DTMF; driven by engine over typed control protocol → retires Asterisk
  identity/     # kept (standalone identity service) [TS]
  autopilot/    # kept (AI agent, ported to session protocol) [TS]
  web/          # NEW — Next.js 16 admin + user portal (replaces dashboard + fusionpbx)
  ctl/ mcp/     # regenerated against new API
  (Go apps live in a `go.work` workspace; single repo, per-app go.mod, CI parity with turbo)
packages/
  common/       # effect seam (memo-map, runtime, module-runtime, run-effect), permissions, utils
  config/       # zod env validation (oikos pattern)
  identifiers/  # uuid v7 entity ids
  logging/      # pino + redaction + otel
  db/           # base: primitives, connection budget, RLS preflight harness
  pbx-db/       # bounded context: telephony schema + tenant role + journal
  cdr-db/       # bounded context: CDR/partitioned reporting schema + journal
  telephony/    # domain types: channel states, hangup causes (Q.850+), call events, verbs
  events/       # NATS contract package: subject taxonomy + Zod schemas → generated Go structs (§3.5)
  session-protocol/  # typed call-control protocol (events/verbs) client+server
  media-ari/    # Asterisk ARI adapter (quarantines all ARI weirdness)
  streams/      # AudioSocket (kept)
  routing/      # routing model types + compiler
  provisioning/ # device template engine + vendor catalogs
  sdk/          # regenerated TS SDK (REST + WS)
DELETED: apps/freeswitch, apps/fusionpbx, apps/asterisk→(replaced by infra/asterisk config),
         apps/dashboard (after web reaches parity), packages/sipnet (Phase 6), prisma-era migrations.
```

### 3.4 The media/signaling decision (explicit options)

**RESOLVED (owner, 2026-08-05): polyglot path — Option A as scaffolding now, plus an owned Go data plane built in parallel (Option E) that retires Asterisk and Routr feature-by-feature.**

|               | **E. Owned Go data plane (TARGET)**                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sipd` (Go)   | SIP edge: registrar (digest auth, Redis/NATS-KV location), proxy, NAT handling, TLS/WSS, OPTIONS ping, trunk state. Stack: **sipgo** (proven under LiveKit SIP). Replaces Routr.                                                                                                                                                            |
| `mediad` (Go) | Media server: RTP/SRTP via **Pion**, G.711/G.722/Opus (+AMR-WB), bridging, DTMF RFC 2833, play/record (S3), MOH streams, conference mixing w/ mix-minus, jitter buffer. Control protocol: typed gRPC/JSON-over-TCP driven by `apps/engine` (mediajam pattern — the TS engine never changes when the media server swaps). Replaces Asterisk. |
| Precedent     | jambonz mediajam: 2.6× session density vs FreeSWITCH, 12× lower base memory; LiveKit SIP: same stack at ChatGPT-voice scale.                                                                                                                                                                                                                |
| Rust          | Watch str0m/rsipstack; adopt inside `mediad`/`sipd` only on measured hot-path need.                                                                                                                                                                                                                                                         |

| Option                                                           | What                                                              | Pros                                                                                                                                                                                                     | Cons                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Asterisk 22 LTS behind `packages/media-ari` (RECOMMENDED)** | Upgrade 20→22.10; drive everything via ARI; engine owns all logic | Already integrated & working; healthiest full-featured media server (LTS to 2028); conferencing (ConfBridge)/MOH/park/DTMF/T.38 solved in ONE process; zero migration risk; ARI REST is versioned/stable | C dependency; ARI is a chatty protocol; per-call overhead higher than Go planes                                                                                                                                                                                           |
| B. LiveKit SIP + LiveKit server                                  | Go+Pion media, rooms model, best AI-voice ecosystem               | Excellent WebRTC + AI agent story; active, funded                                                                                                                                                        | **No SIP registrar**; no SIPREC; trunks lack Opus (PCMU/PCMA/G722/AMR-WB only); per-leg O(n²) conference mixing; rtc-node "not production-ready"; rooms model ≠ PBX call model                                                                                            |
| C. Kamailio/drachtio + rtpengine + TS B2BUA                      | Healthiest signaling; we write B2BUA logic in TS                  | Max control, telecom-grade; rtpengine covers transcode/T.38/DTMF/record/MOH                                                                                                                              | rtpengine does **NOT** conference-mix (no mix-minus/rooms) → needs a 3rd process (Janus AudioBridge / ConfBridge / mod_conference) for conf/IVR/VM audio — jambonz's exact 3-process shape; largest build cost                                                            |
| D. Pure TS (werift/custom RTP)                                   | —                                                                 | 100% TS                                                                                                                                                                                                  | **Not production-viable**: V8 GC tail latency vs fixed 20ms frame deadlines (~15-25 calls/process before stutter); no JS G.722/G.729/PLC/CN; werift is video-oriented; reject. (Opus-in-WASM is near-native now — useful at the AudioSocket seam, not for packet pacing.) |

**Sequencing rule:** the PBX product ships on scaffolding (Routr contained behind `packages/sipnet`; Asterisk 22 behind `packages/media-ari`) while `sipd`/`mediad` mature behind the same engine-facing contracts. Cutover is per-capability (registrations first, then bridged calls, then conferencing/T.38 last) gated by SIPp + media-quality (MOS/jitter) test suites. Registration/location and session state live in NATS KV from day one so both edges are swappable.

### 3.5 NATS backbone design (proper NATS)

- **JetStream event streams** (durable, replayable): `CALLS` (`calls.evt.<org>.<callId>.*` — channel/bridge/dtmf/record events), `REGISTRATIONS` (`sip.reg.<org>.*`), `QUEUES` (`queue.evt.<org>.<queueId>.*`), `CDR` (`cdr.leg.<org>.*` — the CDR writer is a durable consumer; replay = rebuild), `AUDIT`, `PROVISION`. Retention/limits per stream; DLQ pattern via max-deliver + advisory subjects.
- **KV buckets** (ephemeral truth, TTL where apt): `registrations` (AOR→contacts), `channels` (live channel state for engine failover/drain), `presence` (BLF/device state), `agent-state`, `routing-cache` (compiled routing artifacts w/ invalidation by key — the FusionPBX contract, done properly).
- **Request-reply (NATS services API)**: `rpc.routing.resolve` (engine→api routing lookups on cache miss), `rpc.media.*` (engine→mediad commands post-Asterisk), `rpc.authz.check`. Versioned subjects (`.v1`).
- **Contracts in `packages/events`**: every subject's payload is a Zod schema (TS) + generated Go structs (single source: JSON Schema emitted from Zod; CI checks cross-language drift). No untyped publishes — lint-enforced.
- **Client layer (owner decision 2026-08-05): no custom NATS framework.** `packages/events` is a pure contracts package (subjects, Zod schemas, declarative JetStream stream/KV bucket definitions, thin pure helpers + idempotent `ensureStreams`/`ensureKvBuckets` applicators). App-side wiring uses NestJS's built-in NATS transport (`@nestjs/microservices` + `nats` catalog version) for core request-reply and events; apps that need JetStream durability or KV use the raw `nats` JetStream/KV API directly against the declarative definitions.
- Ordering/idempotency: per-call subject ordering via JetStream; consumers idempotent by event UUID v7; exactly-once not assumed.

---

## 4. Domain Model & API

### 4.1 Bounded contexts (each its own DB package + feature-slice modules)

1. **Tenancy & Auth:** better-auth (users, sessions, organizations=tenants, members/invites, API keys, 2FA) on Drizzle in the base DB; per-call/service JWTs via better-auth jwt plugin; `organizationId` from the active-org session claim drives RLS. No custom identity service.
2. **Telephony Inventory:** extensions (trimmed to ~25 fields from FusionPBX's 55), devices+lines+keys+device-profiles, DIDs/numbers, trunks/gateways, emergency (E911 dispatchable location per number).
3. **Routing:** inbound routes, outbound routes (+dial patterns, toll classes), time conditions, feature codes, number translations; the compiled routing artifact.
4. **Call Features:** IVR menus (nested), ring groups, queues/ACD (agents/tiers/strategies/wrap-up), voicemail (boxes/messages/greetings/options + MWI), conferences (rooms/PINs/moderators), park lots, pickup groups, follow-me/forward/DND, MOH classes, prompt library, call block.
5. **Live State:** registrations, active channels/calls, queue/agent presence, BLF — Redis-backed, WS fan-out, never persisted as "truth."
6. **CDR & Recording:** per-leg CDRs (linked A/B legs, transfer/bridge records, hangup causes) in partitioned Postgres; recordings/voicemail media in S3 with ownership + retention; transcription hooks.
7. **Provisioning:** vendor/model catalogs (data-driven, top-5 vendors v1: Yealink, Poly, Grandstream, Fanvil, Snom), template rendering, MAC-token-authenticated config endpoint (fix FusionPBX's unauthenticated design), softphone QR onboarding.
8. **Settings:** 3-level cascade (platform default → org → user; device-profile → device for provisioning), category/name/value typed, cached with invalidation.

### 4.2 The call engine model (FreeSWITCH-inspired, Effect-native)

- `Channel` = one leg; explicit state machine with `VALID_TRANSITIONS` const; states mirror FS (`created→routing→executing→bridged→held→hangup→reported`); user-visible call states for BLF.
- `Call` = A-leg + B-legs + bridges; `Bridge` supports media + signal-only modes.
- Verbs (session protocol): answer, ringing, earlyMedia, play, say, gather, record, dial (multi-target ring-all/sequential with lose-race semantics + `continueOnFail` cause lists), bridge, transfer (blind/attended), hold/moh, park, dtmf, hangup(cause).
- Hangup causes: adopt the full Q.850 + FS-extended taxonomy verbatim (`LOSE_RACE`, `ATTENDED_TRANSFER`, `MEDIA_TIMEOUT`, …) — routing keys off it.
- Events: typed superset of ARI mapped to FS-style semantic events (`channel.created/answered/bridged/held/dtmf/recordStarted/hangup` + `registration.*`, `queue.*`, `conference.*`), published on NATS, schema-validated.

### 4.3 Tenancy & RBAC

- RLS everywhere (oikos `atlas-db` pattern): tenant `pgRole`, `set local role` + `set_config` wrapper, boot preflight, append-only policies for CDR/audit.
- Permissions: collapse FusionPBX's ~940 to `<resource>.<action>[.<scope>]` (~80 entries) + `SYSTEM_ROLE_TEMPLATES` (owner/admin/manager/user/agent), defined once in `packages/common`, code-genned to the frontend (oikos sync-permissions bridge).

### 4.4 API surface

- **REST (OpenAPI) + WebSocket**, replacing gRPC-web for the product UI (research + oikos precedent; the Envoy gRPC-web hop dies). gRPC survives only where it earns its keep: identity interop and the engine↔autopilot session stream.
- Controllers thin, DTO-validated, `@RequirePermissions`; SDK generated from OpenAPI.

---

## 5. Feature Scope (tiers = delivery order, from FS/FusionPBX checklists)

- **T0 (substrate):** channels/bridging/originate, DID inbound routing, outbound trunk routing + failover, CDR per leg, recordings to S3, registrations view, typed events, hangup-cause taxonomy.
- **T1 (org PBX MVP):** extensions + internal dialing + busy/no-answer fallback, voicemail + MWI + email, IVR menus, ring groups, time conditions, hold/MOH, transfers (blind+attended), forward/DND/follow-me, park/pickup, feature codes (*97, *8, *69…), inbound/outbound route builder, ACL/anti-fraud (never route unauthenticated → trunk contexts; rate limits; fail2ban events), E911 (Kari's Law/RAY BAUM'S), settings cascade, RBAC, audit log.
- **T2 (business depth):** queues/ACD + agent states + wallboard, conferences w/ PINs & controls, device provisioning (top-5 vendors + QR softphones), BLF/presence, eavesdrop/whisper/barge, CNAM, call block, paging/intercom, recordings policy (always-on/on-demand, pause/mask), reporting dashboards, concurrency limits per org.
- **T3 (platform):** WebRTC softphone in `apps/web` (reuse sip.js hook), fax T.38 (via Asterisk), LCR, billing hooks (authz meter events), SLA/shared lines, multi-region, HA drain/recovery.

## 6. Stack (pinned to oikos catalogs)

Backend: Effect `4.0.0-beta.83` + `@effect/sql-pg`, drizzle-orm `1.0.0-rc.4`, NestJS `^11.1.19` + platform-fastify, fastify `^5.8.5`, zod `^4.4.3`, jose, uuid v7, TS6/TS7-native typecheck, Bun ≥1.3.10 tests, pnpm catalogs, oxlint/oxfmt, turbo, husky. Frontend: Next `16.3.0`, React `^19.2.6`, Base UI `1.7.0`, Tailwind `^4.3.0`, TanStack Query/Form/Table/Virtual, nuqs, zustand, motion, vitest 4 + Storybook 10 + rustywind + lefthook. Full version tables + conventions checklist: `plans/reference/oikos-conventions.md`.

## 7. Delivery Roadmap

- **P0 Foundations (repo hygiene):** adopt oikos root configs (catalogs, tsconfig, oxlint/oxfmt, turbo, bunfig); `packages/{common,config,identifiers,logging,db}`; Effect seam; rebuild Drizzle journals; Asterisk 20→22; freeze reference docs; **delete `apps/freeswitch` + `apps/fusionpbx`**.
- **P1 Data layer + auth:** `pbx-db` + `cdr-db` with RLS + preflight; **better-auth layer replaces the identity service** (schema, org/apiKey/jwt plugins, session→org context, Fastify mount, `@RequirePermissions` guard over better-auth sessions); delete `apps/identity`, `packages/identity`, `packages/identity-client`, `fnidentity` DB; settings cascade; permissions registry + codegen bridge.
- **P2 Engine core (T0):** `apps/engine` + `packages/{telephony,events,session-protocol,media-ari,routing}`; NATS JetStream/KV backbone stood up per §3.5 (session/registration state in KV); port existing voice handlers; per-leg CDR via durable consumer. Parity gate: today's inbound/outbound/autopilot flows work through the new engine.
- **P3 PBX MVP (T1):** inventory + routing CRUD in `apps/api`; routing compiler + invalidation; feature runtimes (IVR, ring groups, VM, transfers, park…); anti-fraud.
- **P4 Web app:** `apps/web` Next 16 (auth, org admin for all T1 entities, live registrations/calls via WS, CDR explorer, IVR builder); port dashboard's proven flows; retire dashboard at parity.
- **P5 Business depth (T2):** ACD + wallboard, conferences, provisioning, BLF, reporting; SDK/ctl/mcp regen.
- **PG (parallel Go track, starts alongside P3):** `apps/sipd` v1 (registrar/auth/location on NATS KV, proxy to media plane) shadow-deployed → replaces Routr when registration + basic-call SIPp suites pass. `apps/mediad` v1 (RTP, G.711/Opus/G.722, bridges, play/record, DTMF, MOH) behind the same engine contract as `media-ari` → per-capability cutover (bridged calls → recording → conferencing mix-minus → T.38 last). Asterisk retired at full parity.
- **P6 Consolidation:** Routr + Asterisk + `packages/sipnet` + `media-ari` deleted; InfluxDB retired; Rust hot-path evaluation inside sipd/mediad with production profiles.
- Each phase = OpenSpec change proposal → review → implement → test gate (Bun unit + DB-integration + SIPp/e2e call-flow tests) → ship. Opus 5 subagents execute; I lead and review.

## 8. Risks

1. **`mediad` is the hardest artifact in the plan** (conference mix-minus, jitter buffers, codec edge cases took jambonz/LiveKit years). Mitigations: it's a parallel track, never on the product critical path; Asterisk scaffolding ships every feature first; the engine-facing contract is identical for `media-ari` and `mediad` (mediajam precedent proves zero engine churn at swap); cutover per-capability behind SIPp + MOS/jitter gates; Pion ecosystem is mature and Apache-licensed (LiveKit SIP code is directly studyable).
   1b. **Polyglot overhead** (Go+TS toolchains, cross-language event contracts) — contained by `packages/events` single-source schemas with CI drift checks and `go.work` in-repo.
2. **Provisioning underestimation** (FusionPBX's largest surface) — v1 scoped to 5 vendors, data-driven catalog, authenticated endpoint.
3. **Routing compiler correctness** — golden-file tests from FreeSWITCH vanilla dialplan semantics; the invalidation contract is spec'd before code.
4. **Effect 4 beta + Drizzle 1.0 RC churn** — exact-pinned via catalogs/overrides (proven daily in oikos).
5. **Engine statefulness/HA** — NATS KV session state + drain from day one (P2), not retrofitted.
6. **Two parallel frontends temporarily** — hard parity gate then dashboard deletion; no long-term dual maintenance.

## 9. Decisions

1. **D1 — RESOLVED (2026-08-05):** polyglot — Asterisk 22/Routr as scaffolding, owned Go data plane (`sipd`+`mediad`) as target, Rust for measured hot paths only, NATS JetStream/KV backbone.
2. **D2 — REST+WS for the product API** (gRPC only for identity + engine↔apps + engine↔mediad), dashboard retired at P4 parity? _(recommended yes — awaiting explicit confirm)_
3. **D3 — Repo naming:** keep `fonoster` dir/scope `@optimiq-voice/*` or rename repo now?
4. **D4 — Voicemail/queue audio location:** engine-driven (recommended — media-server-agnostic, survives the mediad cutover unchanged) vs Asterisk-native apps (faster now, thrown away at cutover).
