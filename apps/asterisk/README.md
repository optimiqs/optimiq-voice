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

## Dialplan contexts

| Context            | Purpose                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `optimiq-inbound`  | Carrier traffic. Stamps the org and hands the channel to the engine's Stasis app |
| `optimiq-internal` | Registered extensions dialling. Same handover, `internal` routing context      |
| `optimiq-loopback` | A target that answers. For echo tests and the engine's gated integration suite |
| `local-ctx`        | The legacy Fonoster media controller. Untouched                               |

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

- `6060` - Default SIP port
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

**Music on hold does not**, and this is a real gap worth stating rather than discovering. The engine
hands ARI a hold-music CLASS NAME, and Asterisk resolves a class through `musiconhold.conf`, not
through a path — so uploading files under `moh/<org>/<classId>/` puts the audio where the container
can see it and does **not**, on its own, make the class exist. A deployment that wants tenant-managed
hold music needs a `musiconhold.conf` section per class pointing `directory` at that path, generated
from the `moh_class` table. Nothing does that yet; today the classes are configuration the compiler
resolves and the media server has to have been told about separately. Recorded here because this
file is where an operator asks the question.

### `sounds/`

Baked into the image (`COPY sounds/ /usr/share/asterisk/sounds/en`), not mounted, so
`sound:unavailable` resolves on a stock container with no host state.

## Contributing

Please read [CONTRIBUTING.md](https://github.com/optimiqs/optimiq-voice/blob/main/CONTRIBUTING.md) for details on our code of conduct, and the process for submitting pull requests to us.

See also the list of contributors who [participated](https://github.com/optimiqs/optimiq-voice/contributors) in this project.

## License

This project is licensed under the Internal License - see the [LICENSE](LICENSE) file for details.
