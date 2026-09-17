# FIX-ops — backups/restore, Prometheus metrics, CDR retention scheduling

Area: `.scripts/backup/`, `docs/native-calling-deployment.md`, `compose.voice.yaml`,
`packages/runtime-go`, `apps/sipd` + `apps/mediad` (metrics package + `cmd/*/main.go` wiring only),
`apps/api` (`/metrics` + CDR retention job), `packages/cdr-db` (retention helper).
Nothing committed. No service was restarted.

---

## P0 — Backups and restore — FIXED

New: `.scripts/backup/{lib.sh,pg-backup.sh,jetstream-backup.sh,objects-backup.sh,backup.sh,restore.sh,README.md}`

**(a) Postgres.** `pg_dump --format=custom --compress=6` per database (`optimiq_voice`,
`optimiq_pbx`, `optimiq_cdr` — four journals, three databases: auth and legacy-API share the first).
`--no-owner`/`--no-acl` are deliberately NOT passed, because the RLS preflights assert ownership and
ACLs at boot and a dump without them restores a cluster the API refuses to start against.
`pg_dumpall --roles-only --no-role-passwords` alongside, so the artifact carries the roles and
grants `pg_dump` never emits and carries **no credential material**; `restore.sh` re-applies
`.scripts/local-stack/provision-roles.sql` with the target's own passwords. Per-table row counts are
captured post-`ANALYZE` for the restore to verify against.

**(b) JetStream.** `nats stream backup` per stream when the CLI is reachable (server-side, consistent,
no coordination); otherwise a store-dir copy, with the consistency caveat written out in the script
header rather than implied — a copy of a **running** broker is crash-consistent only, and the
recommendation is a filesystem snapshot or lame-duck mode. MEMORY streams (`presence`) are in
neither artifact; documented, with why it does not matter.

**(c) Object store.** `tar` for a filesystem root; for `s3://`, a server-side `aws s3 sync` into a
dated backup prefix plus a pointer in the set, so terabytes of recordings never pass through the
backup host.

**Ordering** is Postgres → JetStream → objects, so a set can only be skewed in the safe direction
(streams ahead of the ledger replay; an object with no row is inert). The reverse would produce rows
pointing at audio the copy predates.

**(d) Restore.** `restore.sh` verifies the manifest's SHA-256s, applies roles, `pg_restore`s into
**derived** database names, re-provisions the three runtime logins, `ANALYZE`s, compares every
table's count against the dump-time file, and smoke-reads each database twice — once as the owner,
once **as the runtime login**, which is what proves the grants, tenant-role membership and BYPASSRLS
survived. It refuses to run when the prefix/suffix leaves a name unchanged unless
`RESTORE_IN_PLACE=yes` is also set, so a drill cannot become an outage through a forgotten variable.

### Rehearsed live, into disposable targets (Postgres 5533, scratch store dir, scratch object root)

| Step                                                                                     | Time      | Result                                                           |
| ---------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------- |
| `backup.sh` — 3 DBs + JetStream + objects                                                | **2.8 s** | 13 MB set, manifest verified                                     |
| `restore.sh` into `*_drill`                                                              | **2.3 s** | 86 tables' counts matched exactly (18 + 56 + 12)                 |
| Owner smoke reads                                                                        |           | 59 users · 1 748 extensions / 16 orgs · 3 909 call legs          |
| Runtime-login smoke reads                                                                |           | `voice_api` 59, `voice_pbx` 1 748, `voice_cdr` 3 909 — identical |
| Restored JetStream store loaded by a scratch `nats-server` (real `nats.conf`, port 4399) |           | 28/29 streams, 65 551 msgs, `CDR` **3 909**                      |

The `CDR` stream's 3 909 messages against the ledger's 3 909 `call_legs` rows is the cross-check
worth keeping: the two halves of one set describe the same moment. The drill databases were dropped
afterwards; the live stack was never touched and is green (`/api/auth/ok` 200, NATS `/healthz` ok).

### Three real findings the rehearsal produced (all documented in the README and the runbook)

1. **`pg_restore` 17 against a PG16 server emits `SET transaction_timeout`**, which the server
   rejects — 3–6 "errors" per database that are entirely benign and make the error count useless as
   a signal. `restore.sh` now compares majors and warns.
