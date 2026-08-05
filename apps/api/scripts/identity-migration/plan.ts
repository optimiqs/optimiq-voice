/**
 * The pure half of the identity-removal **Step 2** data migration.
 *
 * Everything here is I/O free so the mapping rules — which are the part that can silently corrupt
 * a tenant boundary — can be asserted by `test/auth/identityMigrationPlan.test.ts` without a
 * database, a cloak key or a running server. `../migrate-identity-to-organizations.ts` is the
 * adapter: it reads `fnidentity`, applies these functions and writes the base database.
 *
 * ## What the legacy model actually is (verified against `packages/identity/src/db/schema.ts`)
 *
 * | `fnidentity`        | base database                                                          |
 * | ------------------- | ---------------------------------------------------------------------- |
 * | `users`             | `user` + `account` (`providerId: "credential"`) + `legacy_user_account` |
 * | `workspaces`        | `organization` + `legacy_workspace_organization`                       |
 * | `workspaces.ownerRef` | `member` with role `owner`                                           |
 * | `workspace_members` (ACTIVE)  | `member`                                                     |
 * | `workspace_members` (PENDING) | `invitation` (status `pending`)                              |
 * | `api_keys`          | `api_key` with `reference_id = organization.id`                        |
 * | `verification_codes` | **not carried** — short-lived, and the flow that produced them dies   |
 *
 * ## The correction to the plan's Step 2 item 1
 *
 * The plan says users move over "with the bcrypt hash under `providerId: "credential"`".
 * **There is no bcrypt hash.** `packages/identity` stores the password *reversibly*: `db.ts`
 * `encrypt()`s it with `@47ng/cloak` on write (`:468`, `:522`, `:540`) and `decrypt()`s it on read
 * (`:255`), and `createExchangeCredentials.ts:28` compares the decrypted value to the submitted
 * one with `!==` — a plaintext comparison. So the migration must decrypt and then *hash* with
 * better-auth's own hasher (scrypt, via `hashPassword` from `better-auth/crypto`). That is what
 * makes the Step 2 gate — "every existing user can sign in with their existing password" —
 * reachable at all; a straight column copy would have produced accounts nobody could log into.
 */

/** `workspace_members.role` / `api_keys.role` — the legacy `role` pgEnum. */
export const LEGACY_ROLES = [
	"USER",
	"WORKSPACE_ADMIN",
	"WORKSPACE_OWNER",
	"WORKSPACE_MEMBER",
] as const;
export type LegacyRole = (typeof LEGACY_ROLES)[number];

/** `workspace_members.status` — the legacy `workspace_member_status` pgEnum. */
export const LEGACY_MEMBER_STATUSES = ["PENDING", "ACTIVE"] as const;
export type LegacyMemberStatus = (typeof LEGACY_MEMBER_STATUSES)[number];

/**
 * better-auth membership roles. Only the three built-ins are produced here: the legacy enum has
 * no notion of `manager` / `agent` / `user`, so inventing one would be a privilege *guess*. An
 * operator re-grades members afterwards through `/api/auth/organization/update-member-role`,
 * which accepts all five ids since `packages/auth/src/access-control.ts` landed.
 */
export type MembershipRole = "owner" | "admin" | "member";

export function mapLegacyRole(role: string): MembershipRole {
	switch (role) {
		case "WORKSPACE_OWNER":
			return "owner";
		case "WORKSPACE_ADMIN":
			return "admin";
		default:
			// `WORKSPACE_MEMBER`, `USER` and anything an older migration left behind: least
			// privilege. Never widen this default — an unknown legacy role must not become `admin`.
			return "member";
	}
}

export function isLegacyRole(value: string): value is LegacyRole {
	return (LEGACY_ROLES as readonly string[]).includes(value);
}

/** `US…` identified a person, `WO…` a workspace (`packages/common/src/identity/hasAccess.ts:15`). */
export type AccessKeyKind = "user" | "workspace" | "unknown";

export function classifyAccessKeyId(accessKeyId: string): AccessKeyKind {
	if (accessKeyId.startsWith("US")) return "user";
	if (accessKeyId.startsWith("WO")) return "workspace";
	return "unknown";
}

