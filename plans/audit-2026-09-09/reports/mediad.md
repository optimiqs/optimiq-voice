# mediad audit (apps/mediad)

Scope: every `.go` file under `apps/mediad` (cmd, internal/{audio,config,control,directory,events,rtp,sdp,webrtc}),
go.mod, Dockerfile. Tests read for intent, not reported on unless wrong. `go vet ./...` is clean.

Counts: 4 P0, 9 P1, 8 P2.

---

## P0

### [P0] Recording path is built from unvalidated `orgId`/`callId` — write outside the recordings root (confidence: high)

- Where: `internal/control/handlers.go:1150-1154`, `internal/control/handlers.go:1294-1296`
- Code:
  ```go
  objectKey := recordingObjectKey(orgID, callID, request.RecordingRef)
  Path: filepath.Join(s.recordingsDir, filepath.FromSlash(objectKey)),
  // recordingObjectKey: return orgID + "/" + callID + "/" + ref + ".wav"
  ```
- Problem: `request.RecordingRef` is checked with `isSafeRefToken` (handlers.go:1091, 1304) precisely because it
  becomes a filename — but `orgID` and `callID` come from `s.sessions.SessionTenancy`, i.e. straight from the
  allocate request's JSON, and are only checked for emptiness (handlers.go:51-56). `filepath.Join` calls `Clean`,
  so `orgId = "../../.."` escapes `MEDIAD_RECORDINGS_DIR` entirely. `internal/audio/library.go:264-318` guards the
  read side of exactly this and the handler doc-comment above it claims "A caller-supplied directory would let a
  malformed request write anywhere this process can" — the claim is not true for the two tokens that build the
  directory.
- Failure scenario / cost: a compromised or buggy publisher on `rpc.media.v1.allocate-session` (mediad's NATS user
  can be reached by anything with the shared credential) allocates with `orgId: "../../../etc"` and then records;
  mediad creates directories (`os.MkdirAll`, `wavwriter.go:77`) and writes a WAV anywhere the process can write.
  Cross-tenant recording overwrite is the cheaper version: `orgId: "<victim-org>"`.
- Fix: validate both tokens at the allocate boundary with the same rule as `isSafeRefToken` (and in
  `recordingObjectKey` as a belt-and-braces check); reject with `bad_request`. One helper, three call sites.
- Cross-area: `packages/events` schemas could add the same `.regex()` to `orgId`/`callId`, but the media plane must
  not depend on that.

### [P0] `ReapIdle` never reaps a held or muted session — permanent port leak on the commonest states (confidence: high)

- Where: `internal/rtp/manager.go:1040`
- Code: `if session.held.Load() || session.mutedIn.Load() || session.mutedOut.Load() || now.UnixMilli() < session.rtpGraceUntil.Load() { continue }`
- Problem: the skip is unconditional and permanent, not a grace window. Any session whose SDP answer was
  `sendonly`, `recvonly` or `inactive` gets `MuteIn`/`MuteOut` set at allocate
  (`handlers.go:97-109` → `directionToMutes`, `handlers.go:913-924`) and is therefore excluded from BOTH the RTP
  timeout and the idle backstop for the rest of the process's life. A ringing leg is `inactive` → both flags set.
- Failure scenario / cost: an engine that crashes (or a call setup abandoned mid-INVITE) between `create-offer`/
  `allocate-session` and `release-session` leaks the RTP/RTCP port pair permanently. The config comment
  (`config.go:139-146`) states the idle timeout exists precisely as "a port-leak backstop… A leaked port is
  permanent capacity loss until restart". On the default 500-pair range, a few hundred abandoned ringing legs take
  the instance to `ErrPortsExhausted` with no live calls on it.
- Fix: keep the _RTP-timeout_ skip (silence is expected while held/muted) but do NOT skip the
  `!heardSomething && idle > m.idleAfter` branch — a session that has never received a packet at all should be
  reaped whatever its gates say. Alternatively bound the exemption with a much longer hard ceiling.
- Cross-area: none.

### [P0] `Manager.Hold` indexes the hold-music playback but nothing ever removes it (confidence: high)

