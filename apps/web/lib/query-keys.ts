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
	/** The compile/simulate surface, which reads the whole configuration rather than one table. */
	routingCompile: (organizationId: string) =>
		["organizations", organizationId, "pbx", "routing", "compile"] as const,
} as const;
