/**
 * Identity-removal **Step 2** — `fnidentity` → better-auth organizations.
 *
 *   # rehearse (writes nothing: the transaction is rolled back at the end)
 *   pnpm --filter @optimiq-voice/api migrate:identity -- --dry-run
 *
 *   # run it
 *   pnpm --filter @optimiq-voice/api migrate:identity
 *
 *   # prove it against synthetic legacy data on a machine with an empty fnidentity
 *   pnpm --filter @optimiq-voice/api migrate:identity -- --seed-fixtures
 *   pnpm --filter @optimiq-voice/api migrate:identity -- --drop-fixtures
 *
 * Environment (all optional, all defaulted for the local docker stack):
 *
 *   IDENTITY_DATABASE_URL / API_IDENTITY_DATABASE_URL  source, default …:5433/fnidentity
 *   DATABASE_URL                                       target, default …:5433/optimiq
 *   API_CLOAK_ENCRYPTION_KEY                           decrypts legacy passwords and key secrets
 *
 * ## Properties
 *
 * - **Transactional.** Every write happens inside one target-database transaction. A failure —
 *   including a blocking data defect — rolls the whole thing back; there is no half-migrated
 *   state to reason about. `--dry-run` is the same code path with a forced rollback, so a
 *   rehearsal exercises every constraint the real run will hit.
 * - **Rerunnable.** `legacy_user_account` / `legacy_workspace_organization` (added to
 *   `packages/db` by `20260805222217_legacy_identity_mapping`) are the ledger: an already-mapped
 *   legacy ref is skipped, never duplicated. Running it twice is a no-op the second time.
 * - **Sequenced per the plan's rule 2 — data before enforcement.** This writes the mapping and
 *   nothing else. It does not add `organization_id` to a telephony table, does not drop
 *   `access_key_id` and does not enable a policy. Step 5 does that, reading the mapping this
 *   produced, so a bad backfill is recoverable rather than a lockout.
 * - **Empty-source safe.** A missing or empty `fnidentity` is a normal outcome, not an error:
 *   the script reports zero counts and exits 0. `--seed-fixtures` exists so the mapping rules can
 *   still be proven on such a machine.
 *
 * ## Passwords
 *
 * `packages/identity` never hashed passwords — it cloak-**encrypted** them (see the long note in
 * `scripts/identity-migration/plan.ts`). Each one is decrypted here and re-hashed with
 * better-auth's own `hashPassword` (scrypt), which is what makes the plan's gate "every existing
 * user can sign in with their existing password" achievable. A row whose ciphertext cannot be
 * decrypted with the configured key gets a `user` but no `account`: they must reset. That is
 * counted, recorded on `legacy_user_account.password_migrated` and printed — never silent.
 */

import { createHash } from "node:crypto";
import {
	decryptStringSync,
	findKeyForMessage,
	makeKeychainSync,
	parseCloakedString,
} from "@47ng/cloak";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";
import { createEntityId } from "@optimiq-voice/identifiers";
import {
	deriveOrganizationSlug,
	emptyCounts,
	findBlockingDefects,
	IdentityMigrationError,
	type LegacyApiKeyRow,
	type LegacySnapshot,
	type LegacyUserRow,
	type LegacyWorkspaceMemberRow,
	type LegacyWorkspaceRow,
	mapLegacyRole,
	type MigrationCounts,
	normalizeEmail,
	planMemberships,
} from "./identity-migration/plan";

const DEFAULT_SOURCE_URL = "postgresql://optimiq:optimiq@localhost:5433/fnidentity";
const DEFAULT_TARGET_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";

/** Marks synthetic rows written by `--seed-fixtures` so `--drop-fixtures` can find them again. */
const FIXTURE_TAG = "identity-migration-fixture";

interface Options {
	readonly dryRun: boolean;
	readonly seedFixtures: boolean;
	readonly dropFixtures: boolean;
	readonly sourceUrl: string;
	readonly targetUrl: string;
	readonly cloakKey: string | undefined;
	readonly json: boolean;
}