- Where: `internal/rtp/hold.go:274-278` vs `internal/rtp/manager.go:735-758`
- Code:
  ```go
  if opts.MusicRef != "" {
      m.mu.Lock(); m.playbacks[opts.MusicRef] = sessionID; m.mu.Unlock()
  }
  ```
- Problem: `Manager.StartPlayback` starts a watcher goroutine that deletes the index entry when the playback ends
  and publishes `PlaybackFinished`. `Manager.Hold` calls `session.Hold` → `Session.StartPlayback` (the _session_
  method) directly, so it writes the index with no watcher at all. `Unhold` (`hold.go:168-189`) stops the loop but
  never touches `m.playbacks`. The entry is also written when the music FAILED to start, because `Session.Hold`
  swallows that error by design (`hold.go:150-158`).
- Failure scenario / cost: (a) `m.playbacks` grows by one entry per hold for the lifetime of the process —
  unbounded memory and a `stop-playback` for a recycled ref resolving to a long-dead session; (b) no
  `media.evt.v1.…playback.finished` is ever published for hold music, so an operator cannot see hold music start
  and stop; (c) `StopPlayback` on a stale ref returns the dead session id in the reply (`manager.go:770-783`).
- Fix: route hold music through `Manager.StartPlayback` (which already indexes + watches) instead of
  `session.Hold` starting its own; or have `Session.Hold` return the `*Playback` and have `Manager.Hold` attach the
  same watcher. Also skip the index write when the music did not start.
- Cross-area: none.

### [P0] `Drain` can run far past `MEDIAD_SHUTDOWN_TIMEOUT`; drained sessions' events can be lost (confidence: high)

- Where: `internal/rtp/manager.go:1151-1169`, `internal/control/lifecycle.go:98,163,220,281,334`, `cmd/mediad/main.go:283-291`
- Code:
  ```go
  for _, session := range live { m.closeAndAnnounce(session, EndReasonDrained) }   // manager.go:1154
  ...
  select { case <-stopped: return nil; case <-ctx.Done(): ... }
  ```
- Problem 1: the close loop is not context-aware, and `closeAndAnnounce` → `awaitRecording` blocks up to
  `recordingFinaliseTimeout` (5 s, `manager.go:548`) **per session, serially**. A box with 50 live recordings on a
  wedged NFS mount spends 250 s in a loop the `ctx.Done()` select below can never interrupt.
- Problem 2: every lifecycle publish is `go a.publish(...)` — untracked goroutines. `main.go` returns immediately
  after `Drain`, running the deferred `conn.Drain()`; a publish goroutine that has not yet called `js.Publish` is
  killed by process exit, so `session.ended` for drained calls is silently lost — which is exactly the event
  `events.go:9-20` argues must be durable.
- Fix: pass the drain context into the close loop and bail out of it on `ctx.Done()`; run the per-session close +
  await in a bounded worker pool rather than serially. Give `LifecycleAnnouncer` a `sync.WaitGroup` (or a bounded
  worker) and wait for it in `run()` before `conn.Drain()`.
- Cross-area: none.

---

## P1

### [P1] `Conference.mixOnce` holds `c.mu` across N socket writes, 50 times a second (confidence: high)

- Where: `internal/rtp/mixer.go:416-418, 490`
- Code: `c.mu.Lock(); defer c.mu.Unlock() … member.session.sendMixFrame(member.encoder.EncodeFrame(out), marker)`
- Problem: `sendMixFrame` marshals and does a `WriteToUDP` syscall (or a Pion SRTP write for a WebRTC leg, which
  takes its own locks) while the room mutex is held. Every `join`, `leave`, `Members()`, `Len()`, `Member()` and
  `forwardEvent` — several of which are called with `Manager.mu` held (`leaveConferenceLocked`,
  `conferenceOfLocked`) — serialises behind those writes.
- Failure scenario / cost: one slow/blocked socket write on any member stalls the whole room's frame, and a
  `Manager.Release` on any session in the process can block behind it while holding `m.mu`, i.e. behind the global
  session-map lock. At 8 members × 50 Hz that is 400 syscalls a second under one mutex per room.
- Fix: build the per-member `(payload, marker)` list under the lock, release it, then write outside.
- Cross-area: none.

