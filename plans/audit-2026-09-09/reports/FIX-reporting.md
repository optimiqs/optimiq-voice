# FIX — reporting (agent stats, call volume)

Audit finding: _"No historical agent-stats or volume-trend endpoint anywhere in `apps/api/src/cdr`;
only raw CDR list and export."_ Closed by extending the `queue-stats` family rather than replacing
it — `GET /cdr/queue-stats` is untouched.

## Endpoints

### `GET /api/v1/cdr/agent-stats` — permission `queues.monitor`

Query: `from`, `to` (ISO, default last 24 h, capped at `MAX_RANGE_DAYS` = 92), `agentId` (uuid),
`queueId` (uuid), `wrapUpSeconds` (1…3600, default 120), `limit` (1…2000, default 500).

```jsonc
{
	"data": [
		{
			"agentId": "…", // a `queue_agent` ROW id, never a user id
			"answered": 1,
			"talkTimeMs": 29036,
			"averageTalkTimeMs": 29036,
			"longestTalkTimeMs": 29036,
			"averageAnswerWaitMs": 25052,
			"averageRingTimeMs": 8,
			"wrapUpMs": 0,
			"averageWrapUpMs": 0,
			"wrapUpSamples": 0,
			"queues": [
				{
					"queueId": "…",
					"answered": 1,
					"talkTimeMs": 29036,
					"averageTalkTimeMs": 29036,
					"averageAnswerWaitMs": 25052,
				},
			],
		},
	],
	"wrapUpSeconds": 600,
	"truncated": false,
	"range": { "from": "…", "to": "…" },
}
```

`queues.monitor` and not `cdr.read`, matching `queue-stats`: the response names no call, no caller
and no number — it is counts and averages keyed on a seat id, and it is the other half of the
wallboard's question. Gating it on `cdr.read` would hand an agent-performance table the right to
read every conversation the tenant ever had.

**Wrap-up is an explicitly-labelled PROXY.** Nothing on this platform records an after-call-work
state, so there is no honest column to read. What the ledger can support is the gap between an
agent's consecutive answered calls (`lead(answered_at) over (partition by queue_agent_ref order by
answered_at) - ended_at`), CAPPED at `wrapUpSeconds` so the gap across lunch is not billed to the
previous caller. `wrapUpSamples` travels with it so a reader can distrust a mean of two, and the web
layer refuses to render the average below five samples. The module header argues the whole thing;
omitting the field was the alternative and was rejected because somebody would then compute it
downstream with no cap at all.

### `GET /api/v1/cdr/call-volume` — permission `cdr.read`

Query: `from`, `to`, `bucket` (`hour` | `day`, default `hour`), `limit` (buckets, default = max =
2208 = `MAX_RANGE_DAYS * 24`).

```jsonc
{
	"data": [
		{
			"bucket": "2026-09-09T16:00:00.000Z",
			"total": 236,
			"inbound": 178,
			"outbound": 0,
			"internal": 58,
			"answered": 56,
			"unanswered": 180,
			"averageDurationMs": 8026,
			"averageBillsecMs": 11299,
		},
	],
	"destinations": [{ "bucket": "…", "destinationType": "queue", "total": 15, "answered": 6 }],
	"bucket": "hour",
	"truncated": false,
	"range": { "from": "…", "to": "…" },
}
```

`cdr.read` — the UNSCOPED grant, and the only endpoint on the controller whose floor is not
`cdr.read.own`. There is no honest per-person version of "we took 400 calls this week", so a holder
of only the scoped grant is refused rather than shown a smaller number under the same label. This is
argued in the controller doc-comment.

Directions are three `count(*) filter (where …)` columns on one row per bucket. Destinations are a
SECOND grouped query rather than thirteen more columns, because `CALL_DESTINATION_TYPES` grows
(`paging` was appended after the fact) and a projection that has to be edited per new value is a
consumer that never hears about it. A type nobody routed to is absent, not zero.

`answered` is `answered_at is not null`, never `disposition = 'answered'` — a voicemail deposit
satisfies the second, and "we answered 80% of calls" meaning "80% reached a mailbox" is the single
most misleading number a phone system can print. Pinned by a test.

## Bounding: a limit, not a cursor

`cdr.repository.ts` pages by keyset because a listing over a ledger is unbounded. A grouped
aggregate is not. Agent groups are agents × the queues they took calls from — bounded by
CONFIGURATION. Volume buckets are a function of the window, which is already capped. A keyset cursor
over aggregate groups would have to be stable across a window whose contents change under it: a
correctness problem invented to solve a size problem that does not exist. So both are capped, both
report `truncated`, and both bounds are derived rather than chosen (`MAX_VOLUME_BUCKETS` is asserted
in a test to equal `MAX_RANGE_DAYS * 24`, so widening one without the other fails).

## Index decision

**One new index, added; the volume queries needed none.**

- `call-volume`: predicate is `started_at` between two bounds, organization from RLS. That is
  exactly `call_legs_organization_started_idx (organization_id, started_at DESC)`. **No index
  added** — it would have been a duplicate.
- `agent-stats`: predicate is `queue_agent_ref is not null and queue_outcome = 'answered'` over the
  window. The existing partial `call_legs_queue_idx (organization_id, queue_ref, started_at DESC)
