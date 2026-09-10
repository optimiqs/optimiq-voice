# sipd audit (apps/sipd)

Scope read: `cmd/sipd/{main,watch}.go`, every `internal/*` production file, `go.mod`, `Dockerfile`,
plus the unit/integration tests for intent. `go vet ./...` is clean.

Counts: **P0 3, P1 9, P2 8**.

---

## P0

### [P0] The external (carrier) profile is unreachable in its own default configuration (confidence: high)

- Where: `cmd/sipd/main.go:845-854`, `internal/profile/profile.go:341-390`, `internal/config/config.go:132-135`
- Code:
  ```go
  external := profile.External("external", carrierACL)   // no listeners
  if cfg.ExternalListenAddr != "" { external.Listeners = []profile.Listener{...} }
  ```
  and in `Set.For`:
  ```go
  for index, candidate := range s.profiles {
      for _, listener := range candidate.Listeners {
          if strings.EqualFold(listener.Network, transport) { matches = append(matches, index); break }
      }
  }
  if len(matches) == 1 { return s.profiles[matches[0]], nil }
  ```
- Problem: `SIPD_EXTERNAL_LISTEN_ADDR` is empty by default and `config.go` documents that empty means
  "the external profile shares the main listeners and is selected by source address". But `External(...)`
  is then built with **zero listeners**, so it never enters `matches`, so step 2 of `Set.For` sees exactly
  one transport-serving profile (internal) and returns it. The source-ACL fallback in step 3 iterates
  `matches` and therefore never inspects the external profile at all.
- Failure scenario / cost: with the documented default deployment (one socket, carriers admitted by
  `sip-acl`/`SIPD_TRUNK_ACL`), every carrier INVITE resolves to the _internal_ profile and is answered
  `401 Unauthorized` with a digest challenge no carrier can answer. Inbound PSTN is dead; the ACL,
  the trunk attribution and `ContextUntrusted` are all never reached. The profile unit test
  (`profile_test.go:238`) only covers the case where the external profile _has_ a listener, so nothing
  catches it.
- Fix: either give the external profile the internal profile's listeners when `ExternalListenAddr` is
  empty, or make `Set.For` step 3 evaluate every `KindExternal` profile (not only ones in `matches`)
  when the transport-based step did not resolve. Minimal: in `buildProfiles`, when
  `cfg.ExternalListenAddr == ""`, set `external.Listeners = listeners` — but that then trips
  `NewSet`'s "one socket cannot have two policies" check, so the `For`-side fix is the correct one:
  ```go
  // step 3
  for index, candidate := range s.profiles {
      if candidate.Kind != KindExternal { continue }
      if len(candidate.Listeners) > 0 && !contains(matches, index) { continue }
      if _, allowed := candidate.ACL.Match(source); allowed { return candidate, nil }
  }
  ```
  Add a test for a listener-less external profile sharing the internal socket.
- Cross-area: none (self-contained in sipd), but it silently disables the inbound-PSTN path the
  engine/mediad work depends on.

### [P0] Data race: the reaper heartbeat reads live `*Dialog` fields off the owning goroutine (confidence: high)

- Where: `internal/dialog/store.go:331-345` (`Store.Claims`), consumed by `internal/reaper/reaper.go:193-212`
- Code:
  ```go
  s.mu.RLock()
  for _, dialog := range s.byLeg { dialogs = append(dialogs, dialog) }
  s.mu.RUnlock()
  for _, dialog := range dialogs { claims = append(claims, s.ClaimFor(dialog)) }  // lock released
  ```
- Problem: the package comment is explicit — "A *Dialog it hands out is NOT [safe for concurrent use]
  — one goroutine owns one dialog". `ClaimFor` reads `dialog.state`, `dialog.OrgID`, `dialog.CallID`,
  `dialog.Identity`, `dialog.Target`, `dialog.createdAt` **after** the store lock is released, from the
  reaper's goroutine, while the dialog's own session goroutine is mutating exactly those fields
  (`d.OrgID = admission.OrgID` / `d.CallID = ...` in `invite/handler.go:673-674`, state transitions in
  every `Apply`, `Store.Rebind` on the first tagged response).