### [P1] `mixOnce` allocates three frame buffers per tick per conference (confidence: high)

- Where: `internal/rtp/mixer.go:424, 448-449`
- Code: `total := make([]int32, audio.FrameSamples)` … `mixed := make(...)`, `out := make([]int16, ...)`
- Problem: `Member.contribution` is explicitly pooled ("reused across ticks so a conference does not allocate N
  frames fifty times a second", mixer.go:169-172) but the three room-level buffers are not, and
  `EncodeFrame`/`DecodeFrame` allocate again per member per tick (`codec.go:154-192`, `padFrame`,
  `DecodeLinear`, `encodeLinear`).
- Failure scenario / cost: ~150 heap allocations/second per conference plus 2N codec allocations — steady GC
  pressure in the one loop with a hard 20 ms deadline.
- Fix: hoist `total`, `mixed`, `out` onto the `Conference` struct and zero them per tick (as `contribution` is);
  give the frame codecs caller-supplied output buffers.
- Cross-area: none.

### [P1] Transcoding allocates 2-3 slices per RTP packet on the bridge hot path (confidence: high)

- Where: `internal/rtp/transcode.go:106-113` → `internal/audio/codec.go:154-192`
- Code: `return t.encoder.EncodeFrame(t.decoder.DecodeFrame(payload)), true`
- Problem: `DecodeLinear` allocates a `[]int16`, `padFrame` may allocate another, `encodeLinear` allocates the
  output — per packet, per direction, 50 packets/s/leg. Only on transcoded bridges, but that is the path rung 7
  exists for.
- Fix: `sync.Pool`, or per-`Transcoder` scratch buffers (the codec is already mutex-guarded, so buffers can live
  on the struct).
- Cross-area: none.

### [P1] `Allocator.Allocate` holds the global mutex across up to `Capacity()×2` `net.ListenUDP` syscalls (confidence: high)

- Where: `internal/rtp/allocator.go:121-154`
- Code: `a.mu.Lock(); defer a.mu.Unlock(); for attempt := 0; attempt < a.Capacity(); attempt++ { … a.bindPair(port) … }`
- Problem: `Manager.Allocate` deliberately binds outside `m.mu` (`manager.go:330-332`) but the allocator itself
  serialises every bind in the process. When the pool is near-full (or the range collides with Asterisk's, which
  the cutover explicitly runs side by side) each allocate walks the whole range doing two failing binds per port
  while every other call setup waits.
- Failure scenario / cost: with a 500-pair range fully taken, one allocate does ~1000 syscalls under the lock;
  concurrent call setup degrades from microseconds to tens of milliseconds each, serially.
- Fix: reserve the port under the lock (mark `inUse`), release the lock, bind, and re-take the lock to unmark on
  failure. Also short-circuit when `len(a.inUse) == Capacity()`.
- Cross-area: none.

### [P1] `routeRequest` does 1-4 KV round trips on every media RPC (confidence: high)

- Where: `internal/control/ownership.go:66-107`, `109-187`
- Code: `for _, id := range request.sessions() { found, err := store.Get(ctx, key) … s.dir.Get(ctx, id) … }`
- Problem: every command — including the ones on the call-setup path with a 500 ms budget — makes a
  `media-owners` KV `Get` per session id, plus a `media-sessions` fallback `Get` when that misses, plus up to two
  `Claim`s on allocate, plus a `Get`+`Claim` on the resource key. There is no per-instance cache even though
  ownership is immutable once claimed, and `s.ownership.tracked` already knows which keys this node owns.
- Failure scenario / cost: 2-5 broker round trips added to every `bridge-sessions`/`start-playback`, with a 2 s
  ceiling (`ownership.go:74`) that exceeds the subject deadlines the handlers are documented against.
- Fix: memoise "this instance owns key K" in `ownership.tracked` and skip the `Get` for keys already tracked
  locally; batch the per-session `Get`s.
- Cross-area: none.

### [P1] SDP answer/offer hard-code `IN IP4` — an IPv6 `MEDIAD_PUBLIC_IP` produces malformed SDP (confidence: high)

- Where: `internal/sdp/sdp.go:445-448`, `528-531`
- Code: `fmt.Fprintf(&body, "o=- %d %d IN IP4 %s\r\n", …)` / `fmt.Fprintf(&body, "c=IN IP4 %s\r\n", answer.Address)`
- Problem: `config.Load` accepts any IP for `MEDIAD_PUBLIC_IP` (`config.go:274-292`); only the WebRTC path
  requires IPv4 (`main.go:182`). An IPv6 address is then emitted under an `IN IP4` addrtype, which every
  conformant far end rejects or mis-parses.
- Failure scenario / cost: an IPv6-only deployment gets 100% call failure with a malformed-SDP error one hop
  away, not an error at boot.
- Fix: emit `IN IP6` when `Address.Is6() && !Address.Is4In6()` in both builders (one helper), or refuse an IPv6
  `MEDIAD_PUBLIC_IP` at boot with a named message.
- Cross-area: none.

### [P1] WebRTC allocate leaks the session on three failure paths (confidence: high)

- Where: `internal/control/webrtc.go:78-89`
- Code:
  ```go
  negotiated, err := sdp.ParseOffer(answer)
  if err != nil { return s.refuseAllocate(request.SessionID, ReasonInternal, err.Error()) }
  ```
- Problem: the `Answer` failure path releases the session when `created` (webrtc.go:72-77), but the three later
  failures (`ParseOffer`, `SettleAnswer`, `ApplyDirection`) return a refusal without releasing. The session, its
  port pair, its two goroutines and the Pion `PeerConnection` stay alive.
- Failure scenario / cost: a repeatedly failing WebRTC allocate leaks a port pair + an ICE agent + a
  PeerConnection each time, until the idle reaper collects it — and per the P0 above it may be muted and therefore
  never reaped.
- Fix: hoist a `defer`d `if failed && created { s.sessions.Release(...) }` covering the whole function.
- Cross-area: none.

### [P1] WebRTC inbound RTP and RTCP are dropped silently when the channel is full (confidence: medium)

- Where: `internal/webrtc/transport.go:98-104`, `128-134`
- Code:
  ```go
  select { case t.rtp <- raw: case <-t.done: return; default: }
  ```
- Problem: the `default` arm discards the packet with no counter and no log. `Session.Stats` has counters for
  every other drop reason (malformed, foreign source, suppressed-by-*) precisely so a support ticket is
  explicable; this one is invisible.
- Failure scenario / cost: a stalled `Session.Run` (blocked write to a slow peer) fills the 128-packet buffer and
  audio is dropped with no evidence anywhere. "The browser leg was choppy" is unanswerable.
- Fix: count the drops on the transport and surface them in the session stats / a rate-limited warn.
- Cross-area: none.

### [P1] Jitter buffer can silence a member for many seconds after a sequence discontinuity (confidence: medium)

- Where: `internal/rtp/jitter.go:212-244`, `173-180`
- Code: `frame, ok := j.pending[j.next]; if !ok { j.stats.Lost++; j.next++ … }`
- Problem: `next` only ever advances by one per tick. If a sender's sequence jumps forward (a re-INVITE that
  restarts the stream, an endpoint bug), the newly arriving packets are buffered until `len(pending) >= 20` and
  then discarded as `Overflowed`, while `Pop` steps `next` one per 20 ms towards them. The "everything has
  drained → re-prime" escape hatch (jitter.go:228-234) never fires because `pending` is never empty.