WHERE queue_outcome is not null` does not serve it: the agent is not a key at all, so "how did
  this one agent do today" is a scan of every queued call in the range. **Added**
  `call_legs_queue_agent_idx (organization_id, queue_agent_ref, started_at DESC NULLS LAST) WHERE
queue_agent_ref is not null` — a strict SUBSET of the queue index's rows (only an answered queue
  leg names a seat), so its insert cost is paid by a small fraction of the ledger, and it carries
  the window function's ordering column in the right place.

Migration `packages/cdr-db/drizzle/20260909202819_cdr_reporting_indexes/migration.sql`, one
statement, plain `CREATE INDEX` (matching existing style), additive-only, verified by hand.

Live proof the planner uses it, against the running stack:

```
GroupAggregate → Sort → Append
  Subplans Removed: 2                       -- two partitions pruned by the range bound
  -> Index Scan using call_legs_2026_09_organization_id_queue_agent_ref_started_a_idx
       Index Cond: ((started_at >= now()-'7 days') AND (started_at <= now()))
       Filter: (queue_outcome = 'answered')
```

## Files

**API (new)** — `apps/api/src/cdr/query/agent-stats.ts`, `apps/api/src/cdr/query/call-volume.ts`.
Modelled on `queue-stats.ts` exactly: an exported unexecuted builder a spec asserts SQL against, a
`readX` that derives only what SQL should not, `count(*) filter (where …)`, `coalesce(round(avg(…)),
0)`, and the argumentative header.

**API (surgical, additive)** — `cdr.dto.ts` (`agentStatsQuerySchema`, `callVolumeQuerySchema`, both
`z.strictObject`, placed after `timeRangeShape` so they can reuse it), `cdr.controller.ts` (two
`@Get`s declared before `@Get(":id")`), `cdr.service.ts` (two envelopes, two methods, both inside
`withTenantScope`, both through the existing `this.range()` so `MAX_RANGE_DAYS` applies unchanged).

**cdr-db** — `src/schema/call-leg-schema.ts` (one index, additive),
`src/schema/cdr-schema.spec.ts` (its index-set assertion updated — that spec is not in the owned
list, but it enumerates the indexes exactly and would otherwise be red), new migration directory.

**Web** — `lib/cdr/contracts.ts`, `lib/cdr/client.ts` (`agentStatsParams`/`fetchAgentStats`,
`callVolumeParams`/`fetchCallVolume`), new `lib/cdr/reporting.ts` + `reporting.spec.ts`,
`lib/query-keys.ts` (two keys under `cdr`), `_hooks/use-cdr-queries.ts` (`useAgentStats`,
`useCallVolume` — neither polls, unlike `useQueueStats`; a report re-sorting under a supervisor's
cursor every 30 s is how a report stops being trusted), new
`app/(app)/reports/{page.tsx,_components/{reports-screen,agent-stats-table,call-volume-panel}.tsx}`.

Volume bars are CSS widths against the busiest bucket, not a charting dependency — the table IS the
chart and a screen reader can read it.

## Two things deliberately NOT done

1. **No nav entry.** `apps/web/lib/routes.ts` and `app/(app)/_components/nav-config.ts` are outside
   the owned file list and are being edited by other agents. `/reports` is reachable by URL and
   renders correctly; adding the sidebar link is a two-line follow-up in those files.
2. **No new permission.** `queues.monitor` and `cdr.read` only, as briefed. Note the consequence,
   stated in the controller: the `agent` role holds `queues.monitor`, so an agent can see
   colleagues' handling numbers — the same reach the wallboard already gives them.

## Verification (exact counts)

| Command                                              | Result                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/cdr-db run typecheck`  | pass, 0 errors                                                                                 |
| `pnpm --filter @optimiq-voice/cdr-db run test`       | **75 pass, 35 skip, 0 fail**                                                                   |
| `pnpm --filter @optimiq-voice/api run typecheck`     | pass, 0 errors                                                                                 |
| `pnpm --filter @optimiq-voice/api run test`          | **1374 passing, 0 failing** (39 of them new: 20 `agentStats.test.ts`, 19 `callVolume.test.ts`) |
| `pnpm --filter @optimiq-voice/web run typecheck`     | pass, 0 errors                                                                                 |
| `pnpm --filter @optimiq-voice/web run test`          | **847 pass, 0 fail** (16 new in `reporting.spec.ts`)                                           |
| `pnpm --filter @optimiq-voice/web run codegen:check` | `permissions.generated.ts is up to date`                                                       |
| `pnpm exec oxlint <owned dirs>`                      | 0 warnings, 0 errors                                                                           |
| `pnpm exec oxfmt <owned dirs>`                       | applied, clean                                                                                 |

