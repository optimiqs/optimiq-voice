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

#### When to bump `ROUTING_ARTIFACT_VERSION`

The rule is **"could a reader compiled against the previous version _misinterpret_ this?"**, not
"did the shape change". Those are different questions and only the first one is worth a flag day.

| change                                            | bump? | why                                                            |
| ------------------------------------------------- | ----- | -------------------------------------------------------------- |
| a new **optional** field on a node                 | no    | an old reader does not read it and keeps its existing fallback   |
| a new required field, or a new node **kind**       | yes   | an old reader hits a node it cannot execute                      |
| a field's meaning or units change under one name   | yes   | an old reader executes it confidently and wrongly                |
| a field removed                                    | yes   | an old reader reads `undefined` where it required a value        |

The additive optional fields in §2.5 are therefore **version 1** still. What actually forces the
recompile is the other token: `snapshotHash` moves the moment the input gains a collection, so
every cached artifact goes stale on the deploy that adds one and is rebuilt from the current
configuration. That is the migration, and it costs one compile per organization.

The corollary a reader must honour: **every optional node field needs a defined behaviour when it
is absent**, because an artifact compiled by the previous release is a legitimate input. "Fall back
to the media server's default class" and "play the deployment-wide announcement" are those
behaviours for the two fields added here.

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

### 2.5 What the compiler resolves, and why it is here rather than in the engine

Three facts are embedded into plan nodes at compile time. All three follow the same rule: **the
engine holds no database handle, so a fact it needs at the moment a call arrives either travels in
the artifact or does not exist.**

| node field                        | resolved from                        | absent means                                  |
| ---------------------------------- | ------------------------------------ | --------------------------------------------- |
| `mohClass` (5 node kinds)          | `moh_class.name` via `mohClassId`     | the media server's default class               |
| `VoicemailPlanNode.greetingMedia`  | the box's active `voicemail_greeting` | the reader's deployment-wide announcement      |
| `VoicemailPlanNode.pinHash`        | `voicemail_box.pin_hash`              | the box has no PIN; no challenge is issued     |

**Music on hold.** Every `mohClassId` in the snapshot is a row id, and every media server addresses
a class by its **name** — Asterisk's `POST /channels/{id}/moh` takes `mohClass=<name>` and answers a
UUID by selecting its default class with no error at all. The id stays alongside the name because
the id is the fact and a call-flow inspector needs it to link back to the row. A dangling or
disabled class is a **warning**: hold music is decoration, and a tenant who deleted a class four
ring groups still name has a configuration worth flagging, not a PBX that should stop routing calls.

**Voicemail greetings.** `pbx-db` models the active greeting as a flag on the greeting rows rather
than a pointer on the box (no circular foreign key; "activate this one" is a single-table update),
with at most one active row per `(box, kind)`. The compiler applies
`VOICEMAIL_LEAVE_GREETING_PRECEDENCE` — `temporary` beats `unavailable` — and embeds the winner as
`object://<objectKey>`, a **domain `MediaRef`**. Rendering it as a path here would bake one
deployment's storage layout into every artifact, and artifacts outlive deployments; resolving
`object://` to something a media server will play is the engine's media layer's job.

`busy` is deliberately unreachable: an extension's busy and no-answer branches compile to the *same*
`voicemail:<id>:leave` node, so nothing downstream can tell the two apart. Splitting that node is a
larger change than this one and is a recorded follow-up rather than a half-done feature. `name` is
the directory recording and is never a call greeting.

**The PIN digest.** See §3.1.

### 2.6 Failover and `continueOnCauses`

`TrunkDialPlanNode.continueOnCauses` defaults to `RETRYABLE_HANGUP_CAUSES` from
`@optimiq-voice/telephony`, never "every cause". Walking a whole trunk list after a `CALL_REJECTED`
multiplies one fraudulent attempt by the number of carriers a tenant has, which is exactly the
amplification a compromised extension is looking for. Tenants may narrow the set
(`settings.trunkContinueOnCauses`); unknown cause names are dropped with a warning.

### 2.7 Time conditions

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

### 3.1 The voicemail PIN digest format

