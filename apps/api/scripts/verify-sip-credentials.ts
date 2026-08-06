/**
 * End-to-end verification of `rpc.sip.v1.credential` — the registrar's half of device provisioning.
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/api verify:sip-credentials
 *
 * ## What this gate is for
 *
 * `verify:provisioning` proves the renderer writes a password into a phone's configuration.
 * `apps/sipd`'s gated integration suite proves a phone holding that password can register. Neither
 * proves the piece between them: that this API, given the `(realm, username)` a REGISTER carries,
 * resolves the SAME `secretRef` the renderer used and hashes it into a digest the phone can match.
 *
 * That resolution is pure SQL — a realm→organization directory, a `coalesce(auth_user, number)`
 * join and a `coalesce(extension.sip_secret_ref, device_line.sip_secret_ref)` precedence — and it
 * is the kind of code that is wrong silently. A mistake there produces a perfectly well-formed HA1
 * that no handset on the deployment can ever match, and the only symptom is "registration failed".
 *
 * So this boots the real PBX area against real PostgreSQL and a real NATS server, requests the real
 * subject, and compares the reply against `deriveSipPassword` — the exact function the renderer
 * calls.
 *
 * The tenants here are synthetic UUIDs rather than better-auth organizations, deliberately:
 * `pbx-db` has no cross-database foreign key to the auth tables (`extensions-schema.ts` says so),
 * so an organization id is just a uuid to it, and signing up two users would add an auth dependency
 * to a gate that is about SQL and a subject.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";

const execFileAsync = promisify(execFile);

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const SECRET_KEY = "verify-sip-credentials-root-key-0123456789";
const RUN_ID = Date.now().toString(36);

const REALM_A = `a-${RUN_ID}.verify.optimiq.test`;
const REALM_B = `b-${RUN_ID}.verify.optimiq.test`;
/**
 * A third tenant, whose mapping is DISABLED.
 *
 * It needs its own organization because `org_setting_organization_category_name_key` is unique on
 * `(organization_id, category, name)` — so an organization can hold exactly ONE `sip`/`realm`
 * value. That is the right constraint (one realm per tenant) and it is worth knowing: multi-realm
 * tenancy is not expressible in this directory and will need a table of its own.
 */
const REALM_C = `c-${RUN_ID}.verify.optimiq.test`;

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
	checks.push({ name, ok, detail });
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
	return ok;
}

/** A uuid v7-shaped id. `uuidV7PrimaryKey` defaults exist, but seeds name their own rows. */
function id(tail: string): string {
	const padded = tail.padStart(12, "0").slice(-12);
	return `018f5a00-0000-7000-8000-${padded}`;
}