The API tests use no database, exactly like `queueStats.test.ts`: `new QueryBuilder()` for the SQL
text (asserting the range bounds are unconditional and that `organization_id` never appears in a
predicate — RLS is the filter), a hand-rolled `fakeTransaction()` for the derivations, plus direct
DTO exercise.

## Live evidence (running stack)

Migration applied to `optimiq_cdr` on port 5533; api restarted twice; signed in as the smoke org
owner; org `01a08708-4cd4-76b9-b56d-d26ebf326b0a`.

- `GET /cdr/call-volume?bucket=day` over 30 days → **1 bucket, 4178 legs** (2757 inbound, 1421
  internal, 2710 answered, 1468 unanswered, avg duration 12 398 ms, avg billsec 18 268 ms), plus a
  destination series: `extension` 4113/2693, `ring_group` 40/4, `queue` 15/6, `ivr` 4/1.
- `GET /cdr/call-volume?bucket=hour` → **5 buckets**, chronological, `truncated: false`, e.g.
  16:00Z 236 calls / 56 answered, 17:00Z 452 / 259, 18:00Z 110 / 52.
- `GET /cdr/agent-stats?wrapUpSeconds=600` → agent `01a0870c-da58-…`, 1 answered, 29 036 ms talk,
  25 052 ms caller wait, 8 ms ring, `wrapUpSamples: 0` (only one queue-answered leg exists in this
  stack, so the capped-gap arithmetic has no second call to pair with; the window function itself
  executed, and the arithmetic was independently reproduced in psql over the same rows).
- `?bucket=century` → **400**. Unauthenticated → **401**. Route order confirmed in the Nest mapping
  log: `queue-stats`, `agent-stats`, `call-volume`, then `calls/:callId`, then `:id`.

### One bug the live check caught that the unit tests had not

The first live call 500'd: `column "call_legs.started_at" must appear in the GROUP BY clause`.
`date_trunc` binds its grain as a PARAMETER (deliberately — the DTO validates it as an enum today,
and that argument stops holding the first time somebody widens the schema), and repeating the
expression in `GROUP BY` emits a SECOND placeholder. Postgres compares grouping expressions by parse
tree, so `date_trunc($1,…)` and `date_trunc($4,…)` are not the same node. Fixed by grouping and
ordering on the projection's ordinal (`group by 1`), with `BUCKET_ORDINAL` documenting why, and a
test that asserts `date_trunc` appears exactly once per statement.