- Failure scenario / cost: unsynchronised concurrent read/write of `string` headers and an `int` state
  on every 30 s sweep for every live dialog. Under `-race` this is a hard failure; in production it can
  publish a torn `state`/`orgId` into the `sip-dialogs` claim, and a torn claim is what the reaper's
  CDR-of-last-resort is built from.
- Fix: keep the claim, not the dialog, in the store. `writeClaim` already runs on the session
  goroutine — have it (or `Store.Insert`/an explicit `Store.Touch`) store a `Claim` **value** in a
  `map[string]Claim` under `s.mu`, and make `Claims()` return copies of those values. `ClaimFor` then
  only ever runs on the owning goroutine.
- Cross-area: none.

### [P0] Digest replay can bind an attacker's Contact to a victim's AOR (confidence: medium)

- Where: `internal/registrar/auth.go:34-41` (the "What this does NOT do" note), `auth.go:216-247`,
  `internal/registrar/contacts.go:93-98`
- Code:
  ```go
  // Nonce-count replay protection. […] a replayed REGISTER re-binds the same contact for the same device.
  ```
- Problem: that justification is wrong. The digest covers `method`, the Request-URI (via
  `VerifyRequest`) and the nonce — it does **not** cover the `Contact` header. Within the nonce TTL
  (default 60 s) an attacker who observes one REGISTER on an unencrypted transport can replay the
  identical `Authorization` header in a REGISTER of their own carrying **their** Contact. The stale-CSeq
  guard in `contacts.go:95` only fires when `existing.Key() == change.Key() && existing.CallID ==
change.CallID`, i.e. for the _same_ contact URI — a different Contact simply binds alongside, up to
  `MaxContactsPerAOR` (5).
- Failure scenario / cost: inbound calls for the victim's extension fork to the attacker's endpoint —
  call interception, on any deployment not running SIP over TLS (UDP/TCP are the defaults).
- Fix: two options, both cheap. (a) Bind the Contact into the digest boundary: reject a REGISTER whose
  `Authorization.nonce` has already been seen with a different Contact set — requires state, which the
  stateless-nonce design deliberately avoids. (b) The state-free one: mint the nonce over the _client
  transaction_ — include a MAC over `Call-ID` in the nonce body and require the answering REGISTER to
  carry the same Call-ID. That keeps the nonce stateless and fleet-shareable while making a replay from
  a different dialog fail. At minimum, correct the comment and document that TLS is required.
- Cross-area: none in code; a deployment note (TLS on 5061/8089) belongs with the ops docs.

---

## P1

### [P1] `Registrar.Sweep` issues one KV round trip per tracked binding every sweep interval (confidence: high)

- Where: `internal/registrar/registrar.go:410-444`
- Code:
  ```go
  for _, hint := range tracked {
      before, after, err := r.bindings.Update(ctx, hint.OrgID, hint.AORHash, func(previous *kv.Binding) …)
  ```
- Problem: `Sweep` runs every `SIPD_SWEEP_INTERVAL` (default **5 s**) and unconditionally performs a
  `kv.Update` — which is at minimum a `bucket.Get` — for **every** binding this instance tracks, whether
  or not anything is near expiry. `hint` already carries the exact `ExpiresAt`, so the filter is free.
- Failure scenario / cost: 5 000 registered phones ⇒ 5 000 KV Gets every 5 s = 1 000 ops/s of pure
  no-op traffic against the broker, per instance, forever. It scales linearly with the fleet and is the
  single largest steady-state load sipd puts on NATS.
- Fix: skip the round trip when the locally-known deadline has not passed:
  ```go
  for _, hint := range tracked {
      if !hint.Expired(r.now()) && !anyContactExpired(hint, r.now()) { continue }
      …
  ```
  (The contract that "only contacts still expired at the atomic write are removed" is unchanged —
  the CAS callback still re-checks.)
- Cross-area: none.