function parseOptions(argv: readonly string[]): Options {
	const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
	const valueOf = (name: string): string | undefined => {
		const prefix = `--${name}=`;
		const hit = argv.find((argument) => argument.startsWith(prefix));
		if (hit) return hit.slice(prefix.length);
		const index = argv.indexOf(`--${name}`);
		const next = index === -1 ? undefined : argv[index + 1];
		return next && !next.startsWith("--") ? next : undefined;
	};

	return {
		dryRun: flags.has("--dry-run"),
		seedFixtures: flags.has("--seed-fixtures"),
		dropFixtures: flags.has("--drop-fixtures"),
		sourceUrl:
			valueOf("source-url") ??
			process.env.IDENTITY_DATABASE_URL ??
			process.env.API_IDENTITY_DATABASE_URL ??
			DEFAULT_SOURCE_URL,
		targetUrl: valueOf("target-url") ?? process.env.DATABASE_URL ?? DEFAULT_TARGET_URL,
		cloakKey: valueOf("cloak-key") ?? process.env.API_CLOAK_ENCRYPTION_KEY,
		json: flags.has("--json"),
	};
}

// -------------------------------------------------------------------------------------------
// Legacy field decryption
// -------------------------------------------------------------------------------------------

/**
 * `@47ng/cloak` round trip, matching `packages/identity/src/db.ts:243-256`.
 *
 * A value that is not cloaked ciphertext is returned untouched — identity's own `decrypt()` does
 * the same, because rows written before field encryption was switched on hold plaintext.
 */
function createDecryptor(cloakKey: string | undefined): (value: string) => string | null {
	if (!cloakKey) {
		return (value) => (parseCloakedString(value) ? null : value);
	}
	const fallbacks = (process.env.PRISMA_FIELD_DECRYPTION_KEYS ?? "").split(",").filter(Boolean);
	const keychain = makeKeychainSync([...new Set([cloakKey, ...fallbacks])]);
	return (value) => {
		if (!parseCloakedString(value)) {
			return value;
		}
		try {
			return decryptStringSync(value, findKeyForMessage(value, keychain));
		} catch {
			return null;
		}
	};
}

/**
 * `defaultKeyHasher` from `@better-auth/api-key@1.6.23` (`dist/index.mjs:2246`): base64url of the
 * SHA-256 digest, unpadded. Reimplemented rather than imported because `apps/api` does not depend
 * on the plugin package directly — `verify-identity-migration.ts` asserts the two agree by
 * verifying a migrated key through `auth.api.verifyApiKey`.
 */
function hashApiKey(key: string): string {
	return createHash("sha256").update(key, "utf8").digest("base64url");
}

// -------------------------------------------------------------------------------------------
// Source reads
// -------------------------------------------------------------------------------------------

type SourceClient = ReturnType<typeof postgres>;

async function tableExists(client: SourceClient, table: string): Promise<boolean> {
	const rows = await client<{ present: boolean }[]>`
		select exists(
			select 1 from information_schema.tables
			where table_schema = 'public' and table_name = ${table}
		) as present
	`;
	return rows[0]?.present === true;
}

async function readLegacySnapshot(client: SourceClient): Promise<LegacySnapshot | null> {
	for (const table of ["users", "workspaces", "workspace_members", "api_keys"]) {
		if (!(await tableExists(client, table))) {
			return null;
		}
	}

	const users = await client<LegacyUserRow[]>`
		select ref, access_key_id as "accessKeyId", name, email,
		       email_verified as "emailVerified", password_hash as "password",
		       avatar, created_at as "createdAt", updated_at as "updatedAt"
		from users order by created_at asc, ref asc
	`;
	const workspaces = await client<LegacyWorkspaceRow[]>`
		select ref, access_key_id as "accessKeyId", name, owner_ref as "ownerRef",
		       created_at as "createdAt"
		from workspaces order by created_at asc, ref asc
	`;
	const workspaceMembers = await client<LegacyWorkspaceMemberRow[]>`
		select ref, status::text as status, role::text as role, user_ref as "userRef",
		       workspace_ref as "workspaceRef", created_at as "createdAt"
		from workspace_members order by created_at asc, ref asc
	`;
	const apiKeys = await client<LegacyApiKeyRow[]>`
		select ref, access_key_id as "accessKeyId", access_key_secret as "accessKeySecret",
		       role::text as role, workspace_ref as "workspaceRef",
		       created_at as "createdAt", expires_at as "expiresAt"
		from api_keys order by created_at asc, ref asc
	`;

	return { users, workspaces, workspaceMembers, apiKeys };
}

// -------------------------------------------------------------------------------------------
// Fixtures — the migration proves itself when fnidentity is empty
// -------------------------------------------------------------------------------------------

