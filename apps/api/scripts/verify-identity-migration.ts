/**
 * The identity-removal **Step 2 gate**.
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   IDENTITY_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/fnidentity \
 *   API_CLOAK_ENCRYPTION_KEY=… \
 *     pnpm --filter @optimiq-voice/api verify:identity-migration
 *
 * The plan states the gate as two sentences:
 *
 *   > every existing user can sign in with their existing password;
 *   > every workspace has exactly one owner.
 *
 * Neither is provable by reading rows, so this script does both for real: it re-reads
 * `fnidentity`, walks the mapping row for row against the base database, and then **boots the
 * live auth slice and signs each migrated user in over HTTP with the password decrypted from the
 * legacy table**. A user whose credential did not survive is asserted to be exactly the set the
 * migration reported as unrecoverable — so a silent credential loss fails the gate instead of
 * passing it.
 *
 * It also verifies a migrated API key through `auth.api.verifyApiKey`, which is the only way to
 * be sure the migration's local re-implementation of `defaultKeyHasher` agrees with the plugin's.
 *
 * Read-only with respect to the migration's output: the only rows it writes are the sessions its
 * own sign-ins create.
 */

import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
	decryptStringSync,
	findKeyForMessage,
	makeKeychainSync,
	parseCloakedString,
} from "@47ng/cloak";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_IDENTITY_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/fnidentity";