/**
 * `organization.slug` is `not null unique`, and the legacy `workspaces` table has no slug at all.
 * Derived from the name, collision-resolved against everything already taken, and never empty.
 */
export function deriveOrganizationSlug(name: string, taken: ReadonlySet<string>): string {
	const base =
		name
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 48) || "workspace";

	if (!taken.has(base)) {
		return base;
	}
	for (let suffix = 2; suffix < 1000; suffix += 1) {
		const candidate = `${base}-${String(suffix)}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
	throw new IdentityMigrationError(`could not derive a unique slug for organization "${name}"`);
}

/**
 * Emails are the join key when a target user already exists (a rerun, or someone who signed up
 * through better-auth before the cutover). better-auth stores and looks them up lowercased.
 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** Raised for any condition that must abort the whole transaction rather than skip a row. */
export class IdentityMigrationError extends Error {
	readonly _tag = "IdentityMigrationError" as const;

	constructor(message: string) {
		super(message);
		this.name = "IdentityMigrationError";
	}
}

export interface LegacyUserRow {
	readonly ref: string;
	readonly accessKeyId: string;
	readonly name: string;
	readonly email: string;
	readonly emailVerified: boolean;
	/** Cloak ciphertext, or plaintext for rows written before encryption was enabled. */
	readonly password: string;
	readonly avatar: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface LegacyWorkspaceRow {
	readonly ref: string;
	readonly accessKeyId: string;
	readonly name: string;
	readonly ownerRef: string;
	readonly createdAt: Date;
}

export interface LegacyWorkspaceMemberRow {
	readonly ref: string;
	readonly status: string;
	readonly role: string;
	readonly userRef: string;
	readonly workspaceRef: string;
	readonly createdAt: Date;
}

export interface LegacyApiKeyRow {
	readonly ref: string;
	readonly accessKeyId: string;
	/** Cloak ciphertext of the secret the client presents. */
	readonly accessKeySecret: string;
	readonly role: string;
	readonly workspaceRef: string;
	readonly createdAt: Date;
	readonly expiresAt: Date | null;
}

export interface LegacySnapshot {
	readonly users: readonly LegacyUserRow[];
	readonly workspaces: readonly LegacyWorkspaceRow[];
	readonly workspaceMembers: readonly LegacyWorkspaceMemberRow[];
	readonly apiKeys: readonly LegacyApiKeyRow[];
}

export interface MembershipPlanEntry {
	readonly workspaceRef: string;
	readonly userRef: string;
	readonly role: MembershipRole;
	/** ACTIVE rows become `member`; PENDING rows become an `invitation`. */
	readonly pending: boolean;
	readonly createdAt: Date;
}

export interface MembershipPlan {
	readonly entries: readonly MembershipPlanEntry[];
	readonly warnings: readonly string[];
}

/**
 * Collapses `workspaces.ownerRef` and `workspace_members` into one membership list.
 *
 * Two legacy quirks are handled here, and both are gate conditions:
 *
 * 1. **The owner is not always a member row.** `workspaces.ownerRef` is a foreign key on the
 *    workspace itself; `workspace_members` may or may not carry a matching row. The owner is
 *    therefore synthesised unconditionally and always wins the role contest, which is what makes
 *    the plan's gate "every workspace has exactly one owner" true by construction.
 * 2. **Duplicate / conflicting rows.** `workspace_members` is unique on `(user_ref, workspace_ref)`
 *    in the schema, but three legacy Prisma migrations preceded that constraint. The highest
 *    privilege wins and the collision is reported rather than silently resolved.
 */
export function planMemberships(
	workspaces: readonly LegacyWorkspaceRow[],
	members: readonly LegacyWorkspaceMemberRow[],
): MembershipPlan {
	const rank: Record<MembershipRole, number> = { owner: 3, admin: 2, member: 1 };
	const byKey = new Map<string, MembershipPlanEntry>();
	const warnings: string[] = [];
	const knownWorkspaceRefs = new Set(workspaces.map((workspace) => workspace.ref));

	const upsert = (entry: MembershipPlanEntry): void => {
		const key = `${entry.workspaceRef} ${entry.userRef}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, entry);
			return;
		}
		warnings.push(
			`duplicate membership for user ${entry.userRef} in workspace ${entry.workspaceRef}: ` +
				`${existing.role}${existing.pending ? " (pending)" : ""} vs ` +
				`${entry.role}${entry.pending ? " (pending)" : ""} — keeping the higher privilege`,
		);
		const winner = rank[entry.role] > rank[existing.role] ? entry : existing;
		byKey.set(key, {
			...winner,
			// An ACTIVE row anywhere means the person really is in the organization.
			pending: existing.pending && entry.pending,
			createdAt: existing.createdAt < entry.createdAt ? existing.createdAt : entry.createdAt,
		});
	};

	for (const workspace of workspaces) {
		upsert({
			workspaceRef: workspace.ref,
			userRef: workspace.ownerRef,
			role: "owner",
			pending: false,
			createdAt: workspace.createdAt,
		});
	}

	for (const member of members) {
		if (!knownWorkspaceRefs.has(member.workspaceRef)) {
			warnings.push(
				`membership ${member.ref} references unknown workspace ${member.workspaceRef} — skipped`,
			);
			continue;
		}
		upsert({
			workspaceRef: member.workspaceRef,
			userRef: member.userRef,
			role: mapLegacyRole(member.role),
			pending: member.status === "PENDING",
			createdAt: member.createdAt,
		});
	}

	return { entries: [...byKey.values()], warnings };
}

