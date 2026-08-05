# `@optimiq-voice/routing`

The routing compiler — the brain of the PBX, as a pure function.

One organization's configuration goes in as a plain snapshot; one deterministic, cacheable
**routing artifact** comes out; three resolvers turn that artifact into the plan the engine
executes for a given call. Nothing here opens a database, a broker or a socket, and nothing here
reads a clock.

```ts
import {
	compileRoutingArtifact,
	resolveInbound,
	routingCacheKey,
	snapshotHash,
} from "@optimiq-voice/routing";

const artifact = compileRoutingArtifact(snapshot, { compiledAt: new Date().toISOString() });
const route = resolveInbound(artifact, { did: "+12125550100", callerNumber, now: new Date() });
// route.plan.entryNodeId + route.plan.nodes is what the engine walks.
```

---

## 1. Why this package exists

FusionPBX compiles every feature into one central dialplan table and serves it to FreeSWITCH per
request, cached in memcached under structured keys, invalidated by the PHP layer on every save
(`plans/reference/fusionpbx-inventory.md` §5 item 1). §7 of the same document names that
invalidation contract *the single most load-bearing integration behaviour in the system* — and
upstream implements it as a convention repeated at 73 call sites.

Our rebuild keeps every feature a first-class entity and makes the compile step explicit:

- the **compiler** is a pure function, so its output is testable without a database;
- the **artifact** is versioned and content-hashed, so cache freshness is provable rather than
  assumed;
- the **invalidation contract** is one function with one rule, stated in §5 below.

---

## 2. The artifact contract

### 2.1 Envelope

```ts
interface RoutingArtifact {
	artifactVersion: number; // ROUTING_ARTIFACT_VERSION — bump on any breaking shape change
	organizationId: string;
	snapshotHash: string;    // SHA-256 of the canonical input snapshot
	compiledAt: string;      // ISO 8601, supplied by the caller
	settings: CompiledRoutingSettings;
	nodes: PlanNodeTable;    // id -> PlanNode, closed under reference
	timeConditions: Record<string, CompiledTimeCondition>;
	inbound: InboundMatchTable;
	internal: InternalMatchTable;
	outbound: OutboundMatchTable;
	callBlock: CompiledCallBlockRule[];
	extensionsByNumber: Record<string, ExtensionIndexEntry>;
	diagnostics: Diagnostic[]; // warnings only; errors never reach an artifact
}
```

Three properties are load-bearing:

1. **It is JSON.** No `RegExp`, no `Date`, no `Map`, no class instance. The artifact is written to
   the `routing-cache` KV bucket and read back by a different process, possibly a different
   release. `canonicalJson` throws on anything that would not survive the round trip.
2. **It is deterministic.** The same snapshot compiles to a byte-identical artifact: collections are
   sorted before they are walked, node ids are derived from the entities they came from, and
   `compiledAt` is the caller's, not `Date.now()`'s. That is what makes "recompile and compare
   hashes" a valid way to decide whether to write to the cache at all.
3. **It is versioned.** `parseRoutingArtifact` rejects an unexpected `artifactVersion` with
   `RoutingArtifactVersionError`. A reader that finds one must discard the entry and recompile —
   never walk it best-effort.

### 2.2 Node table, not a tree

Destinations form a graph, not a tree: an IVR option may point back at its parent menu, a ring
group's timeout may point at a queue whose timeout points back at the ring group. Inlining that
produces an infinite structure, so the artifact holds a flat, id-keyed **node table** and every
branch is a `PlanNodeId` reference into it.

Consequences worth knowing:

- one extension referenced by forty routes is **one node**, so the artifact grows with the tenant's
  configuration, not with the number of paths through it;
- "every reference resolves" is a property the compiler guarantees (`assertNodeClosure`) and the
  specs assert over every node;
- an `ExecutionPlan` is `{ entryNodeId, nodes }` where `nodes` **is** the artifact's table by
  reference — resolving a route is on the call path and must not copy a subgraph.