### [P1] The reaper lists the entire `sip-dialogs` bucket on every instance, every 30 s (confidence: high)

- Where: `internal/reaper/reaper.go:224-229`
- Code: `claims, err := r.store.All(ctx)` then `dialog.Orphans(claims, r.instance, r.now())`
- Problem: `All` reads _every_ claim in the bucket (a `Keys` + a `Get` per key in the NATS
  implementation), on every instance, every 30 s — and then discards all but the expired foreign ones.
  The work is O(instances × fleet-wide dialogs) per interval.
- Failure scenario / cost: 10 instances × 5 000 concurrent calls ⇒ 50 000 KV Gets per 30 s ≈ 1 700/s,
  plus the full JSON decode and a fleet-sized slice allocated per sweep per instance. This grows
  quadratically with cluster size.
- Fix: replace the poll with a `WatchAll` on the bucket that maintains a local index of foreign claims
  keyed by `expiresAt`, and reap from that index; or, if a poll must stay, elect a single reaper
  (a NATS queue-group leader) so only one instance pays the listing cost.
- Cross-area: none.

### [P1] `Handler.Shutdown` sends every deactivation NOTIFY serially and blocks on each (confidence: high)

- Where: `internal/subscribe/handler.go:887-905`, called from `cmd/sipd/main.go:531-535`
- Code:
  ```go
  for _, subscription := range drained {
      req := BuildNotify(...)
      if err := h.notifier.Notify(ctx, req); err != nil { … }   // blocks until the tx settles
  }
  ```
- Problem: `ClientNotifier.Notify` blocks until the client transaction settles. One unplugged handset
  holds the loop for the full non-INVITE transaction timeout, and the whole loop shares a single
  `cfg.ShutdownTimeout` (default 10 s) context. The comment for `dispatch` states this exact hazard for
  the fan-out path and then the shutdown path does the sequential thing anyway.
- Failure scenario / cost: an instance holding 300 BLF subscriptions with a handful of dead phones
  deactivates only the first few before the 10 s context expires; the rest of the fleet's lamps freeze
  for up to `SIPD_SUBSCRIBE_MAX_EXPIRES` (600 s) after every rolling deploy — precisely the outage
  the `deactivated` reason exists to prevent.
- Fix: fan out with a bounded worker pool (e.g. 32) inside `Shutdown`, still on `ctx`, and wait for the
  group before returning the count.
- Cross-area: none.

### [P1] Unbounded goroutine fan-out on presence/MWI churn (confidence: medium)

- Where: `internal/subscribe/handler.go:679-694` (`dispatch`)
- Code:
  ```go
  h.notifications.Add(1)
  go func() { … h.deliver(ctx, subscription, …) }()
  ```
- Problem: one goroutine per watcher per change, with no cap. `OnPresence` fires for every presence
  transition in the deployment; a busy queue extension with 200 BLF watchers and several state changes
  a second produces low-thousands of concurrent SIP client transactions, each holding a transaction-layer
  slot for up to `notifyTimeout`.
- Failure scenario / cost: memory and transaction-layer pressure proportional to (watchers × change
  rate × notify timeout), with no back-pressure. Under a queue storm the SIP stack starves the INVITE
  path that shares the same client.
- Fix: a fixed-size semaphore (buffered channel) in the `Handler`, acquired in `dispatch` and released
  in the goroutine; drop-newest with a counter when saturated, since RFC 4235 versioning already makes
  a skipped intermediate notification safe.
- Cross-area: none.

### [P1] The credential cache's eviction is an O(n) full-map scan under the lock on the REGISTER hot path (confidence: high)

- Where: `internal/credentials/nats.go:270-300`
- Code:
  ```go
  func (s *NATSStore) store(key string, entry cacheEntry) {
      s.mu.Lock(); defer s.mu.Unlock()
      if len(s.cache) >= s.maxEntries { s.evictLocked() }   // iterates the whole map
      s.cache[key] = entry
  }
  ```