/**
 * Rows that cannot be mapped at all. These abort the run: a workspace with no resolvable owner or
 * a duplicate email is a data problem an operator must look at, not something to paper over.
 */
export function findBlockingDefects(snapshot: LegacySnapshot): readonly string[] {
	const defects: string[] = [];

	const userRefs = new Set(snapshot.users.map((user) => user.ref));
	const emails = new Map<string, string[]>();
	for (const user of snapshot.users) {
		const email = normalizeEmail(user.email);
		if (email.length === 0) {
			defects.push(`user ${user.ref} has no email`);
			continue;
		}
		emails.set(email, [...(emails.get(email) ?? []), user.ref]);
	}
	for (const [email, refs] of emails) {
		if (refs.length > 1) {
			defects.push(`email ${email} is shared by legacy users ${refs.join(", ")}`);
		}
	}

	for (const workspace of snapshot.workspaces) {
		if (!userRefs.has(workspace.ownerRef)) {
			defects.push(
				`workspace ${workspace.ref} names owner ${workspace.ownerRef}, who does not exist`,
			);
		}
		if (classifyAccessKeyId(workspace.accessKeyId) !== "workspace") {
			defects.push(
				`workspace ${workspace.ref} has access key ${workspace.accessKeyId}, which is not a WO… key`,
			);
		}
	}

	const workspaceRefs = new Set(snapshot.workspaces.map((workspace) => workspace.ref));
	for (const apiKey of snapshot.apiKeys) {
		if (!workspaceRefs.has(apiKey.workspaceRef)) {
			defects.push(`api key ${apiKey.ref} references unknown workspace ${apiKey.workspaceRef}`);
		}
	}

	return defects;
}

export interface MigrationCounts {
	usersCreated: number;
	usersLinked: number;
	passwordsMigrated: number;
	passwordsUnrecoverable: number;
	organizationsCreated: number;
	organizationsLinked: number;
	membersCreated: number;
	membersExisting: number;
	invitationsCreated: number;
	apiKeysCreated: number;
	apiKeysExisting: number;
}

export function emptyCounts(): MigrationCounts {
	return {
		usersCreated: 0,
		usersLinked: 0,
		passwordsMigrated: 0,
		passwordsUnrecoverable: 0,
		organizationsCreated: 0,
		organizationsLinked: 0,
		membersCreated: 0,
		membersExisting: 0,
		invitationsCreated: 0,
		apiKeysCreated: 0,
		apiKeysExisting: 0,
	};
}