- Failure scenario / cost: a gap of N sequence numbers = N × 20 ms of silence for that participant, heard by
  everybody in the room. N=1000 is 20 seconds.
- Fix: when `pending` is non-empty and `next` is more than `jitterMaxFrames*2` behind the smallest buffered
  sequence, resync `next` to that sequence and count it once.
- Cross-area: none.

---

## P2

### [P2] `codecOf` is dead code (confidence: high)

- Where: `internal/control/handlers.go:1330-1335` — no callers anywhere in the module (`grep codecOf`).
- Fix: delete it. `sdp.CodecForFormat` is the live equivalent.

### [P2] `recording.finish` overwrites the terminator detail with the dropped-frames message (confidence: high)

- Where: `internal/rtp/recording.go:406-417`
- Code: `detail = "terminated on " + *digit` … then `if dropped > 0 { detail = "frames were dropped…" }`
- Problem: a voicemail ended by `#` on a busy box reports only the drops; the fact that the caller pressed a key
  is lost from the one field the contract carries it in.
- Fix: append rather than replace.

### [P2] `start-recording` does not validate `direction` (confidence: high)

- Where: `internal/control/handlers.go:1146-1149`
- Code: `direction := rtp.RecordingDirection(request.Direction)` with no membership check.
- Problem: any string other than `both` silently behaves as `receive` (`recording.go:224-229`, `377`), so a
  typo produces a half recording reported as success. Every other enum on this surface is parsed and refused
  (`rtp.ParseSide`, `rtp.ParseDirection`).