`pbx-db`'s `voicemail_box.pin_hash` is a nullable `text` column with no stated format, and the API
deliberately excludes PIN fields from every DTO ("a PIN is set through a dedicated endpoint that
hashes it") — an endpoint that **does not exist yet**. So far the column has only ever been read as
`pinHash !== null`.

Once the compiler embeds that digest and the engine verifies a caller's digits against it, two
processes in different languages, released independently, have to agree on how to check a secret.
That agreement is a format, and a format with no owner drifts. This package owns it, in
`src/voicemail-pin.ts`, because it is the one module both sides already depend on and it depends on
nothing itself:

```
scrypt$N=<cost>,r=<block>,p=<parallelism>$<salt-base64>$<hash-base64>
```

- four `$`-separated fields; parameters **in the string**, so raising the cost is a re-hash on next
  set rather than a flag day — old digests keep verifying under their own parameters;
- standard base64 (`+/=`), salt ≥ 16 bytes, derived key exactly 32 bytes;
- `N` a power of two, and all three parameters bounded (`N ≤ 2²⁰`, `r ≤ 32`, `p ≤ 16`) — **and the
  working set `128·N·r` bounded at 64 MiB, which is the check that matters.** The per-parameter
  ceilings multiply: `N = 2²⁰` and `r = 32` are each individually inside their limit and together
  are a four-gigabyte allocation **on the call path**, triggered by a row somebody wrote. Refusing
  at parse time means it never reaches the KDF; 64 MiB is four times the recommended working set,
  so the cost can be raised twice before anyone revisits the number.

scrypt rather than bcrypt or argon2 for one decisive reason: `node:crypto.scrypt` is standard
library in every runtime here (Node, Bun) and `golang.org/x/crypto/scrypt` in the Go data plane, so
verification needs no dependency in a process that is on the call path. It is also what better-auth
— the only other password hasher in this monorepo — uses internally, so the operational story is one
algorithm rather than two.

This package **parses and validates only**. It does not hash and it does not verify: it is a pure
compiler, and giving it a KDF so a test could hash a PIN would put one on the resolver's import
graph. Hashing belongs to the API's (unbuilt) set-PIN endpoint, verification to `apps/engine`; both
read the parameters out of `parseVoicemailPinHash`.

A digest the compiler cannot parse raises an `invalid-pin-hash` **warning** and is **not embedded**,
so the mailbox keeps the authentication it had. Failing the compile would take a tenant's whole call
routing down over one mailbox; passing silently would hide "the PIN you set is not being enforced"
from the only person who can fix it. A warning is surfaced by the same machinery as every other
diagnostic, which is the point.

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

### 4.1 Optional collections

`mohClasses` and `voicemailGreetings` are declared **optional** on `OrgRoutingSnapshot` and listed
in `OPTIONAL_SNAPSHOT_COLLECTIONS`. That is a rollout affordance, not a modelling accident: they
were added after the API's snapshot loader was written, and a required field would have made this
package impossible to release before the loader caught up.

Absent and empty mean exactly the same thing everywhere. The shape assertion skips an absent
optional collection, `canonicalizeSnapshot` hashes it as `[]`, and the compiler's indexes read it
through `snapshotCollection`. One consequence is deliberate and worth stating: **a snapshot with no
`mohClasses` key produces no `dangling-moh-class` warnings at all.** A loader that has not learned
to load the table is a rollout state, not a tenant with four broken references, and one warning per
MOH id would bury the real diagnostics on every tenant simultaneously.

The loader populates both as of the API's voicemail wave (§7 item 2), so the optionality is free to
go — the only edit is deleting two `?`s and the two entries in `OPTIONAL_SNAPSHOT_COLLECTIONS`. It
is deliberately still here: removing it turns "a loader that has not caught up" from a supported
rollout state into a type error, and a released API predates the change. A major-version cleanup,
not a same-wave one.

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
2. ~~**Snapshot loader**~~ — **DONE.** Twenty RLS-scoped reads, no joins, disabled rows included,
   projected onto the `*Input` types. `moh_class` and `voicemail_greeting` are loaded and
   `voicemailBoxes` carries `pinHash`, so §2.5's embeddings fire: a compiled artifact now holds a
   mailbox's active greeting as `object://<objectKey>`, its PIN digest, and every `mohClassId`
   resolved to the class NAME a media server accepts.
   `apps/api verify:voicemail` asserts all three against a real artifact in the KV bucket.

   One thing this package can now clean up, and deliberately has not: `mohClasses` and
   `voicemailGreetings` are still `?`-optional and still listed in `OPTIONAL_SNAPSHOT_COLLECTIONS`.
   §4.1 says the only edit needed is deleting two `?`s and two entries — but doing it turns "a
   loader that has not caught up" from a supported rollout state into a type error, and there is
   still a released API that predates the change. Worth doing on the next major, not with it.
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
8. ~~**A set-PIN endpoint**~~ — **DONE.** `POST /voicemail-boxes/:id/pin` and a matching `DELETE`,
   in `apps/api/src/pbx/voicemail-boxes/voicemail-pin.service.ts`. It hashes with
   `node:crypto.scrypt` and `DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS` and writes
   `formatVoicemailPinHash(...)`, so §3.1 is a contract with a writer, a parser and a verifier in
   three different processes. Two properties worth recording here because they constrain anything
   that changes the format:
   - the write goes through the same repository `update` every other mutation uses, so setting a
     PIN recompiles the tenant and republishes the artifact — a direct column write would leave the
     engine verifying the previous digest;
   - `pin_hash` is excluded from every RESPONSE as well as every request DTO (the API's resource
     declarations carry a `secretColumns` list), because a digest in a response body is a digest
     somebody can crack offline, and a four-digit PIN behind scrypt is seconds of work.
9. ~~**An `rpc.voicemail.v1.list` responder**~~ — **DONE.** A `@MessagePattern` on the same NATS
   microservice `rpc.routing.v1.resolve` is served by, in
   `apps/api/src/pbx/voicemail-boxes/voicemail-rpc.controller.ts`. It makes the cross-check the
   request schema asks for by name — the box is loaded under `withTenantScope(orgId)` and its own
   `mailboxNumber` must equal the claimed one — and answers `found: false` with a reason for every
   refusal, never an empty list with `found: true`.

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
bun test src            # 647 colocated specs
pnpm typecheck
pnpm build              # tsc + ESM specifier rewrite -> dist/
```

`src/fixtures.ts` holds the spec builders. It is excluded from the build and is never re-exported
from `index.ts`: it is test scaffolding, not public API.
