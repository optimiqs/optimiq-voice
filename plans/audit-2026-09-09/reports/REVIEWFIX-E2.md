# REVIEWFIX-E2 — sipd listeners bind their own sockets (R07b cross-area item)

## The finding

REVIEWFIX-E pinned the upstream race and left it live in production: sipgo v1.4.3's
`ListenAndServe` starts a cancellation goroutine at `server.go:102` that reads `connCloser` and the
listening connection at `server.go:105-108` while the same function writes them at
`server.go:123-128`; `ListenAndServeTLS` has the identical shape at `server.go:177-188` vs
`server.go:208-213`. `cmd/sipd/main.go` used `ListenAndServe` for `tcp`/`ws` and
`ListenAndServeTLS` for `tls`/`wss` (only UDP had its own `serveUDP` bind), so every shutdown of a
TCP/TLS/WS/WSS deployment ran that race. Confirmed in `profile-rerun.txt` (two `WARNING: DATA RACE`
reports, both naming `server.go:102/105/108` vs `server.go:123/128`).

## FIXED — `apps/sipd/cmd/sipd/main.go`

`serveUDP` is generalised into `bindListener(network, addr, tlsConfig, bufferBytes, log)
(*boundListener, error)`. It binds every transport's socket itself and returns the bound address,
an `io.Closer` the caller owns, and the sipgo `Serve*` variant that takes an already-bound listener:

- `udp` → `net.ListenUDP` + `netbuf.Tune` (buffer sizing kept verbatim) → `Server.ServeUDP`
- `tcp` → `net.Listen("tcp", …)` → `Server.ServeTCP`
- `ws` → `net.Listen("tcp", …)` → `Server.ServeWS`
- `tls` → `net.Listen("tcp", …)` + `tls.NewListener` → `Server.ServeTLS`
- `wss` → `net.Listen("tcp", …)` + `tls.NewListener` → `Server.ServeWSS`

`ListenAndServe`/`ListenAndServeTLS` are no longer referenced anywhere in the module, so the racy
path is unreachable. A short comment at the `listen` closure and on `bindListener` names the
upstream lines so nobody reverts it.

Readiness semantics, unchanged in effect and stronger in ordering: `listen` now binds
**synchronously on the boot goroutine** and only then increments `readyListeners`, calls the same
`sipgo.ListenReadyFuncCtxValue` callback (same `log.Info("listening", …)` line, now with the
_bound_ address, so an ephemeral `:0` port is logged as the real one) and hands the socket to
`group.Go`. The health probe still reads `expectedListeners > 0 && readyListeners == expectedListeners`;
by construction that is now already true when `health.Start` is reached, which is what the fixed
profile test asserts (a bound socket is the readiness signal).

Bind failure is now fatal at boot: `listen` returns an error and each call site returns it out of
`run()`, so `sipd: listening on 0.0.0.0:5060: address already in use` reaches stderr and exits 1
instead of surfacing from a goroutine after the process has announced itself. TLS material handling
is unchanged (still loaded once before any listener); `bindListener` additionally refuses
`tls`/`wss` with a nil `*tls.Config` rather than silently serving plaintext. Socket close is still
one `context.AfterFunc(ctx, …)` per listener, so shutdown remains a single context cancel.

The `duplicateListener` check is untouched — it lives in `internal/config/config.go:463` and runs at
`config.Load`, before any of this. No helper was needed in `internal/config`.

## Tests — `apps/sipd/cmd/sipd/listeners_test.go` (new, 5 tests / 17 subtests)

- `TestBindListenerBindsBeforeReportingReady` — every transport on `127.0.0.1:0`: the returned
  address is a real bound host:port (not `:0`), a `serve` func is present, and a **second bind of
  that same address is refused**, which is the evidence the socket is held at the moment readiness
  would be reported; the stream transports additionally accept a dial.
- `TestBindListenerFailsLoudlyOnATakenPort` — a port already held (a `net.Listen` for the stream
  transports, a `net.ListenPacket` for udp): every transport fails and the error text contains the
  address.
- `TestBindListenerRefusesTLSWithoutACertificate` — `tls`/`wss` with a nil config.
- `TestBindListenerRejectsAnUnsupportedTransport`.
- `TestBoundListenerServeReturnsWhenTheSocketCloses` — serving each bound socket with a real
  `sipgo.Server` ends with nil or `net.ErrClosed` when the owner closes it, under `-race`, with no
  sipgo cancellation goroutine in play. Certificates are generated in-test (self-signed P-256).

Modern-Go: `list --file-path` run for `main.go`; nothing in the returned set applies beyond what the
new code already uses (`context.AfterFunc`, typed atomics).

## Not done

Nothing skipped. No cross-area change needed; `internal/config` was not touched, `apps/mediad` was
not touched, sipd was not restarted, nothing was committed.

## Verification (exact final output)

```
apps/sipd $ gofmt -l .                        → (no output)
apps/sipd $ go vet ./...                      → ok
apps/sipd $ go vet -tags e2e ./...            → ok
apps/sipd $ go vet -tags integration ./...    → ok
apps/sipd $ go vet -tags load ./...           → ok
apps/sipd $ go test -race -count=1 -p 1 ./...
  22 packages ok, 0 failures, 2 with no test files
  (cmd/sipd 1.600s, acl, aor, command, config, credentials, dialog, invite, kv, lease, metrics,
   mwi, nat, presence, profile, reaper, registrar, sipevents, siplog, subscribe, transfer, trunk;
   no test files: internal/events, internal/testutil/sipua)
```
