# AREA: web-lib — `apps/web` (lib/, components/, scripts/, root config)

Scope audited: `lib/**` (api-client, auth-client, live, cdr, pbx, softphone, branding, carrier,
org-settings, provisioning, forms, permissions), `components/{pbx,ui}/**`, `scripts/**`,
`next.config.mjs`, `proxy.ts`, `Dockerfile`, `package.json`, `tsconfig.json`. `app/**` read only for
context (call sites of the live/softphone contexts).

Verified: `pnpm codegen:check` passes — `lib/permissions.generated.ts` is in sync with
`packages/auth/src/permissions.ts`. No permissions-SDK drift.

---

### [P0] `applyUpdate` never suppresses an unchanged KV `put`, contradicting its own contract (confidence: high)

- Where: `apps/web/lib/live/store.ts:51-88`
- Code:

```ts
/** Returns the SAME object when nothing changed, so React can skip a render: a KV bucket that
 * republishes an unchanged registration every time a phone refreshes would otherwise re-render a
 * table once per device per minute for no visible reason. */
...
const rows = new Map(state.rows);
rows.set(event.key, parsed);
return { rows, at: event.at, loaded: true };
```

- Problem: the documented "return the same object" optimisation is implemented only for a `delete`
  of an absent key (`store.ts:67-70`) and for an unparseable payload (`:78-81`). The `put` path —
  the exact case the comment names — always allocates a new `Map`, a new state object and a new
  `at`, so it is never reference-equal. Every consumer (`useLiveRegistrations`,
  `useLiveChannels`, `useLiveAgentState` in `app/(app)/_hooks/use-live-queries.ts`) calls
  `setState` with a fresh object and re-renders.
- Failure scenario / cost: sipd republishes a registration on every REGISTER refresh. With 300
  phones on a 60 s `Expires:`, the registrations table re-renders ~5×/s, each render rebuilding a
  300-entry `Map` plus the full row list — for a screen where literally nothing changed. Same for
  `active-calls` while a call is up. This is the P1-class render churn the file explicitly claims
  to prevent, so the code and the comment cannot both be right.
- Fix: compare before allocating, e.g.

```ts
const previous = state.rows.get(event.key);
if (previous !== undefined && sameValue(previous, parsed)) return state;
```

A shallow field compare per value shape (the file already has `sameParticipant` as the pattern to
copy) is enough; a generic `equals?: (a,b)=>boolean` parameter alongside `parse` keeps it typed.

- Cross-area: none (the hooks in `app/(app)/_hooks/use-live-queries.ts` need no change).

---

### [P1] `applyClaimFrame` has the same missing no-change guard for conference claims (confidence: high)

- Where: `apps/web/lib/live/store.ts:741-747` (doc) and `:794-803` (code)
- Code:

```ts
/** Returns the SAME object when nothing changed … a republished claim whose contribution lease
 *  merely rolled forward must not re-render a table of expanded rooms once per instance per heartbeat. */
const parsed = parseConferenceClaim(event.data);
if (parsed === undefined) return state;
const rooms = new Map(state.rooms);
rooms.set(parsed.conferenceId, parsed);
```

- Problem: `parseConferenceClaim` constructs a brand-new object on every frame, so `rooms.set` always
  stores a new reference and the returned state is always new. There is no comparison anywhere on
  this path.
- Failure scenario / cost: the engine renews a contribution lease on a heartbeat (`expiresAt` moves,
  `memberCount` unchanged). Every renewal re-renders the whole conference panel and re-runs
  `conferenceRoomViews` (which re-sorts every room and every participant list) — once per engine
  instance per heartbeat, per open tab, for a meeting nobody is changing.