2. **A store-dir copy needs the same ACCOUNT configuration to load.** Streams live under
   `<store>/jetstream/<ACCOUNT>/streams/`, so `nats-server -js -sd <dir>` reports **0 streams** —
   it looks in `$G`. The drill only worked with the deployment's own `nats.conf` and just the store
   dir overridden.
3. **A running-broker copy tears index files, measurably.** 10 of 29 streams logged
   `Recovering stream state from index errored: prior state file` on load. The server repaired all
   of them and message counts were intact — but that is a repair, not a guarantee, which is exactly
   the caveat the script header states.

**Runbook** — `docs/native-calling-deployment.md` § "Backups, restore and the retention runbook":
what is backed up, RPO/RTO with the honest statement that **there is no WAL archiving or PITR
anywhere in this repository** so the Postgres RPO is one backup interval, the rehearsal table above,
and a "what is NOT covered" list (PITR, the secrets and TLS material, MEMORY JetStream state,
in-flight calls, cross-version restores, and the fact that **nothing schedules `backup.sh`** — no
cron entry, CronJob or compose service; that step is the operator's).

---

## P1 — Prometheus metrics — FIXED (api, sipd, mediad). Engine is cross-area.

**`packages/runtime-go/metrics`** (new) — a private `prometheus.Registry` per service (never
`DefaultRegisterer`, so two services in one process cannot collide) with the process and Go
collectors, and `Counter`/`CounterVec`/`Gauge`/`GaugeFunc`/`CounterFunc`/`Histogram`/`HistogramVec`
helpers carrying the cardinality rule in their doc comments. `health.WithMetrics(handler)` (new
option, mirroring `WithPprof`) mounts it at `GET /metrics` on the **private** health listener; a nil
handler leaves the route unregistered. +2 health tests, +2 metrics tests.

**`apps/sipd/internal/metrics`** (new) + `cmd/sipd/main.go` wiring. Observes the SIP layer from
outside the handlers by wrapping every `sipgo.RequestHandler` and reading the final response off a
`ServerTransaction` decorator — so no handler can forget to count itself and the cardinality lives
in one file. `sipd_sip_requests_total{method}`, `sipd_sip_responses_total{method,status}`,
`sipd_registrations_total{outcome}` (accepted / **challenged** / refused — a 401 is the first half of
every digest exchange and is deliberately not an auth failure), `sipd_auth_failures_total{method}`
(403 only), `sipd_dialogs`, `sipd_subscriptions`,
`sipd_subscription_notifications_dropped_total`, and the three `sipd_auth_lockout_*` counters read
through the existing `Lockout.Stats()`. The observer's status field is an `atomic.Int32` because
INVITE/REFER answer from another goroutine — there is a `-race` test for exactly that. +3 tests.

**`apps/mediad/internal/metrics`** (new) + `cmd/mediad/main.go` wiring. Fed by decorating the
`rtp.Lifecycle` the Manager already calls, so the packet path carries **zero** added atomics — a
deliberate trade whose consequence is stated in the package header and the runbook: per-session
totals land when the session ENDS. `mediad_sessions`, `mediad_session_capacity`,
`mediad_sessions_ended_total{reason}`, `mediad_session_duration_seconds`,
`mediad_rtp_packets_{received,sent}_total`, `mediad_rtp_bytes_received_total`,
`mediad_rtp_packets_dropped_total{reason}` (malformed / unsupported_pt / foreign_source /
transport_rtp / transport_rtcp), `mediad_rtp_frames_suppressed_total{reason}` — suppression by
playback/DTMF/hold/mute is **not** loss and is labelled apart from it —
`mediad_rtp_frames_transcoded_total`, `mediad_rtp_timeouts_total`, `mediad_playbacks_finished_total`,
`mediad_recordings_finished_total`, `mediad_recording_duration_seconds`,
`mediad_dtmf_digits_received_total`. The decorator is transparent to the inner announcer (tested) and
tolerates a nil one. +3 tests.

No switch on either Go service, deliberately: pprof has one because it is a DoS and a memory
disclosure; a registry is a handful of atomics and an endpoint nothing reaches unless scraped. This
also kept the diff out of `internal/config`, which another agent is editing.

**`apps/api/src/core/metrics/`** (new) — `prom-client` (added, 15.1.3, the current latest), default
collectors including `nodejs_eventloop_lag_seconds`, and a **separate private `node:http` listener**
(`API_METRICS_ADDR`, default `127.0.0.1:9200`) rather than a route on the public port. One route,
404 for everything else, 500 rather than a partial body on a gather failure, and a bind failure is
logged and **not fatal** — `EADDRINUSE` on the metrics port must not stop an API that can carry
calls. A module singleton rather than a Nest provider because `main.ts`'s Fastify hook runs before
any injector exists; the reasoning is in the file header.

- `api_http_request_duration_seconds{method,route,status}` from an `onResponse` hook (not an
  interceptor — an interceptor misses everything a guard refused, every 404 and every body-parse
  failure). The label is the matched **route pattern** and the **status class**; an unmatched
  request is `unmatched`, so a 404 flood cannot invent series.
- `api_live_ws_clients` + accepted/refused/delivered, read off `LiveGateway.stats` at scrape time.
- `api_nats_consumer_pending` / `_ack_pending` / `_redelivered` / `_ack_floor` per durable, polled
  from the broker (lag is the broker's fact; a consumer-side counter reports "messages I processed",
  which looks healthy in precisely the outage where it stopped). Registered inside
  `ensureDurableConsumer`, including the "already exists" path, so a new CDR durable cannot be added
  without its lag being visible. Failures leave a stale series rather than failing the scrape, and
  `api_nats_consumers` vs `_registered` makes the staleness visible.

+10 API tests. `compose.voice.yaml` sets `API_METRICS_ADDR: 0.0.0.0:9200` (unpublished, so it stays
on the compose network). Scrape config, the full metric list, and the two alerts worth having first
are in the runbook.

---

## P1 — CDR retention scheduling — FIXED

`packages/cdr-db/src/retention.ts` and its 10 spec cases have existed since they were written; its
own header says "Phase 2 wires it to whatever scheduler the platform ends up with", and nothing ever
did. Now:

- **`packages/cdr-db`** — new `droppablePartitionsQuery(table, cutoff)`: the same catalogue join and
  upper-bound extraction as `cdr_drop_partitions_before`, as a plain SELECT that needs no DDL
  privilege, plus each partition's size. A dry run that answered a different question from the sweep
  it previews would be worse than none. +2 spec cases.
- **`apps/api/src/cdr/retention/leg-retention-sweeper.service.ts`** — a scheduled job in the shape of
  `CdrRecordingRetentionSweeper` and `CdrExportWorker`: `setInterval` + `unref`, under
  `CDR_WRITER_ENABLED` (N replicas racing on the same `DROP TABLE` would have N-1 report another's
  success as a failure), re-entrancy refused, a throwing pass never kills the schedule, and a public
  `sweep()` so a test drives it deterministically.
- **Dry run is the default.** `CDR_LEG_RETENTION_MONTHS=0` (disabled) and `CDR_RETENTION_DRY_RUN=true`.
  A dry pass does everything except the drop — plan, partition list with sizes, per-organization row
  tally — and logs it, which is the artifact an operator approves the first real pass from.
- **Audit.** New `CDR_LEG_RETENTION_AUDIT` port (CDR side) implemented by
  `CdrLegRetentionAuditService` (PBX side) through `PbxCdrPortsModule`, exactly as
  `RECORDING_PURGE_AUDIT` is, and injected `@Optional()` so retention keeps being enforced without
  the PBX area. One `audit_log` row per organization per destroyed partition
  (`cdr.retention.drop`, `resource_ref` NULL because a partition is not a uuid — the name, the row
  count and the window live in `before`). The counts are gathered **before** the drop, because
  afterwards there is nothing to count; only partitions the drop actually returned are recorded.
- **Recordings** are already covered by `CdrRecordingRetentionSweeper` (objects first, rows second)
  and by the per-tenant `recordings.retentionDays` org setting.

+9 tests (`apps/api/test/cdr/legRetentionSweeper.test.ts`), including that the tally is issued before
the drop and that dry-run issues no `cdr_drop_partitions_before` at all.

### One deliberate refusal, stated rather than hidden

**A per-organization window on call LEGS is not implementable on this schema and I did not fake it.**
`call_legs`/`call_events` are partitioned by month so expiry is a `DROP TABLE`, and a partition holds
every tenant's legs for that month. A shorter per-org window would be a batched `DELETE` against
tables that are append-only **by privilege** (`GRANT SELECT, INSERT` only, per the CDR baseline), so
it would need a new grant and would reintroduce exactly the bloat partitioning exists to avoid; a
longer one is not expressible once the partition is gone. So the leg window is the platform's, no
org-settings entry was added for it (the catalogue _would_ have accepted one — that is why this is a
refusal and not an omission), and the reasoning is in the service header, `cdr-env.ts` and the
runbook. The per-tenant window that does exist and is enforced is `recordings.retentionDays`.

---

## Additional things noticed

- **`KV_KV_routing-cache`** exists on the live broker alongside `KV_routing-cache` — a double-prefixed
  bucket, i.e. something passed an already-prefixed stream name to a KV create. Harmless residue, but
  it is a bug somewhere in the engine's or a script's KV bootstrap. Not my area; not touched.
- `packages/runtime-go/health/health.go` was **reverted under me mid-pass** (another agent rewrote it
  from an older copy) and I re-applied `WithMetrics`; if that agent's pass lands again after this
  one, check that `WithMetrics` and the `metrics http.Handler` option field survive.

## Cross-area needed

1. **`apps/engine` has no `/metrics`.** It is the one service in the call path still opaque between
   `/healthz` and a heap dump, and `E2E-load.md` found it pegged at one core with no way to see it
   coming. The wiring is the same shape as `apps/api/src/core/metrics`: a private `node:http`
   listener on `ENGINE_METRICS_ADDR`, `prom-client` default collectors,
   `engine_active_channels` from the channel map, per-verb plan-walker latency, and the JetStream
   consumer-lag collector (`apps/api/src/core/metrics/jetstream-metrics.ts` is copyable as-is).
   Listed as cross-area because `apps/engine` is another agent's.
2. **Nothing schedules `backup.sh`.** A compose one-shot service or a CronJob is a deployment-artifact
   change; I did not add one because the artifact set's destination is site-specific and a backup
   writing into a container filesystem would be worse than none.
3. **The PBX-area durable consumers** (voicemail, emergency, trunk status, sip auth events) do not go
   through `ensureDurableConsumer`, so their lag is not on the scrape. One `trackDurableConsumer`
   call each; their files belong to the api-pbx agents.

## Verification (exact final output)

| Check                                                                                 | Result                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm --filter @optimiq-voice/api run typecheck`                                      | pass (both `tsconfig.json` and `tsconfig.strict.json`) |
| `pnpm --filter @optimiq-voice/api run test`                                           | **1393 passing, 0 failing**                            |
| `pnpm --filter @optimiq-voice/cdr-db run typecheck`                                   | pass                                                   |
| `pnpm --filter @optimiq-voice/cdr-db run test`                                        | **75 pass, 35 skip, 0 fail** (110 across 7 files)      |
| `pnpm exec turbo run typecheck --filter=...@optimiq-voice/cdr-db`                     | **14 successful, 14 total**                            |
| `pnpm exec turbo run build`                                                           | **16 successful, 16 total**                            |
| `pnpm exec oxlint` / `oxfmt` on the touched dirs                                      | clean (33 files)                                       |
| `gofmt -l` · `go vet ./...` · `go test -race -count=1 ./...` in `packages/runtime-go` | clean · clean · **4 ok, 0 FAIL**                       |
| same in `apps/sipd`                                                                   | clean · clean · **21 ok, 0 FAIL**                      |
| same in `apps/mediad`                                                                 | clean · clean · **8 ok, 0 FAIL**                       |
| `bash -n` on all six backup scripts                                                   | clean                                                  |
| `docker compose -f compose.yaml -f compose.voice.yaml config --quiet`                 | exit 0                                                 |
| actionlint                                                                            | not run — no CI file touched                           |

## Stack log

- **No service restarted.** The metrics and retention changes are in the tree and need a restart
  (api, sipd, mediad) to take effect; nothing observable on the running stack has changed.
- Ran `pg_dump`/`pg_restore` against the live Postgres on 5533 and created/dropped
  `optimiq_{voice,pbx,cdr}_drill`. `ANALYZE` was run against the three live databases as part of the
  backup (cheap, and it refreshed stale planner statistics — the only side effect on the live stack).
- Booted a throwaway `nats-server` on 4399/8399 against a scratch store dir and killed it. Zero
  writes to the live broker; zero new permission violations.
- Artifacts left in `<scratchpad>/backup-drill/` (backup set, restored store dir and object root).
