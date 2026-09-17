# mediad

mediad is the Go media plane: it holds the RTP/RTCP sockets for a call's legs and answers the
`rpc.media.v1.*` commands the engine sends over NATS. It owns no signalling and no call state
beyond the sessions it has ports bound for.

## Configuration

Every setting is an environment variable, read once at boot; an invalid value refuses to start
rather than degrading silently.

| Variable                                            | Default                 | What it does                                                                                                                     |
| --------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `NATS_URL`                                          | `nats://127.0.0.1:4222` | The backbone. Unprefixed because it is a property of the deployment, not of this process.                                        |
| `NATS_MEDIAD_USER` / `NATS_MEDIAD_PASS`             | empty                   | This process's least-privilege identity, falling back to `NATS_USER` / `NATS_PASS`. Both empty is legal; half a pair is refused. |
| `NATS_TLS_ENABLED`                                  | `false`                 | TLS against the system trust store.                                                                                              |
| `NATS_TLS_CA`                                       | empty                   | PEM bundle the broker's certificate must chain to. Implies TLS.                                                                  |
| `MEDIAD_PUBLIC_IP`                                  | —                       | **Required.** The address advertised to the far end. A wrong value fails as silence, so there is no default.                     |
| `MEDIAD_BIND_IP`                                    | `0.0.0.0`               | The address the RTP/RTCP sockets bind. Distinct from the public one behind NAT.                                                  |
| `MEDIAD_RTP_PORT_MIN` / `MEDIAD_RTP_PORT_MAX`       | `30000` / `30999`       | The session port range. Min must be even; capacity is `(max-min+1)/2` sessions.                                                  |
| `MEDIAD_RTP_SOCKET_BUFFER_BYTES`                    | `524288`                | `SO_RCVBUF`/`SO_SNDBUF` on every pair. Zero leaves the kernel default.                                                           |
| `MEDIAD_RTP_TIMEOUT`                                | `30s`                   | Declares a session dead once it has received audio and then stops. Zero falls back to the idle timeout.                          |
| `MEDIAD_SESSION_IDLE_TIMEOUT`                       | `60s`                   | Port-leak backstop for sessions that never received RTP. Zero disables reaping.                                                  |
| `MEDIAD_INSTANCE_ID`                                | hostname + pid          | Names this process on the wire and in the session directory.                                                                     |
| `MEDIAD_SOUNDS_DIR`                                 | empty                   | Where `sound:` references resolve. Empty refuses every playback with `not_supported`.                                            |
| `MEDIAD_RECORDINGS_DIR`                             | empty                   | Where recordings are written, as `<orgId>/<callId>/<recordingRef>.wav`. Empty refuses every recording.                           |
| `MEDIAD_SRTP_POLICY`                                | `prefer`                | SDES-SRTP on the SIP legs. See below.                                                                                            |
| `MEDIAD_WEBRTC`                                     | `false`                 | Enables the WebRTC transport.                                                                                                    |
| `MEDIAD_WEBRTC_PORT_MIN` / `MEDIAD_WEBRTC_PORT_MAX` | `31000` / `31999`       | The ICE/DTLS UDP range, used only when WebRTC is on.                                                                             |
| `MEDIAD_HEALTH_ADDR`                                | empty                   | Private HTTP listener for `/healthz` and `/readyz`.                                                                              |
| `MEDIAD_PPROF`                                      | `false`                 | Serves `net/http/pprof` on the health listener only.                                                                             |
| `MEDIAD_ECHO_DIAGNOSTIC`                            | `false`                 | Every session echoes instead of relaying. Serves no working calls by design.                                                     |
| `MEDIAD_LOG_LEVEL`                                  | `info`                  | `debug`, `info`, `warn` or `error`.                                                                                              |
| `MEDIAD_SHUTDOWN_TIMEOUT`                           | `10s`                   | Bounds graceful shutdown.                                                                                                        |

## SRTP

`MEDIAD_SRTP_POLICY` decides SDES-SRTP (RFC 4568) on the SIP/RTP legs, and defaults to `prefer`.
WebRTC is unaffected: that transport is DTLS-SRTP and mandatory either way.

| Value     | On an inbound offer                                                                                           | On an offer mediad originates                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `prefer`  | Accepts SDES when the offer carries a usable crypto line under `RTP/SAVP`; answers plain `RTP/AVP` otherwise. | Offers plain `RTP/AVP`, because an offer names one transport and offering SAVP would foreclose the fallback. |
| `require` | Refuses an offer with no usable SDES, as `not_supported`. Plain `RTP/AVP` is not an accepted transport.       | Offers `RTP/SAVP` with fresh key material, and refuses an answer that carries none.                          |
| `disable` | Never accepts SDES; `RTP/SAVP` is not an accepted transport.                                                  | Offers plain `RTP/AVP`.                                                                                      |

### Per-leg override

`allocate-session`, `create-offer` and `accept-answer` may carry an optional `srtpPolicy` field
taking the same three values, which applies to that leg only. It is how a deployment defaulting to
`prefer` pins one trunk to `require`, or exempts a device that speaks no SRTP from a `require`
default. An absent or empty field is the server-wide policy, so a caller that does not send it sees
the behaviour it always did. A value outside the vocabulary is refused as `bad_request` rather than
ignored, because silently dropping a misspelt `require` would downgrade a leg.

The success replies to those three commands carry `mediaEncryption`, either `encrypted` or
`plaintext`, for a caller that wants to show a lock. It reports what is actually protecting the
packets — the SRTP context installed on the session — and not the configured policy, so a B-leg
between `create-offer` and `accept-answer` reads `plaintext` until the callee's key arrives.