- Problem: once the cache reaches `SIPD_CREDENTIAL_CACHE_MAX_ENTRIES` (default 10 000) — which is
  exactly what the negative cache is designed to do under a username scan — _every_ subsequent miss
  walks all 10 000 entries while holding the mutex that serialises every REGISTER and every INVITE
  digest lookup in the process.
- Failure scenario / cost: the very load the bound exists to survive (a SIP scanner) turns each guess
  into a 10 000-entry map walk under a global lock. The scanner sets the pace.
- Fix: amortise it — keep a `lastEvict time.Time` and run `evictLocked` at most once per
  `negativeTTL`; between sweeps evict a single arbitrary entry (the existing fallback) when full.
  Two lines, and the "load shedder not a correctness mechanism" rationale still holds.
- Cross-area: none.

### [P1] No single-flight on the credential RPC: a cold cache stampedes apps/api (confidence: medium)

- Where: `internal/credentials/nats.go:150-170`
- Problem: N concurrent REGISTERs for the same account on a cold or just-expired cache entry all miss
  and all issue their own `rpc.sip.v1.credential` request. The package comment claims the positive
  cache's job is to collapse "a thousand phones … a steady three requests a second"; it collapses the
  _steady_ rate but not the burst at TTL expiry or after a restart.
- Failure scenario / cost: a fleet restart or a `positiveTTL` boundary produces a burst of duplicate
  RPCs proportional to concurrent REGISTERs, each with a 500 ms deadline, against a control plane that
  is already the slowest link.
- Fix: a `map[string]*inflight` beside the cache; the first caller issues the request, the rest wait on
  its channel. ~20 lines, and it removes the burst entirely.
- Cross-area: none.

### [P1] `acl.Watcher` recompiles the entire ACL once per record during the initial replay (confidence: high)

- Where: `internal/acl/acl.go:173-186`, `195-229`, `302-320`
- Code:
  ```go
  func (w *Watcher) Put(key string, record Record) { …; w.recompile() }
  ```
  and `recompile` builds a full key slice, `sort.Strings`es it, re-parses every CIDR and calls
  `acl.Replace` (which copies + `sort.SliceStable`s again).
- Problem: `Watch` calls `applyUpdate` → `Put` for **every** key in the replay, so loading N entries is
  N recompilations of N entries: O(N² log N) prefix parses and sorts at boot.
- Failure scenario / cost: 1 000 ACL entries ⇒ ~10⁶ `netip.ParsePrefix` calls and 1 000 sorts before the
  boundary is usable, delaying the window in which carriers are refused. Also applies to every burst of
  edits.
- Fix: give `Watcher` a `Batch`/`suspend` mode. Have `Watch` accumulate into `w.records` without
  recompiling until the `nil` replay-boundary entry arrives, then recompile once; recompile per update
  after that.
- Cross-area: none.

### [P1] The `Watch` readiness signal is discarded; the documented "wait before accepting traffic" never happens (confidence: high)

- Where: `internal/acl/acl.go:249-300` vs `cmd/sipd/main.go:827-834`
- Code:
  ```go
  // The returned channel closes once the initial replay is complete, so a caller can wait for the ACL
  // to be populated before it starts accepting traffic rather than polling Len.
  …
  _, err = acl.Watch(ctx, bucket, watcher)   // main.go throws the channel away
  ```
  and the whole attach runs through `watchWhenAvailable`, i.e. possibly minutes after listeners are up.
- Problem: `buildProfiles`' own comment says the ACL is opened "BEFORE the INVITE surface … because the
  ACL is a security boundary". It is _started_ before, not _loaded_ before. The readiness channel exists
  for exactly this and is dead code.
- Failure scenario / cost: fails closed (empty ACL refuses everyone), so this is an availability rather
  than a security bug — every carrier INVITE arriving between listener bind and replay completion is
  answered 403, and with `watchWhenAvailable` retrying at 1 s that window is unbounded if the bucket is
  slow to appear. `main.go:763` also logs `aclWatcher.Len()` as though it were meaningful at that point;
  it is always 0.