/**
 * Writes a small but adversarial legacy dataset: two workspaces whose names collide on a slug,
 * an owner who has no `workspace_members` row, a PENDING invitee, a member with the legacy
 * `USER` role, a duplicate membership row, and an api key. `--drop-fixtures` removes exactly
 * these rows (they are all tagged in `extended` / by ref prefix) and nothing else.
 */
async function seedFixtures(client: SourceClient, cloakKey: string | undefined): Promise<void> {
	const encrypted = (value: string): string => value; // fixtures store plaintext; see decryptor
	void cloakKey;
	const now = new Date();
	const refs = {
		owner: `${FIXTURE_TAG}-user-owner`,
		admin: `${FIXTURE_TAG}-user-admin`,
		agent: `${FIXTURE_TAG}-user-agent`,
		invitee: `${FIXTURE_TAG}-user-invitee`,
		workspaceA: `${FIXTURE_TAG}-ws-a`,
		workspaceB: `${FIXTURE_TAG}-ws-b`,
	};

	await client.begin(async (tx) => {
		for (const [ref, name, email] of [
			[refs.owner, "Fixture Owner", "fixture-owner@optimiq.test"],
			[refs.admin, "Fixture Admin", "fixture-admin@optimiq.test"],
			[refs.agent, "Fixture Agent", "fixture-agent@optimiq.test"],
			[refs.invitee, "Fixture Invitee", "fixture-invitee@optimiq.test"],
		] as const) {
			await tx`
				insert into users (ref, access_key_id, name, email, email_verified, password_hash,
				                   created_at, updated_at, extended)
				values (${ref}, ${`US${ref.replace(/[^a-z0-9]/gu, "").slice(0, 30)}`}, ${name}, ${email},
				        true, ${encrypted("fixture-password-1234")}, ${now}, ${now},
				        ${JSON.stringify({ fixture: FIXTURE_TAG })}::jsonb)
				on conflict (ref) do nothing
			`;
		}

		// Both named "Acme Telecom" on purpose: the slug derivation must break the tie.
		for (const [ref, accessKeyId, name, ownerRef] of [
			[refs.workspaceA, `WO${FIXTURE_TAG.replace(/-/gu, "")}a`, "Acme Telecom", refs.owner],
			[refs.workspaceB, `WO${FIXTURE_TAG.replace(/-/gu, "")}b`, "Acme Telecom", refs.admin],
		] as const) {
			await tx`
				insert into workspaces (ref, access_key_id, name, owner_ref, created_at, updated_at)
				values (${ref}, ${accessKeyId}, ${name}, ${ownerRef}, ${now}, ${now})
				on conflict (ref) do nothing
			`;
		}

		// Deliberately: NO member row for the owner of workspace A (the owner must be synthesised),
		// an ACTIVE agent with the legacy `USER` role, and a PENDING invitee.
		for (const [ref, status, role, userRef, workspaceRef] of [
			[`${FIXTURE_TAG}-m-1`, "ACTIVE", "WORKSPACE_ADMIN", refs.admin, refs.workspaceA],
			[`${FIXTURE_TAG}-m-2`, "ACTIVE", "USER", refs.agent, refs.workspaceA],
			[`${FIXTURE_TAG}-m-3`, "PENDING", "WORKSPACE_MEMBER", refs.invitee, refs.workspaceA],
			[`${FIXTURE_TAG}-m-4`, "ACTIVE", "WORKSPACE_OWNER", refs.admin, refs.workspaceB],
		] as const) {
			await tx`
				insert into workspace_members (ref, status, role, user_ref, workspace_ref,
				                               created_at, updated_at)
				values (${ref}, ${status}::workspace_member_status, ${role}::role, ${userRef},
				        ${workspaceRef}, ${now}, ${now})
				on conflict (ref) do nothing
			`;
		}

		await tx`
			insert into api_keys (ref, access_key_id, access_key_secret, role, workspace_ref,
			                      created_at, updated_at)
			values (${`${FIXTURE_TAG}-key-1`},
			        ${`AP${FIXTURE_TAG.replace(/-/gu, "")}1`},
			        ${encrypted("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")},
			        'WORKSPACE_ADMIN'::role, ${refs.workspaceA}, ${now}, ${now})
			on conflict (ref) do nothing
		`;
	});
}

