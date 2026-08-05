import { describe, expect, it } from "bun:test";
import {
	type AppSession,
	createSessionOrganizationHook,
	getActiveOrganizationId,
	isImpersonatedSession,
	MissingActiveOrganizationError,
	type OrganizationMembership,
	requireActiveOrganizationId,
	requireSession,
	resolveSessionOrganizationContext,
	type SessionOrganizationRepository,
	UnauthenticatedSessionError,
} from "./session";

const USER_ID = "018f2b2a-0000-7000-8000-0000000000aa";
const ORGANIZATION_ID = "018f2b2a-0000-7000-8000-0000000000bb";
const OTHER_ORGANIZATION_ID = "018f2b2a-0000-7000-8000-0000000000cc";

function makeSession(overrides: Partial<AppSession["session"]> = {}): AppSession {
	return {
		session: {
			id: "018f2b2a-0000-7000-8000-0000000000dd",
			userId: USER_ID,
			token: "token",
			expiresAt: new Date("2030-01-01T00:00:00.000Z"),
			activeOrganizationId: ORGANIZATION_ID,
			...overrides,
		},
		user: {
			id: USER_ID,
			email: "operator@optimiq.example",
			name: "Operator",
			emailVerified: true,
		},
	};
}

function makeRepository(
	memberships: readonly OrganizationMembership[],
): SessionOrganizationRepository & {
	calls: { userId: string; organizationId?: string }[];
} {
	const calls: { userId: string; organizationId?: string }[] = [];
	return {
		calls,
		findMembership: (userId, organizationId) => {
			calls.push(organizationId === undefined ? { userId } : { userId, organizationId });
			const match = organizationId
				? memberships.find((membership) => membership.organizationId === organizationId)
				: memberships[0];
			return Promise.resolve(match ?? null);
		},
	};
}

describe("getActiveOrganizationId", () => {
	it("returns the tenant claim", () => {
		expect(getActiveOrganizationId(makeSession())).toBe(ORGANIZATION_ID);
	});

	it.each([[null], [undefined], [""], ["   "]])(
		"treats a blank claim (%p) as absent",
		(activeOrganizationId) => {
			expect(getActiveOrganizationId(makeSession({ activeOrganizationId }))).toBeUndefined();
		},
	);

	it("returns undefined for no session at all", () => {
		expect(getActiveOrganizationId(null)).toBeUndefined();
		expect(getActiveOrganizationId(undefined)).toBeUndefined();
	});
});

describe("requireActiveOrganizationId", () => {
	it("returns the tenant id when one is selected", () => {
		expect(requireActiveOrganizationId(makeSession())).toBe(ORGANIZATION_ID);
	});

	it("fails loudly rather than running unscoped when no organization is selected", () => {
		expect(() => requireActiveOrganizationId(makeSession({ activeOrganizationId: null }))).toThrow(
			MissingActiveOrganizationError,
		);
	});

	it("reports which user the failure belongs to", () => {
		try {
			requireActiveOrganizationId(makeSession({ activeOrganizationId: "  " }));
			throw new Error("expected requireActiveOrganizationId to throw");
		} catch (cause) {
			expect(cause).toBeInstanceOf(MissingActiveOrganizationError);
			expect((cause as MissingActiveOrganizationError).userId).toBe(USER_ID);
		}
	});

	it.each([[null], [undefined]])("rejects a missing session (%p)", (session) => {
		expect(() => requireActiveOrganizationId(session)).toThrow(UnauthenticatedSessionError);
	});
});

describe("requireSession", () => {
	it("passes an authenticated session through", () => {
		const session = makeSession();
		expect(requireSession(session)).toBe(session);
	});

	it("rejects an anonymous caller", () => {
		expect(() => requireSession(null)).toThrow(UnauthenticatedSessionError);
	});
});

describe("isImpersonatedSession", () => {
	it("detects an operator acting as another user", () => {
		expect(isImpersonatedSession(makeSession({ impersonatedBy: "018f2b2a-1" }))).toBe(true);
	});

	it("is false for a normal session", () => {
		expect(isImpersonatedSession(makeSession())).toBe(false);
		expect(isImpersonatedSession(makeSession({ impersonatedBy: "  " }))).toBe(false);
		expect(isImpersonatedSession(null)).toBe(false);
	});
});

describe("resolveSessionOrganizationContext", () => {
	it("falls back to the user's default membership when nothing is requested", async () => {
		const repository = makeRepository([{ organizationId: ORGANIZATION_ID, role: "owner" }]);

		await expect(
			resolveSessionOrganizationContext({ userId: USER_ID, repository }),
		).resolves.toEqual({
			activeOrganizationId: ORGANIZATION_ID,
			activeOrganizationRole: "owner",
		});
		expect(repository.calls).toEqual([{ userId: USER_ID }]);
	});

	it("re-verifies a requested organization against membership instead of trusting it", async () => {
		const repository = makeRepository([{ organizationId: ORGANIZATION_ID, role: "member" }]);

		await expect(
			resolveSessionOrganizationContext({
				userId: USER_ID,
				activeOrganizationId: OTHER_ORGANIZATION_ID,
				repository,
			}),
		).resolves.toEqual({});
		expect(repository.calls).toEqual([{ userId: USER_ID, organizationId: OTHER_ORGANIZATION_ID }]);
	});

	it("returns no claim when the user belongs to no organization", async () => {
		await expect(
			resolveSessionOrganizationContext({
				userId: USER_ID,
				repository: makeRepository([]),
			}),
		).resolves.toEqual({});
	});

	it("ignores a blank requested organization id", async () => {
		const repository = makeRepository([{ organizationId: ORGANIZATION_ID, role: "admin" }]);

		await resolveSessionOrganizationContext({
			userId: USER_ID,
			activeOrganizationId: "   ",
			repository,
		});

		expect(repository.calls).toEqual([{ userId: USER_ID }]);
	});
});

describe("createSessionOrganizationHook", () => {
	it("stamps the tenant claim onto a new session row", async () => {
		const hook = createSessionOrganizationHook(
			makeRepository([{ organizationId: ORGANIZATION_ID, role: "owner" }]),
		);

		await expect(hook({ userId: USER_ID })).resolves.toEqual({
			data: { activeOrganizationId: ORGANIZATION_ID },
		});
	});

	it("writes no claim when the user has no membership", async () => {
		const hook = createSessionOrganizationHook(makeRepository([]));

		await expect(hook({ userId: USER_ID })).resolves.toEqual({ data: {} });
	});

	it("drops a stale claim for an organization the user was removed from", async () => {
		const hook = createSessionOrganizationHook(
			makeRepository([{ organizationId: ORGANIZATION_ID, role: "member" }]),
		);

		await expect(
			hook({ userId: USER_ID, activeOrganizationId: OTHER_ORGANIZATION_ID }),
		).resolves.toEqual({ data: {} });
	});
});
