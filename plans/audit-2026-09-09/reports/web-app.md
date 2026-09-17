# Audit — AREA: web-app (`apps/web/app`)

Scope: every file under `apps/web/app` — `(app)` route group (screens, `_components`, `_context`,
`_hooks`), `(auth)` route group, root layout/not-found. `apps/web/lib` and `apps/web/components` were
read for context only and are **not** audited here (another agent owns them); where a fix reaches into
them it is flagged under **Cross-area**.

## Overall

This is unusually disciplined front-end code. There are no `any` casts, no `@ts-ignore`, no
non-null assertions, exactly **one** `dangerouslySetInnerHTML` in the whole tree, and only **13 files
containing a `useEffect`** across ~37k lines. Permission gating is centralised in one URL→permission
map that both the sidebar and the route guard consult, so a visible nav entry and a 403 page cannot
disagree. Credential surfaces (provisioning token, webhook signing key, API key) are all "shown once,
held in component state, never cached". Query keys are built through a factory and invalidation is
coarse-on-purpose and documented.

Several things that _looked_ like bugs were verified and dropped, and are recorded here so the next
reader does not re-open them:

- **Dialogs on detail pages have no `key=` while sibling dialogs do** (8 sites). Not a bug:
  `@tanstack/form-core@1.33.3` `FormApi.update()` re-applies `defaultValues` when they change and
  the form is untouched (`FormApi.js:94`), and every one of these dialogs calls `form.reset()` on
  close and on successful submit, which clears `isTouched`. The derived destination state is
  likewise re-seeded from the freshly-computed `initial*` in the close handler.
- **`follow-me-field.tsx` uses `key={index}`.** Safe — `FollowMeRow` is fully controlled and holds
  no internal state; the file argues the case correctly.
- **`brandThemeCss` feeding `dangerouslySetInnerHTML`.** Not an XSS: `deriveBrandRoles` passes every
  value through `hexToOklch` (returns `null` for non-hex) and emits only computed OKLCH numbers. The
  finding below is about the lint error and the cheaper construction, not about a vulnerability.
- **Voicemail folder switch leaving a stale page number.** `setPage(1)` is called on the tab handler
  (line 139).
- **`safeRedirectTarget`** correctly rejects `//`, `\` and non-`/`-prefixed values.

Counts: **0 P0**, **5 P1**, **7 P2**.

---

## P1

### [P1] `useCdrCall` omits the time range from its query key, so a widened window serves the narrow answer (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/_hooks/use-cdr-queries.ts:120-124`
- Code:
  ```ts
  queryKey: queryKeys.cdrCall(organizationId, callId ?? ""),
  queryFn: () => getCall(callId as string, range),
  ```