Node kinds: `extension`, `ring-group`, `ivr-menu`, `queue`, `voicemail`, `conference`, `park`,
`external`, `trunk-dial`, `application`, `playback`, `feature-code`, `time-condition`, `hangup`.
Terminals speak `@optimiq-voice/telephony`'s hangup-cause taxonomy verbatim.

### 2.3 Three contexts, three tables

Contexts are the security boundary, not a naming convention
(`plans/reference/freeswitch-capabilities.md` §7):

| context    | table                | who resolves in it                 | can reach a trunk |
| ---------- | -------------------- | ---------------------------------- | ----------------- |
| `inbound`  | `artifact.inbound`   | carrier traffic, unauthenticated   | **no**            |
| `internal` | `artifact.internal`  | a registered extension             | **no**            |
| `outbound` | `artifact.outbound`  | a registered extension, gated      | yes               |

Unauthenticated traffic cannot reach a trunk because the function that reaches trunks is not the
one it is allowed to call. Toll-fraud rule #1 is a property of the data structure rather than a
check somebody has to remember to write.

**Internal does not fall through to outbound.** An engine that wants both asks for both, in that
order, and the second call is where the toll-class gate applies.

### 2.4 Matching order

**Inbound** — `rules` pre-sorted by `(priority asc, specificity desc, id asc)`, then the DID's own
destination, then `UNALLOCATED_NUMBER`:

- specificity is `DID binding > exact > longest prefix > regex > any`;
- priority is the tenant's explicit intent and always wins; specificity only breaks its ties;
- a rule may carry a caller screen and a time gate; a closed gate with no branch skips the rule.

**Internal** — feature codes (longest code first), voicemail prefixes, exact internal numbers, park
slot ranges. Feature codes come first because they start with `*` and no internal number may;
voicemail prefixes come before numbers so `*99101` is a mailbox, not an extension called `*99101`.

**Outbound** — `rules` pre-sorted by `(priority asc, specificity desc, id asc)`; first matching
pattern within a rule wins; then the toll-class gate, then the time gate, then digit manipulation
(strip-then-prepend), then the ordered trunk failover chain.

A route the caller's toll class does not cover does **not** end resolution — the walk continues,
because a lower-class route further down may also match. Only when every matching route has been
refused does the call take `deniedNodeId` (`OUTGOING_CALL_BARRED`).

### 2.5 Failover and `continueOnCauses`

`TrunkDialPlanNode.continueOnCauses` defaults to `RETRYABLE_HANGUP_CAUSES` from
`@optimiq-voice/telephony`, never "every cause". Walking a whole trunk list after a `CALL_REJECTED`
multiplies one fraudulent attempt by the number of carriers a tenant has, which is exactly the
amplification a compromised extension is looking for. Tenants may narrow the set
(`settings.trunkContinueOnCauses`); unknown cause names are dropped with a warning.

### 2.6 Time conditions

Evaluated in the tenant's IANA zone via `Intl.DateTimeFormat`, against a caller-supplied instant.
The DST behaviour is deliberate and pinned by tests:

- **spring forward** — a window inside the hour that does not exist never matches that day;
- **fall back** — a window inside the repeated hour matches during **both** passes;
- **overnight** (`from > to`) is `[from, 24:00) ∪ [00:00, to]`, evaluated against the *same* day's
  other predicates, so "Fridays 22:00–06:00" means Friday evening plus Friday's small hours;
- both ends of a wall-clock window are **inclusive**.

A time condition has two roles, kept separate so neither field becomes dead configuration:

- as a **gate** (`route.timeConditionId`) it contributes only its rules and its no-match branch;
- as a **destination** (`destinationType: "time-condition"`) it contributes its own `destination`
  and `nomatchDestination`.

---

## 3. Diagnostics: error vs warning

The compiler runs on the write path (compile-on-save) as well as on a cache miss, and that decides
the line:

| severity    | meaning                                        | effect                       |
| ----------- | ---------------------------------------------- | ---------------------------- |
| **error**   | the artifact would not be *sound*               | no artifact; the save fails  |
| **warning** | sound artifact, probably not what was meant     | artifact ships with the note |
| **info**    | a decision a resolver made                      | call-path observability      |

Errors are things the CRUD layer must refuse to save: a dangling destination, an uncompilable
regex, two entities claiming the same internal number, an IVR option pointing at its own menu,
invalid digit manipulation, an unknown timezone, a conflicting feature code.

Warnings are the normal state of a half-built admin UI: an empty ring group (you create the group,
then add members), an outbound route whose trunks were all deleted, a route shadowed by an earlier
one, a mutually recursive pair of IVR menus, an unanchored dial regex.

The rule that falls out: **a warning never blocks a save, an error always does.**

Every enabled entity is compiled whether or not anything references it, so a ring group built
before it is wired up still produces its warning, and the artifact is a complete picture of the
tenant's call flows.

---

## 4. Input: `OrgRoutingSnapshot`

Plain, read-only arrays mirroring the relevant `packages/pbx-db` columns. The compiler declares its
own input types rather than importing the Drizzle schemas — importing them would drag a Postgres
driver into the engine, the resolver and every test, and would move the routing rules whenever a
column is added for a reason routing does not care about. The column-by-column mapping is
documented at the top of `src/snapshot.ts`.

Two rules for the loader:

1. **Do not filter out disabled rows.** `enabled = false` is a routing fact, not an absence.
2. **Do not pre-join.** Child collections are flat arrays keyed by their parent id; the compiler
   owns every join and sorts everything it walks.

---

## 5. The invalidation contract

```ts
routingCacheKey(orgId);                    // "<orgId>.artifact", in the `routing-cache` KV bucket
affectsRouting("ivr_menu_option");         // true  — a routing input
affectsRouting("voicemail_message");       // false — not a routing input
invalidationKeysFor({ organizationId, table, operation });      // [] or ["<orgId>.artifact"]
invalidationKeysForBatch(changes);         // deduplicated, sorted — one transaction, one eviction
snapshotHash(snapshot);                    // the freshness token
isArtifactFresh(artifact, snapshot);       // hash + org comparison
```

**The rule: one artifact per organization, one key per organization; any mutation to any entity in
`SNAPSHOT_COLLECTIONS` (plus org settings) invalidates it.**

### Why not finer-grained keys

The obvious refinement — `<orgId>.inbound`, `<orgId>.outbound`, `<orgId>.internal`, invalidated
independently — does not survive contact with the destination graph. An extension is a ring group
member, a ring group is an IVR option's target, an IVR is a DID's destination, and an outbound
route's failover destination can be any of them. Editing one extension's "forward on busy"
therefore changes nodes reachable from all three tables. Sub-keys would either be invalidated
together on every write (identical behaviour, three times the bookkeeping) or be invalidated
selectively and be wrong.

The refinement that *does* pay is the other axis: knowing which mutations are routing inputs at
all. A voicemail message, a CDR row, an agent status change and a device provisioning edit are not,
and `affectsRouting` says so, so the API does not evict a hot artifact on every voicemail.

### Alignment with `packages/events`

`ROUTING_CACHE_KV` (bucket `routing-cache`, 1 h TTL as a backstop only) and
`kvKeyFor.routingCache(orgId, artifact, discriminator?)` already exist there. This package produces
exactly the key `kvKeyFor.routingCache(orgId, "artifact")` produces — the format is asserted in
`cache.spec.ts` against the same `[A-Za-z0-9_-]+` token rule — but does **not** import it:
`@optimiq-voice/events` depends on `nats` and `zod`, and dragging a broker client into the pure
compiler would defeat the purpose of both. The one-line duplication is the cost of that boundary,
and the spec is what keeps it honest.

---

## 6. Engine integration sketch

