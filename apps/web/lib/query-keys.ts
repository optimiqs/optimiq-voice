/**
 * Every React Query key in one place.
 *
 * Caches are held with `staleTime: Infinity` and invalidated by explicit events rather than by
 * polling (see `query-client.ts`), so a key is a contract between the code that reads it and the
 * code that invalidates it. Scattering inline arrays is how those two drift apart; scoping by
 * organization is how a cache entry stops leaking across an org switch.
 */
export const queryKeys = {
	session: () => ["session"] as const,
	organizations: () => ["organizations"] as const,
	organization: (organizationId: string) => ["organizations", organizationId] as const,
	members: (organizationId: string) => ["organizations", organizationId, "members"] as const,
	invitations: (organizationId: string) =>
		["organizations", organizationId, "invitations"] as const,
	apiKeys: (organizationId: string) => ["organizations", organizationId, "api-keys"] as const,

	/**
	 * PBX resources, scoped by organization for the same reason members are: a cached page of
	 * extensions belongs to the tenant it was fetched for, and an org switch must not hand it to
	 * the next one.
	 *
	 * The three levels are a deliberate hierarchy — `pbxResource` is the invalidation handle a
	 * mutation reaches for, and it takes every list page and every single-row read with it. A
	 * mutation that invalidated only its own page would leave the other pages, and the row the
	 * detail view is showing, stale.
	 */
	pbx: (organizationId: string) => ["organizations", organizationId, "pbx"] as const,
	pbxResource: (organizationId: string, resource: string) =>
		["organizations", organizationId, "pbx", resource] as const,
	pbxList: (organizationId: string, resource: string, query: Readonly<Record<string, unknown>>) =>
		["organizations", organizationId, "pbx", resource, "list", query] as const,
	pbxItem: (organizationId: string, resource: string, id: string) =>
		["organizations", organizationId, "pbx", resource, "item", id] as const,
	pbxChildren: (organizationId: string, resource: string, parentId: string, child: string) =>
		["organizations", organizationId, "pbx", resource, "item", parentId, child] as const,
	/**
	 * The messages in one mailbox.
	 *
	 * Filed UNDER `pbx/voicemail-boxes/item/<id>` on purpose: the coarse `pbxResource` invalidation
	 * that every mailbox mutation already fires sweeps the message lists too, so deleting a box
	 * cannot leave its messages cached behind it. The `folder`/`page` query is the last segment for
	 * the reason every list key here has one — two folders are two answers and must never share an
	 * entry.
	 */
	voicemailMessagesFor: (organizationId: string, boxId: string) =>
		["organizations", organizationId, "pbx", "voicemail-boxes", "item", boxId, "messages"] as const,
	voicemailMessages: (
		organizationId: string,
		boxId: string,
		query: Readonly<Record<string, unknown>>,
	) =>
		[
			"organizations",
			organizationId,
			"pbx",
			"voicemail-boxes",
			"item",
			boxId,
			"messages",
			query,
		] as const,

	/**
	 * A mailbox's GREETINGS, filed under the mailbox exactly as its messages are.
	 *
	 * The coarse `pbxResource(org, "voicemail-boxes")` invalidation every mailbox mutation already
	 * fires sweeps these too, so deleting a box cannot leave its greetings cached behind it — and,
	 * more usefully, an upload invalidates the box list as well, because activating a greeting is a
	 * routing change and the compile banner has to notice.
	 */
	voicemailGreetings: (organizationId: string, boxId: string) =>
		[
			"organizations",
			organizationId,
			"pbx",
			"voicemail-boxes",
			"item",
			boxId,
			"greetings",
		] as const,

	/**
	 * The audio files under one hold-music class.
	 *
	 * Filed under `pbx/moh-classes/item/<id>` so a class mutation sweeps its files, and NOT under
	 * `pbx/prompts` even though the rows live in the `prompt` table. The two lists answer different
	 * questions — "what does this class play" and "what can I point an IVR at" — and a file upload
	 * must invalidate the first without evicting the second, which is a page a user may be reading.
	 */
	mohClassFiles: (organizationId: string, mohClassId: string) =>
		["organizations", organizationId, "pbx", "moh-classes", "item", mohClassId, "files"] as const,

	/**
	 * The prompt library list, which takes a `kind` filter the generic list machinery has no
	 * vocabulary for. Filed under `pbx/prompts`, so the generic mutation invalidation still sweeps it.
	 */
	promptList: (organizationId: string, query: Readonly<Record<string, unknown>>) =>
		["organizations", organizationId, "pbx", "prompts", "list", query] as const,

	/**
	 * What each feature-code action's `params` accepts.
	 *
	 * NOT scoped by organization, unlike everything else here: it describes the schema, not the
	 * tenant, so the answer is the same for every organization on the deployment and re-fetching it
	 * on an org switch would be a request that can only return what is already cached.
	 */
	featureCodeParamFields: () => ["pbx", "feature-code-param-fields"] as const,

	/**
	 * The organization settings cascade.
	 *
	 * `orgSettingsCatalog` is NOT organization-scoped, on exactly the same terms as
	 * `featureCodeParamFields`: it describes what settings exist and what type each is, which is a
	 * property of the deployment's code and identical for every tenant.
	 *
	 * `orgSettingsCategory` IS scoped, because the resolved values are the tenant's. It sits under
	 * `pbx` so an org switch and the coarse PBX sweeps both reach it — `org_setting` is a routing
	 * input (`affectsRouting("org_setting")` is true), so a settings save recompiles the artifact
	 * and the compile view has to be invalidated with it.
	 *
	 * The category is the last SEGMENT rather than baked into a key per category, and that is what
	 * keeps `notifications` and `routing` in separate cache entries while a single screen's save can
	 * still invalidate only its own. Two screens read this today; nothing about the key changes when
	 * a third category is catalogued.
	 */
	orgSettingsCatalog: () => ["pbx", "org-settings-catalog"] as const,
	orgSettingsCategory: (organizationId: string, category: string) =>
		["organizations", organizationId, "pbx", "org-settings", category] as const,
	/** The compile/simulate surface, which reads the whole configuration rather than one table. */
	routingCompile: (organizationId: string) =>
		["organizations", organizationId, "pbx", "routing", "compile"] as const,

	/**
	 * Which vendors this deployment can provision, and whether it is configured to provision at all.
	 *
	 * Organization-scoped even though the answer is deployment-wide, for the reason `carrierStatus`
	 * is: it is only ever read inside an organization's shell, and scoping it keeps one rule — every
	 * key under `organizations/<id>` dies on an org switch — rather than one rule and an exception.
	 *
	 * NOT filed under `pbx/devices`: a device mutation must not invalidate it, because no device edit
	 * can change which templates the API has or which environment variables an operator has set.
	 */
	provisioningCatalog: (organizationId: string) =>
		["organizations", organizationId, "provisioning", "catalog"] as const,

	/**
	 * The carrier surface.
	 *
	 * `carrierStatus` is organization-scoped even though the answer is platform-wide, because it is
	 * only ever read inside an organization's shell and scoping it keeps one rule — every key under
	 * `organizations/<id>` dies on an org switch — rather than one rule and an exception.
	 *
	 * `carrierNumberSearch` sits UNDER `pbx/phone-numbers`, so the coarse `pbxResource`
	 * invalidation a successful order fires sweeps the search results too. That is what makes a
	 * number disappear from the "available" list the moment it is bought, without the panel having
	 * to know an order happened.
	 */
	carrierStatus: (organizationId: string) =>
		["organizations", organizationId, "carrier", "status"] as const,
	carrierNumberSearch: (organizationId: string, query: Readonly<Record<string, unknown>>) =>
		["organizations", organizationId, "pbx", "phone-numbers", "carrier-search", query] as const,

	/**
	 * The reporting area, scoped by organization for the same reason everything else is.
	 *
	 * Unlike `pbx`, there is no mutation that invalidates these — `call_legs` is an append-only
	 * ledger the UI cannot write to, so the subtree handle exists for the ORGANIZATION SWITCH and
	 * for a manual refresh, not for a write path. A cached page of another tenant's call history is
	 * the one thing an org switch must never leave behind.
	 */
	cdr: (organizationId: string) => ["organizations", organizationId, "cdr"] as const,
	cdrList: (organizationId: string, query: Readonly<Record<string, unknown>>) =>
		["organizations", organizationId, "cdr", "legs", query] as const,
	/** One call's legs, keyed by call id — what an expanded row reads. */
	cdrCall: (organizationId: string, callId: string) =>
		["organizations", organizationId, "cdr", "call", callId] as const,
	recordings: (organizationId: string) =>
		["organizations", organizationId, "cdr", "recordings"] as const,
	recordingList: (organizationId: string, query: Readonly<Record<string, unknown>>) =>
		["organizations", organizationId, "cdr", "recordings", "list", query] as const,

	/**
	 * The two append-only ledgers.
	 *
	 * Organization-scoped like everything else, and for the sharpest version of the reason: a cached
	 * page of another tenant's change history or attack log is the single worst thing an org switch
	 * could leave behind.
	 *
	 * NOT under `pbx`, even though `sipAuthEvents` sits next to the ACL screen that IS a PBX
	 * resource. The coarse `pbxResource` sweep every mutation fires would otherwise evict these on
	 * every unrelated write, and there is nothing to evict: no mutation in this app can change a row
	 * in either table — both are append-only by DATABASE PRIVILEGE, not by convention. Writing an
	 * ACL rule does append an audit entry, and the screen does not pretend otherwise; the ledger is
	 * refetched when somebody asks it to be, which is what a ledger with no total and a moving window
	 * can honestly offer.
	 *
	 * The whole query — window, filters, limit and cursor — is the last segment, because two windows
	 * are two answers and must never share an entry.
	 */
	auditLog: (organizationId: string) => ["organizations", organizationId, "audit-log"] as const,
	auditLogList: (organizationId: string, query: Readonly<Record<string, unknown>>) =>
		["organizations", organizationId, "audit-log", "list", query] as const,
	sipAuthEvents: (organizationId: string) =>
		["organizations", organizationId, "sip-auth-events"] as const,
	sipAuthEventList: (organizationId: string, query: Readonly<Record<string, unknown>>) =>
		["organizations", organizationId, "sip-auth-events", "list", query] as const,

	/**
	 * Agent availability.
	 *
	 * Availability itself is LIVE state and is not in this cache — it arrives over the socket and
	 * lives in component state, because a KV bucket's contents have no staleness for `staleTime` to
	 * be a question about (see `_hooks/use-live-queries.ts`). What IS cached is the answer to "which
	 * agent seat is this user?", which is a database row, changes when an administrator links one,
	 * and is read by the console strip on every page that shows it.
	 *
	 * Filed under `pbx/queue-agents` on purpose: a mutation to the agents resource already
	 * invalidates that subtree, so unlinking a user takes this with it without the agent dialog
	 * having to know the console exists.
	 */
	myAgentSession: (organizationId: string) =>
		["organizations", organizationId, "pbx", "queue-agents", "session", "me"] as const,
} as const;