- Fix: compare the parsed claim against `state.rooms.get(parsed.conferenceId)` on the fields the view
  reads (`bridgeId`, `locked`, and each contribution's `memberCount`/`moderatorPresent`) and return
  `state` when they match. Note the lease `expiresAt` DOES matter for `conferenceMemberCount`, so the
  comparison must include whether each contribution's expiry crosses `now` — simplest correct form is
  to compare everything except an `expiresAt` that is still in the future on both sides.
- Cross-area: none.

---

### [P1] Every extra lease on a live topic re-subscribes, producing O(N²) snapshot work on mount (confidence: high)

- Where: `apps/web/lib/live/client.ts:143-156`
- Code:

```ts
} else {
    existing.add(lease);
    // A late joiner has no snapshot of its own, so it is told to re-subscribe…
    this.sendSubscribe([topic]);
}
```

- Problem: the re-subscribe is sent unconditionally, and the resulting `snapshot` frame is dispatched
  to **every** lease on the topic (`client.ts:297-307`), not just the new one — the client has no way
  to address a snapshot at one lease.
- Failure scenario / cost: a wallboard that renders N tiles all leasing `agent-state` sends N
  subscribe frames on mount; the server answers with N whole-bucket snapshots; each is fanned out to
  all N handlers, so `applySnapshot` (which rebuilds the entire keyed `Map`) runs N² times and calls
  `setState` N² times. React 19 strict mode double-mounts, doubling it again. With 8 tiles and a
  500-agent bucket that is 64 full-bucket rebuilds and 64 renders for one page load, plus N× the
  server-side bucket read.
- Fix: two surgical options. (a) Only re-subscribe when the topic has no snapshot yet, caching the
  last snapshot per topic on the client and replaying it locally to the new lease:

```ts
const last = this.lastSnapshot.get(topic);
if (last !== undefined) handlers.onSnapshot?.(last);
else this.sendSubscribe([topic]);
```

(b) Failing that, coalesce re-subscribes for a topic within a microtask/short timer so N mounts in
one commit produce one frame. (a) is preferable and also fixes the fan-out, since the replay reaches
only the new lease.

- Cross-area: none required; (a) is purely client-side. If the server ever grows a per-request
  `id` echo on `snapshot` (`live-protocol.ts` already carries `id` on `subscribed`), the fan-out could
  be narrowed instead — that would be an `apps/api/src/live` change.

---

### [P1] The live client has no liveness watchdog; `LIVE_DEFAULT_HEARTBEAT_MS` is imported, re-exported and never used (confidence: high)

- Where: `apps/web/lib/live/protocol.ts:16-17`, `apps/web/lib/live/client.ts:3` and `:353`
- Code:

```ts
/** Server → client ping interval it advertises. Used as the client's own liveness expectation. */
export const LIVE_DEFAULT_HEARTBEAT_MS = 25_000;
```

and in `client.ts` the symbol appears only in the import list and in `export { LIVE_DEFAULT_HEARTBEAT_MS };`

- Problem: the comment states a liveness expectation the client does not implement. `LiveClient`
  never sends a `ping`, never tracks time-since-last-frame, and relies entirely on `onclose` firing.
  Grep across the whole app confirms the constant has no other reader.
- Failure scenario / cost: a half-open socket — laptop sleep/wake, NAT or corporate-proxy idle
  timeout, a killed API pod behind a load balancer that drops without a FIN — leaves `readyState ===
OPEN` with no frames arriving. `onclose` never fires, so no reconnect is scheduled and the status
  stays `"open"`. The wallboard/registrations/queue screens silently freeze on stale data while
  claiming to be live, which is the precise failure the "a wallboard showing a call that is not
  happening is worse than one showing none" argument in `store.ts:12-14` exists to prevent.
- Fix: in `connect()`, arm a timer reset on every `onmessage`; on expiry (e.g. `2 *
LIVE_DEFAULT_HEARTBEAT_MS`) call `this.socket?.close()` so the existing `onclose` →
  `scheduleReconnect()` path runs. Optionally send `{op:"ping"}` at the heartbeat interval first and
  only close if no `pong`/frame arrives. Clear the timer in `disconnect()`.
- Cross-area: none — the server already pings and already answers `ping` with `pong`
  (`apps/api/src/live/live-protocol.ts`).

---

### [P1] Softphone `peerConfiguration` refuses the call whenever the refreshed credentials differ at all (confidence: medium)

- Where: `apps/web/lib/softphone/jssip-adapter.ts:227-238`
- Code:

```ts
const credentials = (await this.options.refreshCredentials?.()) ?? original;
if (
	!credentials.webrtcSupported ||
	credentials.sipUri !== original.sipUri ||
	credentials.password !== original.password
) {
	throw new Error("The calling account changed or browser audio is disabled");
}
return { iceServers: [...(credentials.iceServers ?? [])] };
```

- Problem: the whole point of `refreshCredentials` (file header: "with fresh ICE credentials for each
  call"; `sip-adapter.ts:40` "Refresh short-lived relay credentials before establishing each media
  connection") is to pick up rotated TURN credentials. But the guard treats _any_ change in the SIP
  password as fatal, and `refreshCredentials` re-fetches the whole `/me/softphone` document
  (`app/(app)/_context/softphone-context.tsx:140-143`) — so a server-side SIP secret rotation, or any
  non-determinism in the derivation, makes every subsequent `call()`/`answer()` throw even though the
  existing REGISTER is still valid. `call()` swallows the throw into a generic
  `CALL_ENDED { reason: "Calling could not start. Reconnect the softphone and try again." }`, and
  `answer()` swallows it into a bare `terminate({ status_code: 480 })` with no user-visible reason at
  all — the incoming call is declined silently.
- Failure scenario / cost: after an admin regenerates the extension's SIP secret, the softphone stays
  visibly "Registered" but silently declines every incoming call with 480 and refuses every outgoing
  one with an unrelated message. The user has no path to the real cause.
- Fix: split the two concerns. Keep the identity check on `sipUri` only (that genuinely means "a
  different account / org switch") and, on a password change, tear the UA down and re-register rather
  than failing the call — or at minimum emit a distinct
  `REGISTRATION_CHANGED { state: "registration-failed", error: "Your SIP credentials changed; reconnect the softphone." }`
  so the UI can say so. Separately, give `answer()`'s catch an
  `emit({ type: "CALL_ENDED", reason: … })` before `terminate`, so a declined incoming call is not
  invisible.
- Cross-area: none in code; the wording change touches `app/(app)/_context/softphone-context.tsx`
  only if a new event type is added (it is not — reuse the existing two).

---

### [P2] `buildCallTree`'s cycle guard is dead code, and legs in a parent cycle vanish from the call detail (confidence: medium)

- Where: `apps/web/lib/cdr/format.ts:186-196`
- Code:

```ts
const visited = new Set<string>();
const build = (leg, depth) => { visited.add(leg.id); … };
return roots.filter((leg) => !visited.has(leg.id)).map((leg) => build(leg, 0));
```

- Problem: `.filter()` runs to completion before `.map()` starts, so `visited` is empty for every
  filter call — the guard can never exclude anything. The `.filter((child) => !visited.has(child.id))`
  inside `build` is real, but a leg whose `originatingLegId` chain forms a cycle (A→B→A) never enters
  `roots` at all and is therefore dropped from the tree entirely.
- Failure scenario / cost: a call whose leg parentage is cyclic (a transfer loop, or a data bug in
  `call_legs.originating_leg_id`) renders an expanded row that is silently missing legs, with no
  indication — on a screen whose stated job is "every leg of one call"
  (`lib/cdr/client.ts:79-85`). The dead filter also reads as protection that is not there.
- Fix: drop the no-op `roots.filter(...)`, and after the walk append any leg not in `visited` as an
  extra root so nothing is lost:

```ts
const trees = roots.map((leg) => build(leg, 0));
for (const leg of legs) if (!visited.has(leg.id)) trees.push(build(leg, 0));
return trees;
```

- Cross-area: none.

---

### [P2] No CSP header; `next.config.mjs` sets only three legacy headers (confidence: high)

- Where: `apps/web/next.config.mjs:40-51`
- Code:

```ts
{ key: "X-Content-Type-Options", value: "nosniff" },
{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
{ key: "X-Frame-Options", value: "DENY" },
```

- Problem: no `Content-Security-Policy` at all, on an app that injects a `<style>` via
  `dangerouslySetInnerHTML` (`components/ui/brand-theme-style.tsx:22`), renders tenant-supplied
  branding, plays media from signed third-party URLs, and opens a WebSocket. `X-Frame-Options` is
  superseded by `frame-ancestors` and does nothing that a CSP would not do better.
- Failure scenario / cost: any XSS that reaches the DOM — e.g. via a branding field or an API error
  message rendered as text today but as markup after a future refactor — executes unconstrained and
  can exfiltrate the first-party session cookie's authority by calling `/api/v1/*` directly. There is
  no `Strict-Transport-Security` either.
- Fix: add a CSP. `default-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none';
connect-src 'self' ws: wss:; media-src 'self' blob: https:; img-src 'self' data: https:;
style-src 'self' 'unsafe-inline'` is a workable starting point (the inline `<style>` and Tailwind
  need `'unsafe-inline'` for styles; a nonce is the follow-up). Add
  `Strict-Transport-Security: max-age=63072000; includeSubDomains`.
- Cross-area: none, but the policy must allow whatever origin `media-src` needs for signed recording
  URLs minted by `apps/api` — verify against the object-store host before shipping `'self'`-only.

---

### [P2] `app/layout.tsx` declares a favicon that does not exist anywhere in the app (confidence: high)

- Where: `apps/web/app/layout.tsx:25` — `icons: { icon: "/favicon.svg" }`
- Problem: there is no `apps/web/public/` directory and no `favicon.*` file anywhere in the workspace
  (`find . -name 'favicon*'` outside `node_modules`/`.next` returns nothing). `proxy.ts`'s matcher
  even excludes `.svg` to let it through. The `Dockerfile` correspondingly copies only
  `.next/standalone` and `.next/static` — correct today, and silently wrong the moment a `public/`
  directory is added, because `output: "standalone"` does not trace `public/`.
- Failure scenario / cost: every page emits a `<link rel="icon" href="/favicon.svg">` that 404s — a
  broken tab icon and one wasted request per navigation. Pre-emptively: adding `public/` later
  produces an image that works in `next dev` and 404s in Docker, which is a slow bug to find.
- Fix: add `apps/web/public/favicon.svg` (or an `app/icon.svg`, which Next traces automatically and
  needs no Dockerfile change), and if `public/` is used, add
  `COPY --from=builder --chown=appuser:appuser /work/apps/web/public ./apps/web/public` to the run
  stage beside the existing `.next/static` copy.
- Cross-area: `app/layout.tsx` is owned by the app-router auditor; the Dockerfile line is here.

---

### [P2] Resource ids are interpolated into request paths unencoded (confidence: medium)

- Where: `apps/web/lib/pbx/client.ts:842`, `:866`, `:876`, `:885`, `:896`, `:908`, `:919`, `:941`,
  `:967`, and the voicemail/prompt/greeting/conference helpers at `:1111`, `:1160`, `:1466`, `:1503`, `:1579`
- Code: ``await apiFetch<ItemEnvelope<TRow>>(`${resource.path}/${id}`)``
- Problem: `lib/carrier/client.ts:120` and `lib/org-settings/client.ts:143` do wrap their segment in
  `encodeURIComponent`, and `conferenceModerationPath` (`lib/pbx/client.ts:1330`) does too — the PBX
  CRUD helpers are the inconsistent ones. `id` reaches these from route params
  (`/extensions/[id]`), which are attacker-supplied strings, not guaranteed UUIDs.
- Failure scenario / cost: an id containing `?`, `#` or `..` reshapes the request — e.g.
  `deletePbx(resource, "x?force=true")` or a `..` that walks to a sibling collection. The API's own
  validation is the real gate, so this is a defence-in-depth and consistency issue rather than a
  known exploit; that is why it is P2 and not P0.
- Fix: `encodeURIComponent(id)` at each interpolation, matching the three helpers that already do it.
- Cross-area: none.

---

### [P2] `pbxListSearchParams` clamps `limit` only from above (confidence: medium)

- Where: `apps/web/lib/pbx/client.ts:804-816`
- Code: `params.set("limit", String(Math.min(MAX_PAGE_LIMIT, query.limit ?? DEFAULT_PAGE_LIMIT)));`
- Problem: `page` gets a `Math.max(1, …)` floor on the line above; `limit` gets no floor. A `limit`
  of `0` or a negative value from a URL query state reaches the server as-is.
- Failure scenario / cost: a bookmarked or hand-edited URL yields a 400 the list UI renders as a
  generic failure, where the neighbouring `page` parameter would have been quietly corrected. Trivial
  cost, but it is an asymmetry a reviewer would flag on sight given the line directly above it.
- Fix: `Math.min(MAX_PAGE_LIMIT, Math.max(1, query.limit ?? DEFAULT_PAGE_LIMIT))`.
- Cross-area: none.

---

## Things checked and deliberately NOT reported

- **Permissions codegen drift** — `pnpm codegen:check` passes; `lib/permissions.generated.ts` matches
  `packages/auth/src/permissions.ts` exactly, and `lib/permissions.spec.ts` cross-checks the
  predicates against the server implementation.
- **`compareParticipants` NaN comparator** (`store.ts:971-973`) — two participants with no `joinedAt`
  give `Infinity - Infinity === NaN`, but `NaN || left.legId.localeCompare(...)` falls through to the
  tie-break because `NaN` is falsy. Correct by accident, but correct; not worth a change.
- **`softphone-context.tsx` capturing `audioRef.current` at UA construction** — the `<audio>` is
  rendered unconditionally by the same provider (`:227`) and effects run after commit, so the ref is
  always populated. Not a bug.
- **`LiveClient.destroy()` / lease-release ordering** — release closures are idempotent (`released`
  flag), `scheduleReconnect` is guarded on `leases.size === 0`, and `send` swallows the throw from a
  closing socket. No leak found.
- **`apiFetch` / `apiUpload` duplication** — the `content-type` argument in the `apiUpload` docblock
  is correct; the browser must own the multipart boundary. The duplicated response-decoding block
  (~10 lines) is the only shared part and is not worth a helper that both would have to thread an
  error-message prefix through.
- **`brandThemeCss` → `dangerouslySetInnerHTML`** — every emitted value passes through
  `hexToOklch`, which returns `null` for anything the `/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/` regex
  rejects, and is then re-serialised from numbers. No injection path.
- **`proxy.ts`** — correctly optimistic, correctly excludes `/api`, and says so. `Dockerfile`'s
  `API_PROXY_ORIGIN`-is-build-time warning is accurate for `output: "standalone"`.
- **`query-client.ts` 4xx retry suppression, `query-keys.ts` org scoping** — both correct; the
  org-scoped key prefix is what prevents cross-tenant cache bleed on an org switch.
