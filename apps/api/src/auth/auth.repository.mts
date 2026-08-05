import type { Auth, OrganizationMembership } from "@optimiq-voice/auth";

/**
 * Reads over the better-auth tables.
 *
 * Every query goes through better-auth's own database adapter (`auth.$context.adapter`) rather
 * than a Drizzle handle, for two reasons:
 *
 * 1. `apps/api` still pins `drizzle-orm@0.45.2` for the legacy telephony schema while
 *    `@optimiq-voice/{auth,db}` are on `1.0.0-rc.4`. Building queries here with the app's
 *    Drizzle would apply 0.45 operators to 1.0 table objects.
 * 2. The adapter speaks better-auth *model* names, so this file cannot drift from the schema
 *    better-auth actually reads and writes.
 *
 * These are platform-global (non org-scoped) tables, so no tenant transaction is involved; RLS
 * arrives with the telephony tables in identity-removal Step 5.
 */

type AuthDatabaseAdapter = Awaited<Auth["$context"]>["adapter"];

export interface MemberRecord {
	readonly id: string;
	readonly organizationId: string;
	readonly userId: string;
	readonly role: string;
	readonly createdAt: Date;
}

export interface OrganizationRecord {
	readonly id: string;
	readonly name: string;
	readonly slug: string | null;
	readonly logo: string | null;
	readonly createdAt: Date;
}

export interface UserRecord {
	readonly id: string;
	readonly email: string;
	readonly name: string;
}

export interface OrganizationMemberSummary {
	readonly id: string;
	readonly userId: string;
	readonly email: string;
	readonly name: string;
	readonly role: string;
	readonly createdAt: Date;
}

export interface AuthRepository {
	readonly findMembership: (
		userId: string,
		organizationId?: string,
	) => Promise<OrganizationMembership | null>;
	readonly listOrganizationsForUser: (
		userId: string,
	) => Promise<readonly (OrganizationRecord & { readonly role: string })[]>;
	readonly findOrganizationById: (organizationId: string) => Promise<OrganizationRecord | null>;
	readonly listMembers: (organizationId: string) => Promise<readonly OrganizationMemberSummary[]>;
}

/** Raised when a repository method runs before the better-auth context has been created. */
export class AuthRepositoryNotReadyFailure extends Error {
	readonly _tag = "AuthRepositoryNotReadyFailure" as const;

	constructor() {
		super("The better-auth context is not available yet; the auth slice has not finished boot.");
		this.name = "AuthRepositoryNotReadyFailure";
	}
}

/**
 * `createAuth()` needs the repository (it stamps `session.activeOrganizationId` from a
 * `session.create.before` hook) and the repository needs the instance `createAuth()` returns.
 * The cycle is broken by resolving the adapter lazily: `resolveAuth` is only ever called from
 * inside a request or hook, long after boot has completed.
 */
export function createAuthRepository(resolveAuth: () => Auth | undefined): AuthRepository {
	const adapter = async (): Promise<AuthDatabaseAdapter> => {
		const auth = resolveAuth();
		if (!auth) {
			throw new AuthRepositoryNotReadyFailure();
		}
		return (await auth.$context).adapter;
	};

	const findMembership = async (
		userId: string,
		organizationId?: string,
	): Promise<OrganizationMembership | null> => {
		const trimmedUserId = userId.trim();
		if (trimmedUserId.length === 0) {
			return null;
		}
		const db = await adapter();
		const requested = organizationId?.trim();

		if (requested) {
			const membership = await db.findOne<MemberRecord>({
				model: "member",
				where: [
					{ field: "userId", value: trimmedUserId },
					{ field: "organizationId", value: requested },
				],
			});
			return membership
				? { organizationId: membership.organizationId, role: membership.role }
				: null;
		}

		// No organization requested: fall back to the oldest membership, which is the one the
		// user created or was invited to first.
		const memberships = await db.findMany<MemberRecord>({
			model: "member",
			where: [{ field: "userId", value: trimmedUserId }],
			sortBy: { field: "createdAt", direction: "asc" },
			limit: 1,
		});
		const first = memberships[0];
		return first ? { organizationId: first.organizationId, role: first.role } : null;
	};

	const listOrganizationsForUser = async (
		userId: string,
	): Promise<readonly (OrganizationRecord & { readonly role: string })[]> => {
		const trimmedUserId = userId.trim();
		if (trimmedUserId.length === 0) {
			return [];
		}
		const db = await adapter();
		const memberships = await db.findMany<MemberRecord>({
			model: "member",
			where: [{ field: "userId", value: trimmedUserId }],
			sortBy: { field: "createdAt", direction: "asc" },
		});
		if (memberships.length === 0) {
			return [];
		}

		const roleByOrganizationId = new Map(
			memberships.map((membership) => [membership.organizationId, membership.role]),
		);
		const organizations = await db.findMany<OrganizationRecord>({
			model: "organization",
			where: [{ field: "id", operator: "in", value: [...roleByOrganizationId.keys()] }],
		});

		return organizations.map((organization) => ({
			...organization,
			role: roleByOrganizationId.get(organization.id) ?? "member",
		}));
	};

	const findOrganizationById = async (
		organizationId: string,
	): Promise<OrganizationRecord | null> => {
		const trimmed = organizationId.trim();
		if (trimmed.length === 0) {
			return null;
		}
		const db = await adapter();
		return await db.findOne<OrganizationRecord>({
			model: "organization",
			where: [{ field: "id", value: trimmed }],
		});
	};

	const listMembers = async (
		organizationId: string,
	): Promise<readonly OrganizationMemberSummary[]> => {
		const trimmed = organizationId.trim();
		if (trimmed.length === 0) {
			return [];
		}
		const db = await adapter();
		const members = await db.findMany<MemberRecord>({
			model: "member",
			where: [{ field: "organizationId", value: trimmed }],
			sortBy: { field: "createdAt", direction: "asc" },
		});
		if (members.length === 0) {
			return [];
		}

		const users = await db.findMany<UserRecord>({
			model: "user",
			where: [{ field: "id", operator: "in", value: members.map((candidate) => candidate.userId) }],
		});
		const userById = new Map(users.map((candidate) => [candidate.id, candidate]));

		return members.map((candidate) => {
			const user = userById.get(candidate.userId);
			return {
				id: candidate.id,
				userId: candidate.userId,
				email: user?.email ?? "",
				name: user?.name ?? "",
				role: candidate.role,
				createdAt: candidate.createdAt,
			};
		});
	};

	return { findMembership, listOrganizationsForUser, findOrganizationById, listMembers };
}