- Fix: have `newInviteHandler`/`buildProfiles` return the ready channel and either (a) `select` on it
  with a short bounded wait before registering `server.OnInvite`, or (b) keep the current behaviour and
  delete the channel and the misleading comment + boot-log field.
- Cross-area: none.

### [P1] `watchWhenAvailable` retries forever at a fixed 1 s and swallows every error after the first (confidence: high)

- Where: `cmd/sipd/watch.go:12-38`
- Code:
  ```go
  case <-ticker.C:
      if err := attach(); err == nil { … return }   // err is discarded
  ```
- Problem: no backoff, no cap, and every failure after the first attempt is silent. A bucket the control
  plane never creates means one JetStream KV lookup per second, per watched bucket (`trunks` and
  `sip-acl`), for the life of the process, with nothing in the logs.
- Failure scenario / cost: steady 2 req/s of pointless broker traffic per sipd replica, and an operator
  who has no way to see _why_ the trunk directory never attached.
- Fix: exponential backoff capped at ~30 s, and log the error at `Debug` on every attempt with a
  `Warn` every Nth.
- Cross-area: none.

### [P1] `legState.replacesLegID` is written from the request goroutine after the leg is published (confidence: medium)

- Where: `internal/invite/handler.go:542-545`, read at `internal/invite/executor.go:223-232`
- Code:
  ```go
  session, state, err := h.createLeg(req, tx, owner, intent, negotiation.Timer, log)
  if err == nil { state.replacesLegID = replacedLegID }
  ```
- Problem: `legState`'s doc comment says "Every field is read and written ONLY from inside a session
  task, which is what makes it safe without a lock of its own." `createLeg` has already inserted the leg
  into `h.legs` and installed `tx.OnCancel` before this line, so a CANCEL (or an ACK/BYE that matched)
  arriving in that window runs effects on the session goroutine that read `e.state` concurrently with
  this write.
- Failure scenario / cost: a genuine (if narrow) data race that `-race` will surface under the CANCEL
  race tests; the practical consequence is an RFC 3891 replaced-dialog teardown that is missed or run
  against a stale value.
- Fix: pass `replacedLegID` into `createLeg` and set it on the `legState` literal before
  `h.legs[...] = …` and before `tx.OnCancel` is installed.
- Cross-area: none.

---

## P2

### [P2] `internal/acl`'s package doc states the opposite evaluation order to the evaluator (confidence: high)

- Where: `internal/acl/acl.go:18-23` vs `internal/profile/acl.go:139-163`
- Code: acl.go — "Lowest `priority` first, ties broken by the most specific prefix, first match wins";
  profile/acl.go `store` — sorts **prefix bits first**, then priority.
- Problem: on an anti-toll-fraud boundary these give different answers. An operator writing
  `deny 203.0.113.0/24 priority 1` plus `allow 203.0.113.7/32 priority 100` gets the /32 allow under the
  implementation and would expect the /24 deny from the package doc. The implementation is the defensible
  one; the doc is wrong and is the doc an operator reads.
- Fix: correct `internal/acl`'s package comment to "most specific prefix first, ties broken by priority
  (higher wins after the inversion), deny before allow", and say so in the `sip_acl_entry` column comment.
- Cross-area: `packages/pbx-db/src/schema/security-schema.ts` — the `priority` column comment
  ("lower first") should say what "first" means relative to prefix specificity.

### [P2] Digest downgrade: a `qop`-less response is accepted against a `qop="auth"` challenge (confidence: high)

- Where: `internal/registrar/auth.go:238-247`
- Code: `if qop == "auth" { …nc/cnonce form… }  return md5hex(ha1 + ":" + nonce + ":" + ha2)`
- Problem: the challenge always advertises `QOP: []string{"auth"}`, but `Verify` silently falls back to
  RFC 2069's legacy form for any other `qop` value (including empty and `auth-int`). RFC 2617 §3.2.2
  requires the client to use a qop the server offered.
- Fix: reject `auth.QOP != "auth"` when the challenge offered qop, unless a compatibility flag is set.

### [P2] `duplicateListener` cannot detect a TCP/WS address collision (confidence: medium)

