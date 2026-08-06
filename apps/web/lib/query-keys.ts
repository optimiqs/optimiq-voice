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
	 * What each feature-code action's `params` accepts.
	 *
	 * NOT scoped by organization, unlike everything else here: it describes the schema, not the
	 * tenant, so the answer is the same for every organization on the deployment and re-fetching it
	 * on an org switch would be a request that can only return what is already cached.
	 */
	featureCodeParamFields: () => ["pbx", "feature-code-param-fields"] as const,
	/** The compile/simulate surface, which reads the whole configuration rather than one table. */
	routingCompile: (organizationId: string) =>
		["organizations", organizationId, "pbx", "routing", "compile"] as const,

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
} as const;
