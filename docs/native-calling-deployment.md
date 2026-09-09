# Native calling deployment

This deployment runs the API, web application, engine, SIP edge and media service. Telnyx supplies the carrier connection. The application owns routing and media. Local acceptance is recorded in `plans/implementation-progress-2026-09-07.md`; it is not evidence of public-network or carrier acceptance.

## Configuration

Use a Linux host with a stable public IPv4 address and Docker Compose. Copy `.env.voice.example` to `.env.voice` and replace all example domains, addresses and credentials. Generate distinct random secrets. Runtime files are ignored by Git.

- Point the web domain at an HTTPS ingress forwarding to port 3100. Preserve WebSocket upgrades for `/api/v1/live` and session sockets. Set `AUTH_URL` and `API_APP_URL` to this public HTTPS origin.
- Point each organization's SIP domain at the SIP edge. Configure that domain in Settings before assigning phones. Each organization must have a unique domain; extension 1001 can then exist in several organizations.
- Install the SIP/TURN certificate chain and private key in `VOICE_CERTS_DIR`. Certificate names must cover the WSS and TURN hostnames. SIPD runs as UID 1001 and must be able to read the files. Renew and restart the affected listeners when rotating certificates.
- Copy `config/turn/turnserver.conf.example` to its ignored runtime path. Its shared secret must match `PROVISION_TURN_SECRET`. Allow only the deployed media addresses as TURN peers. Coturn uses Linux host networking.
- Configure SMTP. Production signup requires email verification; the API refuses a production mail configuration that would log one-time links instead of delivering them.

The fresh-volume initializer creates `optimiq_voice`, `optimiq_pbx` and `optimiq_cdr`. It does not modify existing volumes. Existing installations must retain their actual database names in every URL.

## Database migration and runtime principals

The `migrate` job applies the auth, PBX, CDR and legacy API journals in order. It requires owner URLs, an explicit deployment stage and `DATABASE_MIGRATION_CONFIRM_PRODUCTION=apply` for production. The API waits for successful completion. Runtime service containers do not receive migration owner URLs.

Before the first API start, provision the three runtime logins in `.env.voice` using the database administration system. They must be dedicated non-superuser roles, with no database/role creation privileges. Grant connection, public-schema usage, table DML and sequence usage on their respective database. Grant the default privileges for future tables created by the migration owner too.

The current repository's PBX/CDR admin workers require an owner or BYPASSRLS principal. Use dedicated non-owner BYPASSRLS runtime roles for those two databases, and grant membership in `pbx_tenant_tls` / `cdr_tenant_tls` respectively. Request-scoped operations switch to these non-inheriting tenant roles and set the organization inside a transaction. Tenant roles must not receive BYPASSRLS, ownership or additional mutation privileges. The preflight checks this split at startup. Auth uses its separate base database. This admin-worker privilege is a current architectural requirement, not a claim that the application login itself is tenant-isolated.

Validate configuration without starting services:

```sh
docker compose --env-file .env.voice -f compose.yaml -f compose.voice.yaml --profile webrtc config --quiet
```

After reviewing the target databases and migration changes, run the migration job before starting the API. An existing installation needs a verified backup and restore procedure before applying migrations. The published `migrations` image uses the API builder stage and includes the package migration runners.

## Network paths

| Traffic         | Destination                | Notes                                                      |
| --------------- | -------------------------- | ---------------------------------------------------------- |
| Web application | HTTPS ingress → web:3100   | Keep API/NATS/DB private                                   |
| Phone SIP       | 5060 UDP/TCP or 5061 TLS   | Organization domain identifies the tenant                  |
| Browser SIP     | 8089 WSS                   | Valid public certificate required                          |
| Carrier SIP     | 5088 UDP/TCP               | Restrict ingress to Telnyx's documented signaling networks |
| Plain RTP/RTCP  | 30000–30999 UDP            | Advertised `MEDIAD_PUBLIC_IP` must be reachable            |
| WebRTC media    | 31000–31999 UDP            | ICE/DTLS/SRTP terminated by mediad                         |
| TURN client     | 3478 UDP/TCP, 5349 TLS/TCP | Expiring credentials supplied by the API                   |
| TURN relays     | 32000–32999 UDP            | Host firewall must preserve relay ports                    |

Telnyx connection configuration must direct inbound calls to the carrier listener. Configure the credential connection, outbound profile, numbers and inbound routes in the application. The carrier credential lookup is scoped to the organization's enabled trunk and checks the Telnyx connection username. API keys and SIP passwords are not carried through routing snapshots.

Use Telnyx's current [SIP trunking documentation](https://developers.telnyx.com/docs/voice/sip-trunking/get-started) and [network allowlist](https://developers.telnyx.com/docs/voice/sip-trunking/network-configuration/ip-whitelisting) when configuring carrier ingress. Verify the configured webhook URL ends in `/api/v1/carrier/webhooks/telnyx`.

## Acceptance

Before enabling real traffic, verify public DNS, certificates, two-way media through the advertised ranges and TURN over UDP and TCP. Then use explicitly approved test endpoints for incoming/outgoing calls, organization routing, transfer, voicemail, recording, reconnection and carrier failures. Emergency calling needs verified number/address activation and Telnyx's approved test procedure; ordinary successful calls do not prove it.

Local test entry points:

- `.scripts/verify-platform-stack.mjs`: fresh migrations, real application containers, signup/verification, organization setup and extension assignments. Set `PLAYWRIGHT_MODULE` to the installed Playwright module path and `BROWSER_MEDIA_IP` to a reachable host address for two-user calling, measured audio, hold/resume, hangup, CDR persistence, media cleanup and delayed directory startup. `HOLD_DURATION_MS=35000` checks a hold longer than the default RTP watchdog. The harness uses disposable databases, synthetic accounts and a local SMTP capture server; it sends no external email or carrier calls. Build the local `optimiq-voice-audit/{api,engine,web,sipd,mediad}:local` images from each app Dockerfile first.
- `.scripts/verify-browser-calling.mts`: two SIP edges, two media nodes and the product browser adapter. Initial account lookup/admission are fixtures. Set `BROWSER_TURN_PUBLIC_IP` and `BROWSER_TURN_TRANSPORT=udp` or `tcp` for relay-only audio and relay-loss checks.
- `.scripts/verify-media-cluster.mjs`: media ownership, recording, routing across instances, teardown and owner loss.

The native deployment still has explicit release gaps in the implementation progress document, including shared-line runtime, full session refresh interoperability, conference placement and capacity, distributed limits and recovery/load proof. Do not treat building the images or passing local tests as completion of these gates.