- Where: `internal/config/config.go:502-529`
- Code: `if listener.name == "SIPD_TCP" { continue }`
- Problem: TCP is skipped unconditionally so that it can share `SIPD_LISTEN_ADDR` with UDP. But with
  `SIPD_UDP=false SIPD_TCP=true` and `SIPD_WS_LISTEN_ADDR` equal to `SIPD_LISTEN_ADDR`, the TCP address is
  never claimed and the WS/TCP collision passes validation — producing exactly the "one listener binds,
  the other fails in a goroutine nobody watches" failure the check was written for.
- Fix: claim TCP's address under a shared `"tcp-family"` key that UDP does not touch, rather than
  skipping it.

### [P2] `Set.byListener` indexes the input slice while `Set.profiles` is built conditionally (confidence: high)

- Where: `internal/profile/profile.go:274-295`
- Code: `set.byListener[key] = index` where `index` comes from `range profiles`, but `set.profiles` only
  receives profiles that passed validation.
- Problem: latent — today every `continue` path also appends to `problems`, so `NewSet` returns an error
  and the mismatched map never escapes. One future early-`continue` that is not an error turns
  `s.profiles[index]` in `For` into an out-of-range panic on the INVITE path.
- Fix: `set.byListener[key] = len(set.profiles)` (assign after the append, or compute the post-append index).

### [P2] `config.ErrInvalid` is declared and never used (confidence: high)

- Where: `internal/config/config.go:532`
- Problem: `Load` returns a plain `fmt.Errorf`, so the sentinel a caller would branch on is not in the
  chain. Dead API that documents a capability that does not exist.
- Fix: wrap it (`fmt.Errorf("%w: sipd configuration is invalid:\n  - %s", ErrInvalid, …)`) or delete it.

### [P2] `conn == nil` branch in main is unreachable (confidence: high)

- Where: `cmd/sipd/main.go:254-257`, and the same shape at `main.go:821`
- Code:
  ```go
  var statusPublisher trunk.Publisher = trunk.NewJetStreamPublisher(js, config.EventSource)
  if conn == nil { statusPublisher = trunk.LogPublisher{Log: log} }
  ```
- Problem: `nats.Connect` above returns a non-nil `conn` or the process exits, and the comment on the
  same line ("which by this point there always is — the process refuses to start without one") says so.
  The `LogPublisher` fallback and the `if conn != nil` guard in `buildProfiles` are both dead.
- Fix: delete both branches, or move the no-broker mode behind an explicit config flag if it is wanted.

### [P2] Trunk gateways all start registering at t=0 with no jitter (confidence: medium)

- Where: `internal/trunk/supervisor.go:199` (`runner.post(Input{Trigger: TriggerStart})`), `gateway.go:200-209`
- Problem: `Backoff` carefully jitters _retries_ with the stated rationale that "a carrier that is down
  is down for every one of our instances at once". The initial `TriggerStart` after a fleet restart or a
  directory replay is not jittered at all, so N trunks × M instances all REGISTER in the same
  millisecond — the same storm, aimed at a carrier that is _up_.
- Fix: schedule the first register through `ActionScheduleRetry`-style jitter (a `rand` fraction of
  `Backoff.Initial`) rather than posting `TriggerStart` synchronously.

### [P2] `gatewayRunner.post` silently drops inputs when the mailbox is full (confidence: medium)

- Where: `internal/trunk/supervisor.go:300-311`
- Code: `select { case r.inputs <- in: default: }`
- Problem: the doc justifies dropping for a _stopped_ runner (which the `stopped` check above already
  handles). The `default:` also drops on a full 4-slot mailbox for a **running** runner — e.g. a
  `TriggerAccepted` lost behind three timer ticks would leave the gateway in `Registering` until its
  retry timer fires, reporting `degraded` for a trunk that is up.
- Fix: block with a short bounded send (`select { case r.inputs <- in: case <-time.After(time.Second): log }`)
  for a running runner, and keep the drop only for the stopped case; or log the drop with the trigger name.