- Problem: `range` is sent to the server (`getCall` puts `from`/`to` on the query string — `lib/cdr/client.ts:86-94`)
  but is **not** part of the cache key. `queryKeys.cdrCall(organizationId, callId)` takes only the
  call id. Two different windows for the same call therefore share one cache entry, and with the
  app-wide `staleTime: Infinity` (`lib/query-client.ts:19`) the first answer is served forever.
  This directly contradicts two comments in the same file: the header at line 51-55 ("The whole query
  object — **including the resolved time range** — is the cache key, so changing the range is a NEW
  query rather than a refetch of the old one: two different windows are two different answers and
  must never share an entry"), and the hook's own doc at line 111-114 ("defaulting it to 24 hours
  would hide the legs of a call the user found by widening the window"). `useCdrList`,
  `useRecordingList`, `useQueueStats` and both ledger hooks all spread the query into the key
  correctly; this is the one that does not.
- Failure scenario / cost: A support agent on `/cdr` expands a call inside the default 24h window and
  sees, say, the A-leg only (the B-legs started outside the window). They widen the range to 30 days
  and re-expand the same call to find the missing legs. React Query returns the cached narrow-window
  `CallDetail` and never issues a request. The legs stay missing, permanently, for the life of the
  tab — which is exactly the failure the doc comment claims to have prevented. It is also
  unrecoverable by any UI action short of a hard reload.
- Fix: put the range in the key, mirroring `useCdrList`:
  ```ts
  queryKey: queryKeys.cdrCall(organizationId, callId ?? "", { from: range.from ?? null, to: range.to ?? null }),
  ```
  and widen `queryKeys.cdrCall` to take the third argument (it currently takes two —
  `lib/query-keys.ts:210`). Keep it under the same `cdrCall` prefix so existing invalidation still
  matches.
- Cross-area: yes — `apps/web/lib/query-keys.ts:210` (`cdrCall` signature) must gain the query
  argument. One-line change, same shape as the neighbouring `cdrList` factory at line 207.

### [P1] Sign-up silently discards `redirectTo`, losing the invitation it was sent to accept (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(auth)/sign-up/page.tsx:54-58`
  (producer: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(auth)/accept-invitation/[invitationId]/page.tsx:120`)
- Code:
  ```tsx
  // accept-invitation builds it:
  render={<Link href={`${routes.signUp}?redirectTo=${encodeURIComponent(back)}`} />}
  // sign-up ignores it:
  router.replace(result.data?.token ? routes.overview : `${routes.verifyEmail}?email=...`);
  ```
- Problem: `sign-up/page.tsx` never calls `useSearchParams()` and never reads `redirectTo` — verified
  by grep, the string does not appear in the file. `sign-in-form.tsx:37` and `two-factor-form.tsx:37`
  both do (`safeRedirectTarget(searchParams.get("redirectTo"))`). The invitation page deliberately
  constructs the parameter and documents why (lines 22-25: "bouncing them to a bare sign-in screen
  loses the invitation id and the invitation with it") — and then the only screen it hands it to
  throws it away.
- Failure scenario / cost: The primary onboarding path for a new user. Recipient of an invitation
  email opens `/accept-invitation/<id>`, has no account, clicks **Create an account**. They sign up
  successfully and land on `/` (or `/verify-email`), where — having no organization — they are shown
  the `NoOrganization` "Create an organization" screen (`app/(app)/layout.tsx:76-82`). The invitation
  is never accepted. Worse, the obvious next action offered to them is to create a _second_,
  unwanted organization. The invitation id is gone from the URL and the user has no way back except
  re-opening the original email.
- Fix: read and honour the parameter, exactly as `sign-in-form.tsx` does:
  ```tsx
  const redirectTo = safeRedirectTarget(searchParams.get("redirectTo"));
  ...
  router.replace(
    result.data?.token
      ? redirectTo
      : `${routes.verifyEmail}?email=${encodeURIComponent(parsed.email)}&redirectTo=${encodeURIComponent(redirectTo)}`,
  );
  ```
  Because `useSearchParams()` opts a route out of prerendering, split the file the way the other
  three auth routes already are: a server `page.tsx` with a `<Suspense>` shell plus a
  `sign-up-form.tsx` client component (copy the 25-line pattern from `sign-in/page.tsx`). Also worth
  threading `redirectTo` through `verify-email` so the post-verification hop lands on the invitation
  too. Note the related edge in `proxy.ts:30`: an _already signed-in_ visitor to
  `/sign-up?redirectTo=…` is redirected to `routes.overview`, dropping the parameter as well — it
  should redirect to the validated `redirectTo` when one is present.
- Cross-area: `proxy.ts` (repo root of `apps/web`, not under `app/`) for the second half only.

### [P1] `useLiveAgentStates` fires a cache invalidation from inside a `setState` updater (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/_hooks/use-live-queries.ts:188-205`
- Code:
  ```ts
  setState((previous) => {
      const next = applyUpdate(previous, event, parseAgentState);
      if (next !== previous && organizationId.length > 0) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.pbxResource(...) });
      }
      return next;
  });
  ```
- Problem: a state updater must be a pure function of `previous`. React may invoke it more than once
  for a single dispatch (StrictMode double-invocation in development is the documented case; a
  discarded or replayed concurrent render is the production one), and it may invoke it for a render
  that is then thrown away. The updater here performs I/O. The code comment at lines 193-197
  acknowledges the problem and waves it off ("Fired outside the state update on the next tick would
  be tidier, but the invalidation is idempotent and TanStack batches it") — but idempotent is not
  free: each invalidation is a real `GET /queue-agents` against the API.
- Failure scenario / cost: On a busy floor `agent.state` transitions arrive continuously. In dev
  every transition costs two invalidations rather than one. More importantly the _trigger_ is wrong:
  the request fires during render rather than after commit, and on a queue with 40 agents changing
  state a few times a minute this is a steady refetch stream driven from a code path React does not
  guarantee to run once. It is also the only place in the whole app that does this — every other
  socket→cache bridge in this file deliberately does not invalidate.
- Fix: keep the updater pure and move the effect out. Track whether a transition happened and
  invalidate from an effect:
  ```ts
  const [revision, setRevision] = useState(0);
  const onUpdate = useCallback((event) => {
  	setState((previous) => {
  		const next = applyUpdate(previous, event, parseAgentState);
  		if (next !== previous) {
  			setRevision((r) => r + 1);
  		}
  		return next;
  	});
  }, []);
  useEffect(() => {
  	if (revision === 0 || organizationId.length === 0) {
  		return;
  	}
  	void queryClient.invalidateQueries({
  		queryKey: queryKeys.pbxResource(organizationId, PBX_RESOURCES.queueAgents.key),
  	});
  }, [revision, organizationId, queryClient]);
  ```
  (`setRevision` inside the updater is still a nested update, so if you want it strictly clean, derive
  `revision` from `state` identity in the effect instead: `useEffect(..., [state])` with a
  first-render guard.)
- Cross-area: none.

### [P1] The dashboard's registered-device count has no clock, so lapsed bindings never decay (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/_hooks/use-live-queries.ts:102-118`
- Code:
  ```ts
  return useMemo(() => {
      const now = Date.now();
      ...
      liveCount: rows.filter((row) => isRegistrationLive(row, now)).length,
  }, [state, permitted]);
  ```
- Problem: `isRegistrationLive` is time-dependent — `lib/live/store.ts:123-126` is
  `now < Date.parse(registration.expiresAt)` — but `now` is captured inside a memo whose deps are
  only `[state, permitted]`. Nothing recomputes it as the wall clock advances, so the count is frozen
  at whatever it was when the last frame arrived. This is precisely the problem `useLiveQueue`
  (lines 346-357) and `useLiveConferences` (lines 571-581) each solve with a 1-second
  `setInterval` tick, and each documents at length ("a caller's wait grows without anything arriving
  on the socket… a crashed instance's seats stop counting"). `useLiveRegistrations` has the same
  time-dependence and no tick. (`useLiveActiveCalls` is fine — `isChannelLive` is a pure state check,
  not a clock comparison.)
- Failure scenario / cost: SIP `Expires` is typically 60-3600s. A phone that is unplugged or loses
  its network never sends a de-REGISTER, so no frame is published for it; its binding simply lapses.
  The dashboard tile keeps counting it as a registered device indefinitely, and — because the hint
  text is derived from the _same_ frozen comparison
  (`registrations.rows.length > registrations.liveCount`, `app/(app)/page.tsx:82-86`) — the "N
  binding(s) have lapsed and are being swept" line never appears either. On the one screen whose
  stated purpose (`page.tsx:38-42`) is "Not loaded is not zero… a number that was briefly,
  confidently wrong is worse than a number that is briefly absent", the device count is confidently
  wrong for as long as the tab is open.
- Fix: add the same guarded tick the two sibling hooks use, and put it in the memo deps:
  ```ts
  const [tick, setTick] = useState(() => Date.now());
  const pending = state.rows.size;
  useEffect(() => {
  	if (!permitted || pending === 0) {
  		return;
  	}
  	const handle = setInterval(() => setTick(Date.now()), 30_000);
  	return () => {
  		clearInterval(handle);
  	};
  }, [permitted, pending]);
  // then use `tick` instead of `Date.now()` and add it to the dep array
  ```
  30s rather than 1s is right here: registration expiries are minutes-scale and this drives a single
  headline number, not a per-second wait timer.
- Cross-area: none.

### [P1] Reference pickers and roster lookups are hard-capped at the API's first page of 100, with no search escape hatch (confidence: medium)

- Where: 11 call sites, e.g.
  `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/queues/_components/queue-agents-panel.tsx:44`,
  `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/shared-lines/_components/shared-line-detail.tsx:70`,
  `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/paging-groups/_components/paging-group-detail.tsx:59`,
  `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/wallboard/_components/wallboard-screen.tsx:63`,
  `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/wallboard/_components/operator-panel.tsx:66`,
  `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/queues/_components/queue-detail.tsx:83`
- Code:
  ```ts
  /** Members carry an extension id; the table has to say a number. Capped at the API's page size. */
  const extensions = usePbxList(PBX_RESOURCES.extensions, { page: 1, limit: 100 });
  const extensionsById = new Map(extensions.rows.map((row) => [row.id, row]));
  ```
- Problem: two distinct consequences of the same cap, and only one of them is handled honestly.
  (a) **Pickers.** `ResourceSelect`/`PromptSelect` (`components/pbx/resource-select.tsx:142-153`)
  fetch `page: 1, limit: 100` and render "Showing the first N of total" when truncated — the cap is
  _admitted_, but there is no way past it: the query supports `search` and never sends one, so a row
  beyond the first 100 is genuinely unselectable.
  (b) **Roster/name lookups** — the six sites listed above. These build a `Map` used to label rows,
  and they surface **nothing** when truncated. A member whose extension is not in the first 100
  renders as `${id.slice(0,8)}… (not found)` or blank.
  The wallboard case additionally contradicts its own doc: `wallboard-screen.tsx:54-61` states "Every
  configured queue is listed, including the silent ones… a queue that received no calls all morning
  [must not be] indistinguishable from one that was deleted" — but queue 101 is not listed at all.
- Failure scenario / cost: A 150-extension tenant — an entirely ordinary PBX size, and the product
  ships a `maxExtensions` quota screen implying far more. Extensions 101-150 cannot be assigned to a
  queue agent, a paging group or a shared-line appearance from any screen, and where they _are_
  already assigned (via API or a smaller earlier list) the membership tables show truncated UUIDs
  instead of extension numbers. On the wallboard, queues past the hundredth are invisible with no
  indication that anything was omitted.
- Fix: two surgical steps, in this order.
  1. For the lookup maps, render the truncation rather than hiding it — the data is already in hand
     (`extensions.total` vs `extensions.rows.length`). Add the same one-line notice
     `ReferenceSelectShell` uses beneath the affected table, so a truncated roster is visibly
     truncated. Cheapest correct change.
  2. For the pickers, make `ResourceSelect` searchable: it already keys on `search: null`, so
     threading a debounced input into `search` and into the key is a contained change in one shared
     component and fixes all of its call sites at once.
     Raising `limit` is not a fix — it moves the cliff.
- Cross-area: yes for step 2 — `apps/web/components/pbx/resource-select.tsx` (owned by another
  agent). Step 1 is entirely within this area.

---

## P2

### [P2] `dangerouslySetInnerHTML` in the branding preview — the known lint error, and it is avoidable (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/settings/branding/page.tsx:220-222` (with the source at 62-64)
- Code:
  ```tsx
  {
  	/* eslint-disable-next-line react/no-danger */
  }
  {
  	scopedPreviewCss ? <style dangerouslySetInnerHTML={{ __html: scopedPreviewCss }} /> : null;
  }
  ```
- Problem: **This is not an XSS.** I traced it: `brandThemeCss` (`lib/branding/theme.ts:212-214`)
  emits only `block(":root", light)` / `block(".dark", dark)` over `deriveBrandRoles`, and every
  value there is `oklchCss(...)` of numbers produced by `hexToOklch`, which returns `null` for
  anything that is not a hex colour. No user string reaches the output. The problem is that the
  construction is needlessly dangerous _and_ unnecessarily indirect: the page generates a CSS string
  and then string-rewrites the selectors out of it
  (`.replace(/:root/gu, "[data-brand-preview]").replace(/\.dark /gu, ".dark [data-brand-preview]")`)
  to scope it. That regex rewrite is the fragile part — if `theme.ts` ever emits a third block or a
  nested selector, the scoping silently breaks and the half-typed preview theme leaks onto the live
  app shell, which is the exact outcome the comment at lines 60-61 says it is preventing.
- Failure scenario / cost: today, a suppressed lint error and a scoping mechanism that depends on the
  textual shape of another module's output. Tomorrow, a `theme.ts` change that leaks a preview theme
  into the app chrome.
- Fix: the preview needs custom properties on **one** element, which is what the `style` prop is for.
  `deriveBrandRoles` is already exported (`theme.ts:149`), so no `lib` change is needed:
  ```tsx
  import { useTheme } from "next-themes";
  import { deriveBrandRoles } from "~/lib/branding/theme";
  ...
  const { resolvedTheme } = useTheme();
  const roles = deriveBrandRoles(formToBrandingPatch(values));
  const previewVars = resolvedTheme === "dark" ? roles.dark : roles.light;
  ...
  <div
    data-brand-preview=""
    style={previewVars as CSSProperties}   // keys are all `--role-*` custom properties
    className="flex flex-col gap-3 rounded-panel border border-border bg-surface p-4"
  >
  ```
  This deletes `scopedPreviewCss`, the two `.replace` calls, the `<style>` element and the
  `eslint-disable`. Scoping becomes structural (the vars live on the box) rather than textual, and it
  cannot leak. React sets `--`-prefixed keys as custom properties natively.
  Note the same `react/no-danger` suppression exists in `components/ui/brand-theme-style.tsx:21` —
  that one is **correct to keep**: it genuinely must reach both `:root` and `.dark`, which an inline
  style cannot, and it is server-rendered to avoid a palette flash.
- Cross-area: none (uses an already-exported helper).

### [P2] `LiveProvider` subscribes before the welcome frame, contradicting the comment that says it does not (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/_context/live-context.tsx:99-103`
- Code:
  ```ts
  // …a component that renders before permissions are known does not send a subscribe that will be denied
  const permitted =
  	topic === null ||
  	allowedTopicKinds.length === 0 ||
  	allowedTopicKinds.includes(topicKind(topic));
  ```
- Problem: `allowedTopicKinds` starts as `[]` (line 40) and is only populated when the `welcome` frame
  arrives a round trip after the socket opens. `allowedTopicKinds.length === 0` evaluates to
  `permitted: true`, so every mounted topic **does** subscribe during exactly the window the comment
  says it avoids. The comment describes the opposite of the code.
- Failure scenario / cost: every screen that leases a topic sends a subscribe that may be denied,
  then re-runs the effect once `welcome` lands — a wasted round trip per topic on every page load,
  and a spurious `onDenied` callback that consumers must tolerate. Low runtime cost; the real cost is
  that the next reader trusts the comment.
- Fix: decide which behaviour is wanted and make one of them true. If the fail-open is deliberate
  (it protects against a server that never sends `welcome`), reword the comment to say so. If the
  comment is the intent, gate on an explicit "welcome received" flag rather than on emptiness:
  `const [welcomed, setWelcomed] = useState(false)` set in `onWelcome`, and
  `const permitted = topic === null || (welcomed && allowedTopicKinds.includes(topicKind(topic)))`.
  Note this also removes a live bug in the current form: a session whose welcome frame legitimately
  lists **zero** allowed kinds is treated as permitted for everything.
- Cross-area: none.

### [P2] `useLiveTopic` mutates a ref during render (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/_context/live-context.tsx:95-96`
- Code:
  ```ts
  const [handlerBox] = useState(() => ({ current: handlers }));
  handlerBox.current = handlers;
  ```
- Problem: assigning to a ref-like box in the render body is a side effect during render. React
  documents this as unsafe: a render that is discarded (concurrent interrupt, offscreen/Activity,
  StrictMode double-render) has already overwritten the box, so a subsequently-resumed tree can
  invoke handlers closed over an abandoned render's props. The motivation given in the doc comment
  (lines 82-85 — avoid resubscribing on every render because callers build handlers inline) is
  sound; the mechanism is not.
- Failure scenario / cost: no reproduction today — the app does not use `<Activity>` and the handlers
  are effectively pure dispatchers into `setState`. It is a latent hazard that will surface as a
  "stale snapshot applied" bug the day a live screen is put behind a transition.
- Fix: move the assignment into a layout effect, which is the standard latest-ref pattern:
  ```ts
  const handlerBox = useRef(handlers);
  useLayoutEffect(() => {
  	handlerBox.current = handlers;
  });
  ```
  The subscribe effect below already reads only `handlerBox.current`, so nothing else changes.
- Cross-area: none.

### [P2] `useRevokeApiKey` omits `organizationId`, breaking the invariant its own module header states (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/_hooks/use-api-key-queries.ts:80`
- Code:
  ```ts
  const result = await apiKey.delete({ keyId });
  ```
- Problem: the file header (lines 15-18) is emphatic: "`organizationId` is therefore passed
  **EXPLICITLY on every call**, and its absence is not a harmless default: `/api-key/list` without it
  returns the caller's USER-owned keys instead of the organization's… `/api-key/create` without it
  rejects with a 400." `useApiKeys` and `useCreateApiKey` both comply. `useRevokeApiKey` — the one
  destructive operation of the three — does not, and the invariant is stated but not enforced by any
  type.
- Failure scenario / cost: depends on how `@better-auth/api-key`'s delete resolves the key's owner
  when the reference is absent. At best a no-op or a 4xx surfaced as a toast; at worst the same
  user-scope fallback the header warns about, meaning a revoke that appears to succeed while the
  organization key stays live. Either way the module's stated rule is silently violated on its
  highest-consequence call.
- Fix: pass it, as the sibling hooks do — `apiKey.delete({ keyId, organizationId: organizationId as string })` —
  and confirm against the `@better-auth/api-key` delete handler which reference it uses. If the
  plugin genuinely does not accept it on delete, replace the header's "every call" claim with the
  actual rule so the next reader is not misled.
- Cross-area: none.

### [P2] `directory-dialog` shadows the global `setTimeout`, which the sibling dialog explicitly warns against (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/dial-plan/_components/directory-dialog.tsx:80`
- Code:
  ```ts
  const [timeout, setTimeout] = useState<DestinationValue>(initial);
  ```
- Problem: `ivr-menu-dialog.tsx:71-73` names this exact hazard and avoids it:
  ```ts
  // Named `timeoutDestination`, not `timeout` — a local called `setTimeout` shadows the global one,
  const [timeoutDestination, setTimeoutDestination] = useState<DestinationValue>(initialTimeout);
  ```
  Four other dialogs (`queue-dialog`, `park-lot-dialog`, `ring-group-dialog`, plus the IVR one) follow
  the convention; `directory-dialog` is the sole exception. There is no call to the global
  `setTimeout` in this file today, so it is currently latent — but the whole point of the sibling's
  comment is that the _next_ person to add a debounce or a copy-confirmation here gets a
  `DestinationValue` setter instead of a timer, with a type error at best and a silently dead timer
  at worst.
- Failure scenario / cost: latent. Costs nothing today; costs a confusing debugging session the first
  time a timer is added to this dialog.
- Fix: rename to `timeoutDestination` / `setTimeoutDestination`, matching the other five dialogs.
  Mechanical — the identifier appears at lines 80, 90, 100, 125, 241, 243.
- Cross-area: none.

### [P2] Provisioning-URL copy: unhandled clipboard rejection and an uncancelled timer (confidence: high)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/devices/_components/provisioning-url-panel.tsx:82-89`
- Code:
  ```ts
  void navigator.clipboard?.writeText(url).then(() => {
  	setCopied(true);
  	setTimeout(() => setCopied(false), 2000);
  });
  ```
- Problem: two things. (1) No `.catch`. `writeText` rejects in a non-secure context, when the
  document is not focused, or when the permission is denied — producing an unhandled promise
  rejection and, more importantly, **no feedback at all**: the button does not change, so the
  administrator believes they have copied a credential they have not. This surface is the _only_
  place the provisioning token ever exists (lines 13-16), so a silent copy failure followed by
  dismissing the panel destroys the credential. The sibling `webhook-secret-dialog.tsx:64-67` handles
  this correctly with `.catch(() => toast.error("Could not copy. Select the key and copy it."))`.
  (2) The 2s timer is never cleared, so dismissing the panel inside two seconds sets state on an
  unmounted component.
- Failure scenario / cost: an admin on an internal HTTP deployment (very plausible for a PBX
  provisioning workflow) clicks Copy, sees nothing happen, clicks "I have saved it", and the token is
  gone forever — the device must be re-created or its token rotated.
- Fix: mirror the webhook dialog and clear the timer:
  ```ts
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  ...
  onClick={() => {
      void navigator.clipboard
          ?.writeText(url)
          .then(() => {
              setCopied(true);
              timer.current = setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => toast.error("Could not copy. Select the URL and copy it manually."));
  }}
  ```
  The `select-all` class on the `<code>` already makes the manual fallback a single click, so the
  error message points at something that actually works.
- Cross-area: none.

### [P2] `SoftphoneProvider`'s context value is rebuilt on every render (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/_context/softphone-context.tsx:195-215`
- Code:
  ```ts
  const value: SoftphoneContextValue = {
      available: resolved !== null,
      ...
  };
  ```
- Problem: every other context in this tree memoises (`live-context.tsx:58-61` uses `useMemo` and
  documents why; `session-context.tsx` builds its value from a prop). This one constructs a fresh
  object on each render, so every `useSoftphone()` consumer re-renders whenever the provider does —
  and the provider re-renders on every SIP event dispatched into `softphoneReducer` and on every
  credentials-query state change. The individual callbacks are all correctly `useCallback`'d, which
  makes the missing memo on the wrapper look like an oversight rather than a decision.
  (`children` is a stable element, so the rest of the app tree is not affected — the blast radius is
  the widget, the dialer and the `/softphone` screen.)
- Failure scenario / cost: during an active call the reducer dispatches per SIP event and the dialer
  additionally ticks once a second; each of those re-renders the full dialer keypad tree. Small but
  entirely avoidable, and it is the one screen where responsiveness is most visible.
- Fix: wrap in `useMemo` with the reducer state, the resolved credentials, the query flags and the
  memoised callbacks as deps — all of them are already stable references except `state`,
  `credentialsQuery.data/isPending/error` and `resolved`.
- Cross-area: none.

### [P2] Follow-me validation errors are keyed by array index and are not re-keyed on reorder or removal (confidence: medium)

- Where: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/web/app/(app)/extensions/_components/follow-me-field.tsx:154-156` (keys built at line 205)
- Code:
  ```tsx
  onMove={(delta) => setTargets(moveFollowMeTarget(targets, index, delta))}
  onRemove={() => setTargets(targets.filter((_, at) => at !== index))}
  // and:  const key = (field: string): string => `targets.${index}.${field}`;
  ```
- Problem: the `errors` map is keyed `targets.<index>.<field>`, but `onMove` and `onRemove` mutate the
  array without touching the error map. The messages stay pinned to positions, not to rungs. The
  `key={index}` on the row is correct and justified (the rows are fully controlled and hold no state)
  — the defect is specifically that the _error_ keys are positional and the positions move.
- Failure scenario / cost: user submits, gets "Enter a valid destination" on rung 3, then deletes
  rung 1 to simplify the ladder. The error now sits on what was rung 4 — a field that is perfectly
  valid — while the actually-invalid rung shows nothing. The user cannot find the field blocking
  their save.
- Fix: clear the follow-me errors whenever the ladder's shape changes. The simplest correct version
  is for `FollowMeField` to accept an `onStructureChange` callback that the parent dialog uses to
  drop `targets.*` keys from its `localErrors`, called from both `onMove` and `onRemove`. Re-running
  validation on change would also work but is noisier while typing.
- Cross-area: none.