async function dropFixtures(client: SourceClient): Promise<void> {
	await client.begin(async (tx) => {
		await tx`delete from api_keys where ref like ${`${FIXTURE_TAG}%`}`;
		await tx`delete from workspace_members where ref like ${`${FIXTURE_TAG}%`}`;
		await tx`delete from workspaces where ref like ${`${FIXTURE_TAG}%`}`;
		await tx`delete from users where ref like ${`${FIXTURE_TAG}%`}`;
	});
}

// -------------------------------------------------------------------------------------------
// The migration
// -------------------------------------------------------------------------------------------

export interface MigrationReport {
	readonly dryRun: boolean;
	readonly sourcePresent: boolean;
	readonly counts: MigrationCounts;
	readonly warnings: readonly string[];
	readonly unrecoverablePasswords: readonly string[];
}

/** Sentinel thrown to force a rollback once a dry run has exercised every write. */
class DryRunRollback extends Error {
	readonly report: MigrationReport;
	constructor(report: MigrationReport) {
		super("dry run complete");
		this.name = "DryRunRollback";
		this.report = report;
	}
}

async function migrate(options: Options): Promise<MigrationReport> {
	const source = postgres(options.sourceUrl, { max: 1, onnotice: () => {} });
	const target = postgres(options.targetUrl, { max: 1, onnotice: () => {} });
	const decrypt = createDecryptor(options.cloakKey);

	try {
		if (options.dropFixtures) {
			await dropFixtures(source);
		}
		if (options.seedFixtures) {
			await seedFixtures(source, options.cloakKey);
		}

		const snapshot = await readLegacySnapshot(source);
		if (!snapshot) {
			return {
				dryRun: options.dryRun,
				sourcePresent: false,
				counts: emptyCounts(),
				warnings: [
					`no legacy identity tables at ${redact(options.sourceUrl)} — nothing to migrate`,
				],
				unrecoverablePasswords: [],
			};
		}

		const defects = findBlockingDefects(snapshot);
		if (defects.length > 0) {
			throw new IdentityMigrationError(
				`the legacy dataset cannot be migrated as-is:\n- ${defects.join("\n- ")}`,
			);
		}

		const counts = emptyCounts();
		const warnings: string[] = [];
		const unrecoverablePasswords: string[] = [];

		try {
			/*
			 * Raw SQL rather than the Drizzle table objects from `@optimiq-voice/db`, for the same
			 * reason as `src/auth/legacy-access-key.repository.ts`: pnpm resolves `drizzle-orm` once
			 * per distinct peer set, so a table declared in `packages/db` and an `eq()` imported in
			 * `apps/api` are nominally incompatible instances of the same build. `postgres` has a
			 * single instance and `tx.begin` gives real transactional semantics — a throw anywhere
			 * below rolls the whole migration back, which is exactly what `--dry-run` exploits.
			 */
			const report = await target.begin(async (tx) => {
				// --- users ---------------------------------------------------------------------
				const userIdByRef = new Map<string, string>();
				const alreadyMappedUsers = await tx<{ userRef: string; userId: string }[]>`
					select user_ref as "userRef", user_id as "userId" from legacy_user_account
				`;
				const mappedUserIdByRef = new Map(
					alreadyMappedUsers.map((row) => [row.userRef, row.userId] as const),
				);

				for (const legacyUser of snapshot.users) {
					const mapped = mappedUserIdByRef.get(legacyUser.ref);
					if (mapped) {
						userIdByRef.set(legacyUser.ref, mapped);
						counts.usersLinked += 1;
						continue;
					}

					const email = normalizeEmail(legacyUser.email);
					const existing = await tx<{ id: string }[]>`
						select id from "user" where email = ${email} limit 1
					`;

					let userId = existing[0]?.id;
					if (userId) {
						counts.usersLinked += 1;
						warnings.push(
							`legacy user ${legacyUser.ref} (${email}) already exists in the base database — linked, not recreated`,
						);
					} else {
						userId = createEntityId();
						await tx`
							insert into "user" (id, name, email, email_verified, image, created_at, updated_at)
							values (${userId}::uuid, ${legacyUser.name}, ${email}, ${legacyUser.emailVerified},
							        ${legacyUser.avatar}, ${legacyUser.createdAt}, ${legacyUser.updatedAt})
						`;
						counts.usersCreated += 1;
					}
					userIdByRef.set(legacyUser.ref, userId);

					// --- the credential ---------------------------------------------------------
					const plaintext = decrypt(legacyUser.password);
					const hasCredential = await tx<{ id: string }[]>`
						select id from account
						where user_id = ${userId}::uuid and provider_id = 'credential'
						limit 1
					`;

					let passwordMigrated = false;
					if (hasCredential.length > 0) {
						passwordMigrated = true;
					} else if (plaintext && plaintext.length > 0) {
						await tx`
							insert into account (id, account_id, provider_id, user_id, password,
							                     created_at, updated_at)
							values (${createEntityId()}::uuid, ${userId}, 'credential', ${userId}::uuid,
							        ${await hashPassword(plaintext)}, ${legacyUser.createdAt},
							        ${legacyUser.updatedAt})
						`;
						counts.passwordsMigrated += 1;
						passwordMigrated = true;
					} else {
						counts.passwordsUnrecoverable += 1;
						unrecoverablePasswords.push(email);
					}

					await tx`
						insert into legacy_user_account (access_key_id, user_ref, user_id, password_migrated)
						values (${legacyUser.accessKeyId}, ${legacyUser.ref}, ${userId}::uuid,
						        ${passwordMigrated})
					`;
				}

				// --- organizations -------------------------------------------------------------
				const organizationIdByWorkspaceRef = new Map<string, string>();
				const alreadyMappedWorkspaces = await tx<
					{ workspaceRef: string; organizationId: string }[]
				>`
					select workspace_ref as "workspaceRef", organization_id as "organizationId"
					from legacy_workspace_organization
				`;
				for (const row of alreadyMappedWorkspaces) {
					organizationIdByWorkspaceRef.set(row.workspaceRef, row.organizationId);
				}

				const takenSlugs = new Set(
					(await tx<{ slug: string }[]>`select slug from organization`).map((row) => row.slug),
				);

				for (const workspace of snapshot.workspaces) {
					if (organizationIdByWorkspaceRef.has(workspace.ref)) {
						counts.organizationsLinked += 1;
						continue;
					}
					const organizationId = createEntityId();
					const slug = deriveOrganizationSlug(workspace.name, takenSlugs);
					takenSlugs.add(slug);

					await tx`
						insert into organization (id, name, slug, created_at, metadata)
						values (${organizationId}::uuid, ${workspace.name}, ${slug}, ${workspace.createdAt},
						        ${JSON.stringify({
											legacyAccessKeyId: workspace.accessKeyId,
											legacyWorkspaceRef: workspace.ref,
										})})
					`;
					await tx`
						insert into legacy_workspace_organization (access_key_id, workspace_ref,
						                                           organization_id)
						values (${workspace.accessKeyId}, ${workspace.ref}, ${organizationId}::uuid)
					`;
					organizationIdByWorkspaceRef.set(workspace.ref, organizationId);
					counts.organizationsCreated += 1;
				}

				// --- memberships and invitations ------------------------------------------------
				const membership = planMemberships(snapshot.workspaces, snapshot.workspaceMembers);
				warnings.push(...membership.warnings);

				const ownerUserIdByWorkspaceRef = new Map(
					snapshot.workspaces.map(
						(workspace) => [workspace.ref, userIdByRef.get(workspace.ownerRef)] as const,
					),
				);
				const emailByUserRef = new Map(
					snapshot.users.map(
						(legacyUser) => [legacyUser.ref, normalizeEmail(legacyUser.email)] as const,
					),
				);

				for (const entry of membership.entries) {
					const organizationId = organizationIdByWorkspaceRef.get(entry.workspaceRef);
					const userId = userIdByRef.get(entry.userRef);
					if (!organizationId) {
						throw new IdentityMigrationError(
							`workspace ${entry.workspaceRef} has no organization after the organization pass`,
						);
					}
					if (!userId) {
						warnings.push(
							`membership in ${entry.workspaceRef} references unknown user ${entry.userRef} — skipped`,
						);
						continue;
					}

					if (entry.pending) {
						const inviterId = ownerUserIdByWorkspaceRef.get(entry.workspaceRef) ?? userId;
						const email = emailByUserRef.get(entry.userRef);
						if (!email) continue;
						const pendingAlready = await tx<{ id: string }[]>`
							select id from invitation
							where organization_id = ${organizationId}::uuid and email = ${email}
							limit 1
						`;
						if (pendingAlready.length > 0) {
							continue;
						}
						await tx`
							insert into invitation (id, organization_id, email, role, status, expires_at,
							                        created_at, inviter_id)
							values (${createEntityId()}::uuid, ${organizationId}::uuid, ${email}, ${entry.role},
							        'pending',
							        ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)},
							        ${entry.createdAt}, ${inviterId}::uuid)
						`;
						counts.invitationsCreated += 1;
						continue;
					}

					const existingMember = await tx<{ id: string }[]>`
						select id from member
						where organization_id = ${organizationId}::uuid and user_id = ${userId}::uuid
						limit 1
					`;
					if (existingMember.length > 0) {
						counts.membersExisting += 1;
						continue;
					}

					await tx`
						insert into member (id, organization_id, user_id, role, created_at)
						values (${createEntityId()}::uuid, ${organizationId}::uuid, ${userId}::uuid,
						        ${entry.role}, ${entry.createdAt})
					`;
					counts.membersCreated += 1;
				}

				// --- api keys --------------------------------------------------------------------
				const organizationIds = [...organizationIdByWorkspaceRef.values()];
				const existingKeys =
					organizationIds.length === 0
						? []
						: await tx<{ name: string | null }[]>`
								select name from api_key where reference_id in ${tx(organizationIds)}
							`;
				const takenKeyNames = new Set(existingKeys.map((row) => row.name));

				for (const legacyKey of snapshot.apiKeys) {
					const organizationId = organizationIdByWorkspaceRef.get(legacyKey.workspaceRef);
					if (!organizationId) continue;
					if (takenKeyNames.has(legacyKey.accessKeyId)) {
						counts.apiKeysExisting += 1;
						continue;
					}
					const secret = decrypt(legacyKey.accessKeySecret);
					if (!secret) {
						warnings.push(
							`api key ${legacyKey.accessKeyId} could not be decrypted — not migrated; issue a new key`,
						);
						continue;
					}

					await tx`
						insert into api_key (id, config_id, name, start, prefix, reference_id, key, enabled,
						                     rate_limit_enabled, remaining, expires_at, created_at,
						                     updated_at, permissions, metadata)
						values (${createEntityId()}::uuid, 'default', ${legacyKey.accessKeyId},
						        ${secret.slice(0, 6)}, null, ${organizationId}::uuid, ${hashApiKey(secret)},
						        true,
						        -- the plugin's default is 10 requests/day, which would throttle every
						        -- migrated integration into failure on day one; opt-in for these
						        false,
						        null, ${legacyKey.expiresAt}, ${legacyKey.createdAt}, ${legacyKey.createdAt},
						        null,
						        ${JSON.stringify({
											legacyApiKeyRef: legacyKey.ref,
											legacyAccessKeyId: legacyKey.accessKeyId,
											legacyRole: mapLegacyRole(legacyKey.role),
										})})
					`;
					takenKeyNames.add(legacyKey.accessKeyId);
					counts.apiKeysCreated += 1;
				}

				const result: MigrationReport = {
					dryRun: options.dryRun,
					sourcePresent: true,
					counts,
					warnings,
					unrecoverablePasswords,
				};
				if (options.dryRun) {
					throw new DryRunRollback(result);
				}
				return result;
			});
			return report;
		} catch (error) {
			if (error instanceof DryRunRollback) {
				return error.report;
			}
			throw error;
		}
	} finally {
		await source.end({ timeout: 5 });
		await target.end({ timeout: 5 });
	}
}

function redact(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.password = "";
		parsed.username = "";
		return parsed.toString();
	} catch {
		return "<unparseable url>";
	}
}

// -------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const started = Date.now();
	const report = await migrate(options);
	const elapsedMs = Date.now() - started;

	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ...report, elapsedMs })}\n`);
		return;
	}

	const banner = report.dryRun ? "DRY RUN (rolled back)" : "APPLIED";
	console.log(`\nidentity → organizations · ${banner} · ${String(elapsedMs)}ms`);
	console.log(`  source            ${redact(options.sourceUrl)}`);
	console.log(`  target            ${redact(options.targetUrl)}`);
	if (!report.sourcePresent) {
		console.log("  legacy identity tables are absent — nothing to migrate");
	}
	for (const [name, value] of Object.entries(report.counts)) {
		console.log(`  ${name.padEnd(24)}${String(value)}`);
	}
	for (const warning of report.warnings) {
		console.log(`  ! ${warning}`);
	}
	if (report.unrecoverablePasswords.length > 0) {
		console.log(
			`  ! ${String(report.unrecoverablePasswords.length)} user(s) must reset their password: ` +
				report.unrecoverablePasswords.join(", "),
		);
	}
	console.log("");
}

await main();
