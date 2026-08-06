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

No volumes are exposed.

## Contributing

Please read [CONTRIBUTING.md](https://github.com/optimiqs/optimiq-voice/blob/main/CONTRIBUTING.md) for details on our code of conduct, and the process for submitting pull requests to us.

See also the list of contributors who [participated](https://github.com/optimiqs/optimiq-voice/contributors) in this project.

## License

This project is licensed under the Internal License - see the [LICENSE](LICENSE) file for details.