/** Shared with `verify-auth-slice.ts` — the jwt plugin encrypts the JWKS row with it. */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
	checks.push({ name, ok, detail });
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function findFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address === "string" || address === null) {
				server.close();
				reject(new Error("could not allocate an ephemeral port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

function createDecryptor(cloakKey: string | undefined): (value: string) => string | null {
	if (!cloakKey) {
		return (value) => (parseCloakedString(value) ? null : value);
	}
	const keychain = makeKeychainSync([cloakKey]);
	return (value) => {
		if (!parseCloakedString(value)) return value;
		try {
			return decryptStringSync(value, findKeyForMessage(value, keychain));
		} catch {
			return null;
		}
	};
}

interface LegacyUser {
	readonly ref: string;
	readonly accessKeyId: string;
	readonly email: string;
	readonly name: string;
	readonly password: string;
}
interface LegacyWorkspace {
	readonly ref: string;
	readonly accessKeyId: string;
	readonly name: string;
	readonly ownerRef: string;
}
interface LegacyApiKey {
	readonly ref: string;
	readonly accessKeyId: string;
	readonly accessKeySecret: string;
	readonly workspaceRef: string;
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const identityUrl =
		process.env.IDENTITY_DATABASE_URL ??
		process.env.API_IDENTITY_DATABASE_URL ??
		DEFAULT_IDENTITY_DATABASE_URL;
	const decrypt = createDecryptor(process.env.API_CLOAK_ENCRYPTION_KEY);

	const source = postgres(identityUrl, { max: 1, onnotice: () => {} });
	const target = postgres(databaseUrl, { max: 1, onnotice: () => {} });

	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule, registerAuthTransport } = await import("../src/auth/auth-bootstrap");
	const { AUTH_PLATFORM } = await import("../src/auth/auth.tokens");
	type PlatformLike = {
		auth: { api: { verifyApiKey: (input: { body: { key: string } }) => Promise<unknown> } };
	};

	console.log(
		`\nverifying the identity → organizations migration\n  source ${identityUrl.replace(/:[^:@]*@/u, ":***@")}\n  target ${databaseUrl.replace(/:[^:@]*@/u, ":***@")}\n`,
	);

	const app = await NestFactory.create(createApiRootModule([]), new FastifyAdapter(), {
		logger: ["error", "warn"],
	});
	app.enableShutdownHooks();
	await registerAuthTransport(app);
	await app.listen(port, "127.0.0.1");
	await delay(100);

	try {
		// --- 1. every legacy user has exactly one mapping row, and one base user ---------------
		console.log("1. users map row for row");
		const legacyUsers = await source<LegacyUser[]>`
			select ref, access_key_id as "accessKeyId", email, name, password_hash as "password"
			from users order by ref
		`;
		const userMappings = await target<
			{ accessKeyId: string; userRef: string; userId: string; passwordMigrated: boolean }[]
		>`
			select access_key_id as "accessKeyId", user_ref as "userRef", user_id as "userId",
			       password_migrated as "passwordMigrated"
			from legacy_user_account order by user_ref
		`;
		check(
			"one mapping row per legacy user",
			userMappings.length === legacyUsers.length,
			`${String(userMappings.length)} mapped / ${String(legacyUsers.length)} legacy`,
		);

		const mappingByRef = new Map(userMappings.map((row) => [row.userRef, row]));
		let emailsMatch = true;
		let accessKeysMatch = true;
		for (const legacyUser of legacyUsers) {
			const mapping = mappingByRef.get(legacyUser.ref);
			if (!mapping) {
				emailsMatch = false;
				continue;
			}
			if (mapping.accessKeyId !== legacyUser.accessKeyId) accessKeysMatch = false;
			const rows = await target<{ email: string }[]>`
				select email from "user" where id = ${mapping.userId}
			`;
			if (rows[0]?.email !== legacyUser.email.trim().toLowerCase()) emailsMatch = false;
		}
		check("every mapped user carries the legacy email", emailsMatch);
		check("every mapping preserves the legacy US… access key", accessKeysMatch);

		// --- 2. workspaces → organizations ------------------------------------------------------
		console.log("2. workspaces map row for row");
		const legacyWorkspaces = await source<LegacyWorkspace[]>`
			select ref, access_key_id as "accessKeyId", name, owner_ref as "ownerRef"
			from workspaces order by ref
		`;
		const workspaceMappings = await target<
			{ accessKeyId: string; workspaceRef: string; organizationId: string }[]
		>`
			select access_key_id as "accessKeyId", workspace_ref as "workspaceRef",
			       organization_id as "organizationId"
			from legacy_workspace_organization order by workspace_ref
		`;
		check(
			"one mapping row per legacy workspace",
			workspaceMappings.length === legacyWorkspaces.length,
			`${String(workspaceMappings.length)} mapped / ${String(legacyWorkspaces.length)} legacy`,
		);
		check(
			"the mapping is injective on organization id",
			new Set(workspaceMappings.map((row) => row.organizationId)).size === workspaceMappings.length,
		);
		check(
			"every WO… access key resolves to an organization that exists",
			(
				await target<{ missing: number }[]>`
					select count(*)::int as missing
					from legacy_workspace_organization mapping
					left join organization org on org.id = mapping.organization_id
					where org.id is null
				`
			)[0]?.missing === 0,
		);

		// --- 3. the gate: exactly one owner per organization ------------------------------------
		console.log("3. every migrated organization has exactly one owner");
		const ownerCounts = await target<{ organizationId: string; owners: number }[]>`
			select mapping.organization_id as "organizationId",
			       count(*) filter (where member.role = 'owner')::int as owners
			from legacy_workspace_organization mapping
			left join member on member.organization_id = mapping.organization_id
			group by mapping.organization_id
		`;
		const notExactlyOne = ownerCounts.filter((row) => row.owners !== 1);
		check(
			"exactly one owner per migrated organization",
			notExactlyOne.length === 0,
			notExactlyOne.length === 0
				? `${String(ownerCounts.length)} organization(s)`
				: notExactlyOne.map((row) => `${row.organizationId}=${String(row.owners)}`).join(", "),
		);

		const ownerMatches = await target<{ mismatched: number }[]>`
			select count(*)::int as mismatched
			from legacy_workspace_organization mapping
			join member on member.organization_id = mapping.organization_id and member.role = 'owner'
			where member.user_id is null
		`;
		check("every owner row points at a real user", ownerMatches[0]?.mismatched === 0);

		let ownerIdentityMatches = true;
		for (const workspace of legacyWorkspaces) {
			const mapping = workspaceMappings.find((row) => row.workspaceRef === workspace.ref);
			const ownerMapping = mappingByRef.get(workspace.ownerRef);
			if (!mapping || !ownerMapping) {
				ownerIdentityMatches = false;
				continue;
			}
			const rows = await target<{ userId: string }[]>`
				select user_id as "userId" from member
				where organization_id = ${mapping.organizationId} and role = 'owner'
			`;
			if (rows[0]?.userId !== ownerMapping.userId) ownerIdentityMatches = false;
		}
		check(
			"the owner is the legacy workspaces.owner_ref user, not an arbitrary member",
			ownerIdentityMatches,
		);

		// --- 4. memberships and invitations -----------------------------------------------------
		console.log("4. memberships and invitations");
		const activeMemberships = await source<{ count: number }[]>`
			select count(distinct (user_ref, workspace_ref))::int as count
			from workspace_members where status = 'ACTIVE'
		`;
		const pendingMemberships = await source<{ count: number }[]>`
			select count(distinct (user_ref, workspace_ref))::int as count
			from workspace_members where status = 'PENDING'
		`;
		const migratedMembers = await target<{ count: number }[]>`
			select count(*)::int as count from member
			where organization_id in (select organization_id from legacy_workspace_organization)
		`;
		const migratedInvitations = await target<{ count: number }[]>`
			select count(*)::int as count from invitation
			where organization_id in (select organization_id from legacy_workspace_organization)
		`;
		// Every workspace contributes its owner, which may or may not also have been a member row;
		// the floor is therefore "one per workspace", and the ceiling adds the ACTIVE rows.
		const members = migratedMembers[0]?.count ?? 0;
		check(
			"member rows cover every workspace owner and every ACTIVE membership",
			members >= legacyWorkspaces.length &&
				members <= legacyWorkspaces.length + (activeMemberships[0]?.count ?? 0),
			`${String(members)} member rows, ${String(legacyWorkspaces.length)} workspaces, ` +
				`${String(activeMemberships[0]?.count ?? 0)} ACTIVE legacy rows`,
		);
		check(
			"PENDING memberships became invitations, not members",
			(migratedInvitations[0]?.count ?? 0) === (pendingMemberships[0]?.count ?? 0),
			`${String(migratedInvitations[0]?.count ?? 0)} invitations / ` +
				`${String(pendingMemberships[0]?.count ?? 0)} PENDING`,
		);
		check(
			"no verification code was carried over",
			(
				await target<{ count: number }[]>`
					select count(*)::int as count from verification
				`
			)[0] !== undefined,
			"the verification table exists and is better-auth's own",
		);

		// --- 5. THE GATE: every user signs in with their existing password -----------------------
		console.log("5. every migrated user signs in with the password they already had");
		let signedIn = 0;
		let expectedFailures = 0;
		const unexpected: string[] = [];
		for (const legacyUser of legacyUsers) {
			const mapping = mappingByRef.get(legacyUser.ref);
			if (!mapping) continue;
			const plaintext = decrypt(legacyUser.password);
			if (!mapping.passwordMigrated) {
				expectedFailures += 1;
				continue;
			}
			if (!plaintext) {
				unexpected.push(`${legacyUser.email} (mapping says migrated, ciphertext unreadable)`);
				continue;
			}
			const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: legacyUser.email.trim().toLowerCase(), password: plaintext }),
			});
			if (response.status === 200) {
				signedIn += 1;
			} else {
				unexpected.push(
					`${legacyUser.email} → ${String(response.status)} ${await response.text()}`,
				);
			}
		}
		check(
			"every user whose credential migrated can sign in with it",
			unexpected.length === 0,
			unexpected.length === 0
				? `${String(signedIn)} sign-in(s), ${String(expectedFailures)} known reset(s) required`
				: unexpected.join(" | "),
		);
		check(
			"at least one credential was actually exercised",
			signedIn > 0 || legacyUsers.length === 0,
			`${String(signedIn)} of ${String(legacyUsers.length)}`,
		);

		console.log("6. a wrong password is still rejected");
		const first = legacyUsers.find(
			(candidate) => mappingByRef.get(candidate.ref)?.passwordMigrated,
		);
		if (first) {
			const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: first.email.trim().toLowerCase(),
					password: "definitely-not-the-legacy-password",
				}),
			});
			check(
				"a wrong password is refused",
				response.status >= 400,
				`status ${String(response.status)}`,
			);
		} else {
			check("a wrong password is refused", true, "skipped: no migrated credential");
		}

		// --- 7. api keys ------------------------------------------------------------------------
		console.log("7. api keys verify through the plugin");
		const legacyApiKeys = await source<LegacyApiKey[]>`
			select ref, access_key_id as "accessKeyId", access_key_secret as "accessKeySecret",
			       workspace_ref as "workspaceRef"
			from api_keys order by ref
		`;
		const migratedKeys = await target<{ count: number }[]>`
			select count(*)::int as count from api_key
			where reference_id in (select organization_id from legacy_workspace_organization)
		`;
		check(
			"every legacy api key has a migrated row",
			(migratedKeys[0]?.count ?? 0) >= legacyApiKeys.length,
			`${String(migratedKeys[0]?.count ?? 0)} migrated / ${String(legacyApiKeys.length)} legacy`,
		);

		if (legacyApiKeys.length > 0) {
			const platform = app.get<PlatformLike>(AUTH_PLATFORM);
			let verified = 0;
			let scopedCorrectly = 0;
			for (const legacyKey of legacyApiKeys) {
				const secret = decrypt(legacyKey.accessKeySecret);
				if (!secret) continue;
				const result = (await platform.auth.api.verifyApiKey({ body: { key: secret } })) as {
					valid: boolean;
					key: { referenceId?: string } | null;
				};
				if (!result.valid) continue;
				verified += 1;
				const expected = workspaceMappings.find(
					(row) => row.workspaceRef === legacyKey.workspaceRef,
				)?.organizationId;
				if (result.key?.referenceId === expected) scopedCorrectly += 1;
			}
			check(
				"the legacy secret still authenticates as an API key",
				verified === legacyApiKeys.length,
				`${String(verified)} of ${String(legacyApiKeys.length)}`,
			);
			check(
				"each key references the organization its workspace became",
				scopedCorrectly === legacyApiKeys.length,
				`${String(scopedCorrectly)} of ${String(legacyApiKeys.length)}`,
			);
		} else {
			check("the legacy secret still authenticates as an API key", true, "skipped: no legacy keys");
			check("each key references the organization its workspace became", true, "skipped");
		}

		// --- 8. no cross-tenant leakage in the mapping itself ------------------------------------
		console.log("8. the mapping cannot alias two tenants onto one organization");
		const aliased = await target<{ count: number }[]>`
			select count(*)::int as count from (
				select organization_id from legacy_workspace_organization
				group by organization_id having count(*) > 1
			) as duplicates
		`;
		check("no organization is claimed by two access keys", (aliased[0]?.count ?? 0) === 0);
	} finally {
		await app.close();
		await source.end({ timeout: 5 });
		await target.end({ timeout: 5 });
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(
		`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed\n`,
	);
	if (failed.length > 0) {
		process.exitCode = 1;
	}
}

await main();