async function startNats(): Promise<{ url: string; stop: () => Promise<void> } | undefined> {
	try {
		await execFileAsync("docker", ["version"], { timeout: 10_000 });
	} catch {
		return undefined;
	}

	const name = `verify-sip-credentials-${RUN_ID}`;
	const { stdout } = await execFileAsync("docker", [
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		"-p",
		"127.0.0.1::4222",
		"nats:2.11-alpine",
		"-js",
	]);
	const container = stdout.trim();
	const stop = async (): Promise<void> => {
		try {
			await execFileAsync("docker", ["rm", "-f", container], { timeout: 30_000 });
		} catch {
			// A leaked container is a nuisance, not a failed gate.
		}
	};

	try {
		let mapped = "";
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const port = await execFileAsync("docker", ["port", container, "4222/tcp"]);
				const first = port.stdout.trim().split("\n")[0]?.trim();
				if (first) {
					mapped = first;
					break;
				}
			} catch {
				// `docker port` races the daemon publishing the port. Retry.
			}
			await delay(200);
		}
		if (mapped === "") {
			throw new Error("docker never published the NATS port");
		}
		return { url: `nats://${mapped}`, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;

	console.log("\nstarting NATS (nats:2.11-alpine, JetStream)\n");
	const nats = await startNats();
	if (nats === undefined) {
		console.error(
			"docker is unavailable, and this gate IS the broker round trip — there is nothing " +
				"meaningful left to check without it. Start docker and re-run.",
		);
		process.exitCode = 1;
		return;
	}

	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.PBX_DATABASE_URL = pbxDatabaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = "http://127.0.0.1:1";
	process.env.API_APP_URL = "http://127.0.0.1:1";
	process.env.PROVISION_SIP_SECRET_KEY = SECRET_KEY;
	process.env.PROVISION_SIP_SERVER = "pbx.verify.optimiq.test";
	process.env.NATS_URL = nats.url;

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule } = await import("../src/auth/auth-bootstrap");
	const { PbxModule } = await import("../src/pbx/pbx.module");
	const { SipCredentialsResponder } =
		await import("../src/pbx/sip-credentials/sip-credentials.responder");
	const { createPbxDatabaseClient, device, deviceLine, extension, orgSetting } =
		await import("@optimiq-voice/pbx-db");
	const { eq } = await import("@optimiq-voice/pbx-db");
	const { RPC_SUBJECTS } = await import("@optimiq-voice/events/subjects");
	const { sipCredentialResponseSchema } = await import("@optimiq-voice/events/schemas");
	const { deriveSipPassword } = await import("../src/provisioning/render/provision-secret");
	const { connect } = await import("nats");

	const orgA = id("a1");
	const orgB = id("b2");
	const orgC = id("c3");
	const pbx = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "verify-sip-credentials",
		maxConnections: 4,
	});

	const seededOrgs = [orgA, orgB, orgC];
	const cleanup = async (): Promise<void> => {
		for (const table of [deviceLine, device, extension, orgSetting]) {
			for (const organizationId of seededOrgs) {
				await pbx.adminDb.delete(table).where(eq(table.organizationId, organizationId));
			}
		}
	};

	const app = await NestFactory.create(createApiRootModule([], [PbxModule]), new FastifyAdapter(), {
		logger: ["error"],
	});
	app.enableShutdownHooks();

	let nc: Awaited<ReturnType<typeof connect>> | undefined;

	try {
		await cleanup();

		// --- 0. seed --------------------------------------------------------------------------
		console.log("0. seeding two tenants");

		await pbx.adminDb.insert(orgSetting).values([
			{ id: id("51"), organizationId: orgA, category: "sip", name: "realm", value: REALM_A },
			{ id: id("52"), organizationId: orgB, category: "sip", name: "realm", value: REALM_B },
			// A disabled mapping must not resolve; an operator turning a realm off is turning
			// registration off, not silently keeping it.
			{
				id: id("53"),
				organizationId: orgC,
				category: "sip",
				name: "realm",
				value: REALM_C,
				enabled: false,
			},
		]);

		// 1001: a plain extension, no device. The softphone case.
		// 1002: an extension with a device line that does NOT override auth_user.
		// 1003: an extension with a device line that DOES override auth_user to "phone-1003".
		// 1004: a device line with NO extension, carrying its own secretRef.
		// 1005: a disabled extension.
		await pbx.adminDb.insert(extension).values([
			{
				id: id("11"),
				organizationId: orgA,
				number: "1001",
				label: "Softphone",
				sipSecretRef: "ext/1001/sip",
			},
			{
				id: id("12"),
				organizationId: orgA,
				number: "1002",
				label: "Desk",
				sipSecretRef: "ext/1002/sip",
			},
			{
				id: id("13"),
				organizationId: orgA,
				number: "1003",
				label: "Renamed",
				sipSecretRef: "ext/1003/sip",
			},
			{
				id: id("15"),
				organizationId: orgA,
				number: "1005",
				label: "Off",
				sipSecretRef: "ext/1005/sip",
				enabled: false,
			},
			// Organization B has an extension with the SAME number and a different secret.
			{
				id: id("21"),
				organizationId: orgB,
				number: "1001",
				label: "B Softphone",
				sipSecretRef: "ext/b-1001/sip",
			},
		]);

		// `provisioning_token` is `not null` and globally unique. These devices are never rendered
		// here — the renderer has its own gate — so the tokens only have to be distinct.
		await pbx.adminDb.insert(device).values([
			{
				id: id("31"),
				organizationId: orgA,
				macAddress: "001500000031",
				vendor: "yealink",
				model: "T54W",
				provisioningToken: `vsc-${RUN_ID}-31`,
			},
			{
				id: id("32"),
				organizationId: orgA,
				macAddress: "001500000032",
				vendor: "yealink",
				model: "T54W",
				provisioningToken: `vsc-${RUN_ID}-32`,
			},
			{
				id: id("33"),
				organizationId: orgA,
				macAddress: "001500000033",
				vendor: "yealink",
				model: "T54W",
				provisioningToken: `vsc-${RUN_ID}-33`,
			},
		]);

		await pbx.adminDb.insert(deviceLine).values([
			{
				id: id("41"),
				organizationId: orgA,
				deviceId: id("31"),
				lineNumber: 1,
				extensionId: id("12"),
			},
			{
				id: id("42"),
				organizationId: orgA,
				deviceId: id("32"),
				lineNumber: 1,
				extensionId: id("13"),
				authUser: "phone-1003",
			},
			{
				id: id("43"),
				organizationId: orgA,
				deviceId: id("33"),
				lineNumber: 1,
				authUser: "1004",
				sipSecretRef: "device/1004/line/1",
			},
		]);
		check("seed committed", true, `${REALM_A} / ${REALM_B}`);

		// --- 1. the responder ------------------------------------------------------------------
		console.log("\n1. booting the PBX area and its responder");
		// `app.init()` runs `onModuleInit`, which is where `SipCredentialsResponder` subscribes.
		// The Nest microservice transport is deliberately NOT started here: this subject is served
		// by a raw subscription, and requiring the transport would hide the fact that the payload
		// on the wire is the contract's own rather than Nest's envelope.
		await app.init();
		await delay(300);
		const responder = app.get(SipCredentialsResponder);
		check("the credential responder is subscribed", responder.isReady);

		nc = await connect({
			servers: nats.url,
			...natsCredentials(process.env),
			name: "verify-sip-credentials",
		});

		const ask = async (
			realm: string,
			username: string,
		): Promise<ReturnType<typeof sipCredentialResponseSchema.parse>> => {
			const reply = await nc!.request(
				RPC_SUBJECTS.sipCredential,
				new TextEncoder().encode(JSON.stringify({ realm, username })),
				{ timeout: 5_000 },
			);
			return sipCredentialResponseSchema.parse(
				JSON.parse(new TextDecoder().decode(reply.data)) as unknown,
			);
		};

		/** The digest a phone provisioned by this deployment would answer with. */
		const expected = (organizationId: string, secretRef: string, username: string, realm: string) =>
			createHash("md5")
				.update(
					`${username}:${realm}:${deriveSipPassword({ rootKey: SECRET_KEY, organizationId, secretRef })}`,
					"utf8",
				)
				.digest("hex");

		// --- 2. the four ways a line resolves ---------------------------------------------------
		console.log("\n2. every shape the renderer can produce");

		const softphone = await ask(REALM_A, "1001");
		check(
			"a bare extension resolves and carries the tenant",
			softphone.found && softphone.enabled && softphone.orgId === orgA,
			`found=${softphone.found} org=${softphone.orgId ?? "-"}`,
		);
		check(
			"its ha1 is the digest of the renderer's derived password",
			softphone.ha1 === expected(orgA, "ext/1001/sip", "1001", REALM_A),
			softphone.ha1 ?? "(none)",
		);

		const desk = await ask(REALM_A, "1002");
		check(
			"a device line without an auth_user override resolves through its extension",
			desk.ha1 === expected(orgA, "ext/1002/sip", "1002", REALM_A),
			desk.ha1 ?? "(none)",
		);
		check(
			"it names the device it belongs to",
			desk.deviceId === id("31"),
			desk.deviceId ?? "(none)",
		);

		// The renderer's `authUser = line.authUser ?? registerUser` is what the phone SENDS, so the
		// lookup has to key on it. Asking for the extension number here would find nothing.
		const renamed = await ask(REALM_A, "phone-1003");
		check(
			"an auth_user override is what authenticates, not the extension number",
			renamed.found && renamed.ha1 === expected(orgA, "ext/1003/sip", "phone-1003", REALM_A),
			renamed.ha1 ?? "(none)",
		);
		check(
			"the extension's secret_ref still wins over the line's",
			renamed.extensionId === id("13"),
			renamed.extensionId ?? "(none)",
		);

		const orphanLine = await ask(REALM_A, "1004");
		check(
			"a device line with no extension derives from its own secret_ref",
			orphanLine.found && orphanLine.ha1 === expected(orgA, "device/1004/line/1", "1004", REALM_A),
			orphanLine.ha1 ?? "(none)",
		);

		// --- 3. refusals ------------------------------------------------------------------------
		console.log("\n3. what must NOT resolve");

		const unknown = await ask(REALM_A, "1999");
		check("an unknown username is not found", !unknown.found && unknown.ha1 === undefined);

		const disabled = await ask(REALM_A, "1005");
		check(
			"a disabled extension is found but not enabled, and carries no ha1",
			disabled.found && !disabled.enabled && disabled.ha1 === undefined,
			`found=${disabled.found} enabled=${disabled.enabled}`,
		);

		const unmapped = await ask("nobody.verify.optimiq.test", "1001");
		check(
			"an unmapped realm is refused with an operator-facing reason",
			!unmapped.found && (unmapped.reason ?? "").includes("no organization is mapped"),
			unmapped.reason ?? "(no reason)",
		);

		const offRealm = await ask(REALM_C, "1001");
		check(
			"a disabled realm mapping does not resolve",
			!offRealm.found && (offRealm.reason ?? "").includes("no organization is mapped"),
			offRealm.reason ?? "(no reason)",
		);

		// --- 4. tenant separation ----------------------------------------------------------------
		console.log("\n4. two tenants, one extension number");

		const bSide = await ask(REALM_B, "1001");
		check(
			"the same number in another realm resolves to the other tenant",
			bSide.found && bSide.orgId === orgB,
			`org=${bSide.orgId ?? "-"}`,
		);
		check(
			"and to a different digest, because the org is inside the derivation",
			bSide.ha1 === expected(orgB, "ext/b-1001/sip", "1001", REALM_B) &&
				bSide.ha1 !== softphone.ha1,
			bSide.ha1 ?? "(none)",
		);
		check(
			"organization A's realm cannot reach organization B's extension",
			// B's extension 1001 exists, but only inside B's realm. Asking A's realm for it must
			// return A's row, never B's — this is the RLS scope doing its job through the directory.
			softphone.orgId === orgA && softphone.ha1 !== bSide.ha1,
		);

		// --- 5. the realm is part of the digest ---------------------------------------------------
		console.log("\n5. the realm is inside the hash");
		check(
			"the same account under a different realm would hash differently",
			expected(orgA, "ext/1001/sip", "1001", REALM_A) !==
				expected(orgA, "ext/1001/sip", "1001", REALM_B),
		);
	} finally {
		console.log("\ncleaning up");
		try {
			await cleanup();
		} catch (error) {
			console.error("cleanup failed:", error);
		}
		await nc?.drain().catch(() => undefined);
		await app.close().catch(() => undefined);
		await pbx.close?.().catch?.(() => undefined);
		await nats.stop();
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.log("sip credential verification FAILED");
		process.exitCode = 1;
		return;
	}
	console.log("sip credential verification PASSED");
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