- Fix: refuse anything but `receive`/`both` with `bad_request`.

### [P2] `routingFailure` reports "owning instance unavailable" as `internal` (confidence: high)

- Where: `internal/control/ownership.go:82-87, 189-197`
- Problem: the engine branches on `reason`; `wrong_instance` is the code that exists for "the session is alive on
  a named neighbour" (`handlers.go:587-610`), and `internal` invites a same-node retry that will fail identically.
- Fix: return `ReasonWrongNode` for the forwarding failures, keep `internal` for KV errors.

### [P2] `RenewOwnership` classifies errors by substring match (confidence: high)

- Where: `internal/control/ownership.go:231` — `if err != nil && !strings.Contains(err.Error(), "context canceled")`
- Fix: `errors.Is(err, context.Canceled)`.

### [P2] `BuildAnswer` silently answers an Opus session under payload type 0 (confidence: medium)

- Where: `internal/sdp/sdp.go:434-437` — `if payloadType == 0 && answer.Codec != CodecPCMU { payloadType = answer.Codec.PayloadType() }`, and `Codec.PayloadType()` returns 0 for Opus (`sdp.go:85-86`).
- Problem: a caller that forgets `AudioPayloadType` for an Opus answer produces `m=audio … 0` with
  `a=rtpmap:0 opus/48000/2` — a self-contradictory answer. Today only the handlers call this and they always set
  the field, so it is latent rather than live.
- Fix: refuse (or return an error) when `Codec == CodecOpus && AudioPayloadType == 0`.

### [P2] `LifecycleAnnouncer` spawns an unbounded goroutine per event (confidence: medium)

- Where: `internal/control/lifecycle.go:98, 163, 220, 281, 334`
- Problem: `go a.publish(...)` with a 2 s timeout each. A leg producing digits at RFC 4733 rates, or a mass
  reap, spawns hundreds of concurrent JetStream publishes exactly when the broker is already struggling.
- Fix: a small bounded worker pool / buffered channel drained by one goroutine (which also fixes the drain-loss
  half of the P0 above).

### [P2] Dockerfile does not expose the WebRTC UDP range (confidence: high)

- Where: `Dockerfile:19` — `EXPOSE 9091/tcp 30000-30999/udp`
- Problem: `MEDIAD_WEBRTC_PORT_MIN/MAX` default to 31000-31999 (`config.go:228-231`) and are absent here, so a
  WebRTC-enabled container documents (and, under tooling that reads EXPOSE, publishes) only the SIP RTP range.
- Fix: add `31000-31999/udp`, or document that the range must be published explicitly.
- Cross-area: `compose.yaml` / deployment manifests need the same port mapping.

---

## Verified and dropped

- `readReportBlocks` 24-bit cumulative-loss sign extension (`rtcp.go:258`) — the `<<8 >>8` idiom is correct.
- `Session.latch` one-shot latching, `Allocator` round-robin cursor, `WAVWriter` partial+rename+fsync ordering,
  `dtmfDetector` de-duplication, and `Library.Resolve` traversal guards are all correct as written.
- `RunRTCP`'s inner ticker goroutine is not tracked by `Manager.running` but does exit on `s.done`, so it is not
  a leak.
- `transcoderPair.install` storing typed-nil into `atomic.Pointer[Transcoder]` is safe (`Store` of a nil
  `*Transcoder` reads back as nil).