```
inbound INVITE on a DID
        │
        ▼
  engine: kv.get("routing-cache", `${orgId}.artifact`)
        │
        ├── hit  ──► parseRoutingArtifact(value)     ── version mismatch ──┐
        │                    │                                            │
        │                    ▼                                            │
        └── miss ─────► request-reply `rpc.routing.v1.resolve` ◄───────────┘
                              │  { orgId, direction, destinationNumber, callerNumber,
                              │    routingContext, at }
                              ▼
                        api: load snapshot (RLS-scoped)
                             compileRoutingArtifact(snapshot, { compiledAt })
                             reply { matched, artifact, cacheKey, ttlMs, … }
                              │
                              ▼
                        engine: kv.put(cacheKey, artifact)
                              │
                              ▼
        resolveInbound(artifact, { did, callerNumber, now })
                              │
                              ▼
        ExecutionPlan { entryNodeId, nodes }  ──►  verb executor
```

On the write path the API compiles on save (`tryCompileRoutingArtifact`), returns the diagnostics
as field errors when it fails, and on success writes the artifact **and** deletes/overwrites the KV
key in the same unit of work as the row change.

Because `compiledAt` is the only non-derived field, a recompile that produces the same
`snapshotHash` can skip the KV write entirely.

---

## 7. What P3's API side still has to build

1. **CRUD** for every routing entity, with destination validation (`destinationShapeIssues` plus a
   real existence check against the target table — the database only enforces the trio's *shape*).
2. **Snapshot loader** — one RLS-scoped read per collection, projected onto the `*Input` types.
   Seventeen `select … where organization_id = $1`, no joins, disabled rows included.
3. **Compile-on-write** — after any mutation to a `ROUTING_TABLE_TO_ENTITY` table: load, compile,
   fail the request on errors, otherwise persist the artifact and evict/replace the KV key.
   `isArtifactFresh` short-circuits the write when nothing changed.
4. **`rpc.routing.v1.resolve` responder** — subscribe to the subject, compile on miss, reply with
   the artifact and `cacheKey`.
5. **Feature-code seeding** — `DEFAULT_FEATURE_CODES` on organization creation.
6. **Diagnostics surface** — map `Diagnostic.subject`/`path` onto form fields; the admin UI should
   show warnings inline rather than only on save failure.
7. **A "test this number" endpoint** — the resolvers with an explicit `now` are exactly the right
   shape for a "what happens if someone calls this DID on Sunday at 3am?" tool. It costs a
   controller.

### Notes that constrain the API, and one for `packages/events`

- **`routingResolveResponseSchema.destinationType` cannot express our destination types.** It is
  `z.string().regex(/^[a-z][a-z_]*$/)` (lower_snake_case, sourced from `cdr-db`), but the pbx-db and
  compiler vocabulary is kebab-case: `ring-group`, `time-condition`. The API must either omit that
  optional field, translate (`ring-group` → `ring_group`), or `packages/events` should relax the
  regex to `^[a-z][a-z-]*$`. **Recommendation: relax the regex** — the CDR is the odd one out here
  and every other kebab-case vocabulary in the system reads correctly.
- **`routingResolveResponseSchema.artifact` is `z.unknown()`**, which is right: the artifact's shape
  belongs to this package. The engine should call `parseRoutingArtifact` on it rather than trusting
  the reply, and treat a version mismatch as a hard failure.
- **`cacheKey` is `z.string().max(256)`** — `<uuid>.artifact` is 45 characters, so there is room.
- The rpc request carries `routingContext: string`. Use the `ROUTING_CONTEXTS` values
  (`inbound` / `internal` / `outbound`) exported here; `contextReachesTrunks` is the guard.

---

## 8. Development

```sh
bun test src            # 589 colocated specs
pnpm typecheck
pnpm build              # tsc + ESM specifier rewrite -> dist/
```

`src/fixtures.ts` holds the spec builders. It is excluded from the build and is never re-exported
from `index.ts`: it is test scaffolding, not public API.
