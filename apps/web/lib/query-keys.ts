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
} as const;
