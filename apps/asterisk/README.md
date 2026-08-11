# Asterisk PBX

> Docker image with a minimal Asterisk PBX

[![publish to docker hub](https://github.com/optimiqs/optimiq-voice/actions/workflows/release.yaml/badge.svg)](https://github.com/optimiqs/optimiq-voice/actions/workflows/release.yaml)

This repository contains a dockerized distribution of Asterisk PBX 22 (LTS, supported until 2028) for use in [Optimiq Voice](https://github.com/optimiqs/optimiq-voice). For more documentation on how Optimiq Voice images are constructed and how to work with them, please see the [documentation](https://github.com/optimiqs/optimiq-voice).

## Available Versions

You can see all images available to pull from Docker Hub via the [Tags](https://hub.docker.com/repository/docker/optimiq-voice/asterisk/tags?page=1) page. Docker tag names that begin with a "change type" word such as task, bug, or feature are available for testing and may be removed at any time.

> The image tag is the same of the Asterisk this is image is based on

## Installation

You can clone this repository and manually build it.

```
cd optimiq-voice/asterisk\:%%VERSION%%
docker build -t optimiq-voice/asterisk:%%VERSION%% .
```

Otherwise you can pull this image from docker index.

```
docker pull optimiq-voice/asterisk:%%VERSION%%
```

## Usage Example

The following is a basic example of using this image.

```
docker run -it \
  -p 6060:6060 \
  -p 10000-10010:10000-10010 \
  -e EXTERN_ADDR=${you host address} \
  -e SIPPROXY_HOST=${sip proxy address} \
  -e SIPPROXY_USERNAME=${username at sip proxy} \
  -e SIPPROXY_SECRET=${secret at sip proxy} \
  -e RTP_PORT_START=10000 \
  -e RTP_PORT_END=10010 \
  optimiq-voice/asterisk
```

## Environment Variables

Environment variables are used in the entry point script to render configuration templates. You can specify the values of these variables during `docker run`, `docker-compose up`, or in Kubernetes manifests in the `env` array.

- `ARI_PROXY_URL` - URL for ARI API. Defaults to `http://localhost:8088`
- `ARI_USERNAME` - Username for ARI API. **Required**
- `ARI_SECRET` - Password for ARI API. **Required**
- `SIPPROXY_HOST` - The SIP Proxy's IP address. **Required**
- `SIPPROXY_PORT` - The SIP Proxy's port. Defaults `5060`
- `SIPPROXY_USERNAME` - Username at SIP Proxy. **Required**
- `SIPPROXY_SECRET` - Secret at SIP Proxy. **Required**
- `SIP_BINDADDR` - Where to listen for SIP traffic. Defaults to `0.0.0.0:6060`
- `RTP_PORT_START` - Lower limit of the RTP port range. **Required**
- `RTP_PORT_END` - Upper limit of the RTP port range. **Required**
- `DTMF_MODE` - DTMF mode. Defaults to `rfc2833`
- `CODECS` - Comma separated list of codecs. Defaults to `g722,ulaw,alaw,gsm`
- `HTTP_BINDADDR` - Where to listen for HTTP traffic. Defaults to `0.0.0.0`
- `OPTIMIQ_ARI_APP` - Stasis application the `optimiq-*` contexts hand channels to. Must match `apps/engine`'s `ARI_APP`. Defaults to `optimiq-engine`
- `OPTIMIQ_DEV_ORG_ID` - Organization UUID stamped onto every channel entering the `optimiq-*` contexts. **No default**: unset means the engine rejects inbound calls with `INVALID_PROFILE`, which is correct for a box nobody has assigned to a tenant. Development only — production resolves the org from the DID (see `apps/engine/README.md` §"Known gaps")
- `OPTIMIQ_DEV_ENDPOINTS` - `true` keeps `pjsip_dev_endpoints.conf`, two registrable extensions (1001 / 1002) with **static credentials that are in version control**. Anything else deletes the file at startup. Defaults to off

### SIP-TLS and SRTP

- `SIP_TLS_ENABLED` - `true` declares the TLS transport. Anything else deletes `pjsip_tls.conf` at startup, exactly as `OPTIMIQ_DEV_ENDPOINTS` does, because a `[transport-tls]` whose certificate is absent does not degrade — res_pjsip fails the transport and logs it once. Defaults to off
- `SIP_TLS_BINDADDR` - Where to listen for SIP-TLS. Defaults to `0.0.0.0:5061`, the registered SIPS port. The plaintext transport stays on `SIP_BINDADDR`, so turning TLS on adds a listener and never moves one
- `SIP_TLS_CERT_FILE` / `SIP_TLS_PRIV_KEY_FILE` - Paths **inside the container**. Default to `/etc/asterisk/certs/asterisk.pem` and `…/asterisk-key.pem`. **`run.sh` exits non-zero** when `SIP_TLS_ENABLED=true` and either is unreadable — a box that asked for TLS must never come up quietly on cleartext
- `SIP_TLS_CA_FILE` - CA bundle for the leg where Asterisk is the TLS _client_ (an outbound trunk). Empty by default, and empty means the `ca_list_file` line is removed rather than blanked
- `SIP_TLS_METHOD` - TLS floor, not ceiling. Defaults to `tlsv1_2`, which pjproject reads as "1.2 or better"
- `SIP_TLS_VERIFY_SERVER` - Verify a carrier's certificate on an outbound TLS trunk. Defaults to `no`. There is no `verify_client` knob: mutual TLS would need a client certificate on every handset, which this platform has no lifecycle for — a phone is authenticated by SIP digest over the encrypted channel
- `SIP_TLS_MEDIA_ENCRYPTION` - What the `[optimiq-endpoint-tls]` template offers. Defaults to `sdes`
- `SIP_MEDIA_ENCRYPTION_OPTIMISTIC` - `yes` (default) offers SRTP and accepts a plain answer; `no` makes it mandatory and a handset that cannot do it fails media setup visibly
- `SIP_ENDPOINT_TRANSPORT` - Which transport the static dev extensions bind to. Defaults to `transport-tcp`; `transport-tls` requires `SIP_TLS_ENABLED=true` and `run.sh` refuses the contradiction
- `SIP_MEDIA_ENCRYPTION` - What the dev extensions offer. **Derived**, not defaulted: `sdes` when their transport is TLS, `no` otherwise. An `a=crypto` line in an SDP that crossed the network in the clear publishes the media key

Development certificates come from `./config/certs/generate-dev-certs.sh`, which signs an `asterisk` leaf (SANs `asterisk`, `localhost`, `asterisk.optimiq.local`, `127.0.0.1`, plus `DOCKER_HOST_ADDRESS`) under the same private CA as the broker's. `compose.tls.yaml` mounts them and turns the flag on:

```sh
DOCKER_HOST_ADDRESS=$(ipconfig getifaddr en0) ./config/certs/generate-dev-certs.sh
docker compose -f compose.yaml -f compose.dev.yaml -f compose.tls.yaml up asterisk -d

openssl s_client -connect localhost:5061 -servername asterisk -CAfile config/certs/ca.pem
```

Production is an operator mount of real material at the same two paths. Nothing in this repository generates a production key.

### Network ACLs

`acl.conf` is generated from the `sip_acl_entry` table:

```sh
PBX_DATABASE_URL=… PBX_MEDIA_OBJECT_ROOT=… pnpm --filter @optimiq-voice/api generate:sip-acl
```

It writes `<PBX_MEDIA_OBJECT_ROOT>/acl/acl.conf` — the same object store the hold-music classes arrive through, so tenant ACLs need no second mount — and `run.sh` copies it over the baked fallback at start. To apply a change without a restart:

```sh
docker compose exec asterisk asterisk -rx 'module reload res_pjsip.so'
```

`res_pjsip`, not `acl reload`: an endpoint caches the ACL object it resolved at load, so refreshing the names alone leaves it filtering by the old rules.

The named ACLs attach to **endpoints**, not to transports — the PJSIP `transport` object has no ACL option, and a transport-level `acl =` makes res_pjsip refuse to create the transport. `optimiq-registration` is referenced from every registering endpoint's `acl` **and** `contact_acl` (the second is the toll-fraud one: a device that authenticates legitimately and then registers a Contact pointing at a third-party host has made this platform a relay); `optimiq-trunk` from the carrier wizard's `endpoint/acl`.

The baked `acl.conf` declares both names as permit-all, so a deployment that has never run the generator is filtered by nothing — which is what it was before the ACLs existed, and the only safe direction for a fallback.

### The security log

`logger.conf` writes Asterisk's Security Events feed (`InvalidAccountID`, `InvalidPassword`, `FailedACL`, …) to `/var/log/asterisk/security`, which is where fail2ban's stock Asterisk jail already looks. Nothing in Asterisk blocks an address by itself — that is a fail2ban/CrowdSec jail, and it is a deployment decision. The API-side ledger (`sip_auth_event`, `GET /api/v1/sip-auth-events`) records the failures `apps/api` observes directly today; shipping this file's lines into the same table is the follow-up, because `apps/api` has no AMI client and port 5038 is not exposed.

## Dialplan contexts

| Context            | Purpose                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `optimiq-inbound`  | Carrier traffic. Stamps the org and hands the channel to the engine's Stasis app |
| `optimiq-internal` | Registered extensions dialling. Same handover, `internal` routing context        |
| `optimiq-loopback` | A target that answers. For echo tests and the engine's gated integration suite   |
| `local-ctx`        | The inherited upstream media controller. Untouched                               |

The handover is written out per pattern rather than factored into a `GoSub`: `Stasis()` hands the
channel over with the dialplan position it is standing on, and inside a subroutine that position is
the subroutine's — so the engine would receive `exten = start` for every call and resolve every DID
as unallocated.

## Carrier trunks (Telnyx)

`config/pjsip_telnyx_example.conf` is the pjsip shape a trunk provisioned by
`POST /api/v1/trunks/:id/provision-telnyx` needs: a `registration`, an `auth`,
an `aor`, an `identify` and an `endpoint` in `optimiq-inbound`.

It is an **example and is not included** by `pjsip.conf`. Nothing in it takes
effect unless somebody copies it deliberately, which is the same containment
`pjsip_dev_endpoints.conf` gets and for the same reason: a trunk template that
auto-loaded is a template somebody eventually fills in with a real password and
commits.

Two things the file explains at length and that are worth repeating here:

- **Registration is for INBOUND only.** Outbound placement over a Telnyx
  credential connection needs no REGISTER — the INVITE is challenged with a SIP
  `407` and the same digest credential answers it. A trunk whose registration
  has lapsed keeps placing calls while silently receiving none, which is why the
  expiry is 180 s rather than an hour.
- **`context = optimiq-inbound`, never `optimiq-internal`.** Carrier traffic is
  unauthenticated traffic arriving over an authenticated transport. A carrier
  that could reach the internal context could re-enter the outbound routes —
  the classic open relay, where a call into one of your DIDs leaves again as
  billable international minutes.

The SIP username and password come from the provisioning response. The password
is never stored in `pbx-db`; it stays re-derivable from Telnyx through the
connection id in `trunk.carrier_ref`.

## Exposed ports

- `6060` - Default SIP port (TCP)
- `5061` - SIP-TLS, only when `SIP_TLS_ENABLED=true`
- `8088` - ARI / HTTP port (see `http.conf`)

## Asterisk version

The image is built on `alpine:3.24`, which ships Asterisk `22.9.0` in `main`.
Asterisk 22 is the current LTS branch (security fixes through 2028). Alpine
branches older than 3.24 still carry Asterisk 20, so do not downgrade the base
image. Since Alpine 3.22 the Asterisk data directory lives under
`/usr/share/asterisk` rather than `/var/lib/asterisk`; `config/asterisk.conf`
pins `astdatadir` accordingly.

## Volumes

No volumes are exposed, and that is a limitation worth stating rather than a design choice.

### Tenant audio needs one, and ARI gives no alternative

Per-box voicemail greetings and voicemail message playback are tenant audio: the rows in
`voicemail_greeting` and `voicemail_message` hold an **object-storage key**, not a path, and the
routing compiler embeds it into the plan as `object://<objectKey>`.

Asterisk cannot fetch it. ARI's `POST /channels/{id}/play` accepts exactly `sound:`, `recording:`,
`number:`, `digits:`, `characters:` and `tone:` — **there is no HTTP media scheme**, and no URL the
engine can hand Asterisk that makes it retrieve an object. The only way that audio plays is for the
object store to be visible to this container as a filesystem, at which point `sound:<absolute path>`
resolves (ARI takes an absolute path without an extension and picks the best available format
itself).

So a deployment that wants per-box greetings mounts the directory the API serves recordings from
(`CDR_RECORDING_ROOT`) read-only, and points the engine at the same path:

```yaml
asterisk:
  volumes:
    - ${CDR_RECORDING_ROOT}:/var/lib/optimiq/objects:ro
engine:
  environment:
    ENGINE_MEDIA_OBJECT_ROOT: /var/lib/optimiq/objects
```

`compose.yaml` deliberately does **not** do this: there is no object-store service in the stack to
mount, so the mount would name a path that does not exist. With `ENGINE_MEDIA_OBJECT_ROOT` unset —
the default — the engine resolves those refs to nothing, falls back to
`ENGINE_VOICEMAIL_GREETING` / `ENGINE_UNAVAILABLE_ANNOUNCEMENT`, and records the reason in the
walk's notes. See `apps/engine/README.md` §"Known gaps".

The alternative — having the engine download the object and stage it before playing — was rejected
for the obvious reason: it puts a network fetch on the call path, in front of a caller who is
already connected and listening.

#### The media library uses the same mount, and MOH needs one more step

`apps/api` now serves an upload path for the tenant's own audio — hold-music files, IVR prompts and
voicemail greetings — and it writes into the **same object root**, which is why
`PBX_MEDIA_OBJECT_ROOT` defaults to `PBX_VOICEMAIL_MEDIA_ROOT` and that in turn to
`CDR_RECORDING_ROOT`. The layout under it is:

```text
prompts/<organizationId>/<uuid>.wav
moh/<organizationId>/<mohClassId>/<uuid>.wav
greetings/<organizationId>/<voicemailBoxId>/<uuid>.wav
```

Every segment is a UUID the API minted — never a user-supplied name, never a class's NAME (renaming
a class must not have to move files). The API refuses anything the media server cannot decode:
RIFF/WAVE 16-bit PCM and MP3 only, checked by **magic bytes** rather than by the declared content
type, because a renamed executable declares `audio/wav`. 8 kHz mono PCM is the documented baseline —
anything else is stored with a warning that says it will be resampled on every play.

**Prompts and greetings work with the mount alone.** The compiler embeds them as
`object://<objectKey>`, `media-refs.ts` renders that as `sound:<ENGINE_MEDIA_OBJECT_ROOT>/<key>`
with the extension stripped, and Asterisk picks the best format sitting beside that stem.

**Music on hold needs one more step**, because the engine hands ARI a hold-music CLASS NAME and
Asterisk resolves a class through `musiconhold.conf`, not through a path. Uploading files under
`moh/<org>/<classId>/` puts the audio where the container can see it and does **not**, on its own,
make the class exist. `musiconhold.conf` is now generated from the `moh_class` table; the rest of
this section is how.

### Music on hold

`config/musiconhold.conf` ships in the image and declares exactly one class, `default`, pointing at
`/usr/share/asterisk/moh`. That is the fallback, and it exists because `res_musiconhold` with zero
classes is the worst failure available: it logs nothing an operator can act on and every hold plays
silence.

Tenant classes are generated:

```sh
PBX_DATABASE_URL=postgresql://…/optimiq_pbx \
PBX_MEDIA_OBJECT_ROOT=/opt/optimiq-voice/recordings \
PBX_MEDIA_CONTAINER_ROOT=/var/lib/optimiq/objects \
  pnpm --filter @optimiq-voice/api generate:musiconhold
```

which reads every `moh_class` row on the platform and writes
`<PBX_MEDIA_OBJECT_ROOT>/moh/musiconhold.conf`. `run.sh` copies that file over the baked one at
start, from `$OPTIMIQ_MEDIA_OBJECT_ROOT` (default `/var/lib/optimiq/objects`, the container side of
the mount above). Absence is not an error: a box with no mount keeps `[default]` and says so on
stdout.

**The two roots are the thing to get right.** The API writes under `PBX_MEDIA_OBJECT_ROOT`; the
`directory=` lines inside the file must be the path **Asterisk** sees, which is
`PBX_MEDIA_CONTAINER_ROOT` and must equal the container side of the mount and
`ENGINE_MEDIA_OBJECT_ROOT`. Getting it wrong produces a file that parses perfectly and plays
nothing. The generator takes only the container root, so there is only one to pass.

It is deliberately written into the object store rather than into a config volume of its own: that
directory is by construction the one a deployment has already mounted for prompts and greetings, and
a second mount is a second thing to forget.

**Applying a change.** A container restart is always sufficient. Without one:

```sh
docker compose exec asterisk asterisk -rx 'module reload res_musiconhold.so'
```

The API does not do this itself, and the reason is not laziness: `apps/api` has no ARI client
(`packages/media-ari` is the engine's, and its `AriAsterisk` wraps only `GET /asterisk/info`), there
is no AMI client anywhere in the repository, and `compose.yaml` gives this service `expose: 6060`
and nothing else — 8088 is published only by `compose.dev.yaml`, for a developer's browser. Wiring a
second set of ARI credentials into the control plane to touch one file was the larger change; the
regenerate-and-reload step is stated instead of hidden. `apps/api/scripts/generate-musiconhold.ts`
records the same decision at the call site.

**One class per name, platform-wide.** `moh_class.name` is unique per _organization_; Asterisk's
class namespace is _global_ — one file, one set of sections, no tenant dimension. Two tenants that
both name a class `hold` collide, and the generator declares **neither**, reports both in the file's
banner and on stderr, and exits non-zero. Picking a winner would play one tenant's hold music to
another tenant's callers. The undeclared classes fall back to `default`, which is exactly what
happens today, so nothing regresses while the ambiguity stands. Closing it properly means qualifying
the class name at compile time in `packages/routing` (the engine asks for the bare name because the
compiler put the bare name in the plan) — recorded as a follow-up, not done here.

A class is also left undeclared when it is disabled (matching the compiler's warning that a disabled
class falls back to the media server's own), when it is a `library` class with no files yet (a
`mode=files` section over an empty directory logs once at load and then serves silence for the life
of the process), or when it is a `stream` class with no URI. The first two are normal states and do
not fail the generator; the last does.

### `sounds/`

Baked into the image (`COPY sounds/ /usr/share/asterisk/sounds/en`), not mounted, so
`sound:unavailable` resolves on a stock container with no host state.

## Contributing

Please read [CONTRIBUTING.md](https://github.com/optimiqs/optimiq-voice/blob/main/CONTRIBUTING.md) for details on our code of conduct, and the process for submitting pull requests to us.

See also the list of contributors who [participated](https://github.com/optimiqs/optimiq-voice/contributors) in this project.

## License

This project is licensed under the Internal License - see the [LICENSE](LICENSE) file for details.
