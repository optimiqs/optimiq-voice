/**
 * End-to-end verification of the PBX area (P3 gate).
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/api verify:pbx
 *
 * It boots the real HTTP slice — `createApiRootModule([], [PbxModule])`, the auth slice plus the
 * PBX area, on an ephemeral port against a real PostgreSQL — and drives it as a client would.
 * `AppModule` is excluded for the same reason `verify-auth-slice.ts` excludes it: its
 * `RuntimeHostService` starts the gRPC servers, the ARI client and the InfluxDB writer, none of
 * which this gate is about and none of which exist on a developer machine.
 *
 * What it proves, in order:
 *
 *  1. CRUD round trips for all fourteen T1 resources, including the four child collections.
 *  2. Tenant isolation: a second organization cannot see, read, update or delete the first's rows
 *     — enforced by RLS, not by a `where` clause we could forget.
 *  3. Compile-on-write refuses an unsound configuration with a 422 carrying field-addressable
 *     diagnostics, AND rolls the mutation back (the dangling row is not in the database after).
 *  4. Compile-on-write persists a configuration that is merely questionable and returns the
 *     warning in the envelope (an empty ring group).
 *  5. A delete that would leave a dangling destination is refused with a 409 naming the referrers.
 *  6. The three CRUD surfaces that landed last — queues (with agents and tiers), conferences and
 *     park lots — are routable: a queue reached through an IVR option compiles and simulates.
 *  7. `PUT …/reorder` rewrites a child collection's order in ONE transaction, and a `null` on a
 *     defaulted numeric column resets it to the server's value rather than failing the write.
 *  8. With a broker: the compiled artifact appears in the `routing-cache` KV bucket under the key
 *     `packages/routing` specifies, and `rpc.routing.v1.resolve` answers over NATS.
 *
 * The NATS half is skipped, loudly, when Docker is unavailable — it spins `nats:2.11-alpine` on an
 * ephemeral port and removes it afterwards.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
/**
 * The same secret `verify-auth-slice.ts` uses, and `AUTH_SECRET` from the environment when it is
 * set.
 *
 * better-auth encrypts its JWKS private keys with `AUTH_SECRET` and stores them in the database,
 * so two verification scripts pointing at one development database MUST agree on it — a second
 * secret cannot decrypt the first one's keys, and every session resolution fails with
 * `Failed to decrypt private key`, which surfaces as a blanket 401.
 */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const RUN_ID = Date.now().toString(36);

/**
 * The run's DID, unique per run.
 *
 * `phone_number.e164` carries a PLATFORM-WIDE unique index (a DID has exactly one owner on the
 * PSTN, so it has exactly one owner here), which means a fixed number would make two runs — or one
 * run and the leftovers of a crashed one — collide with a 409 that has nothing to do with what the
 * run is checking. The last nine digits are derived from the run id, which also makes the row
 * traceable to the run that made it.
 */
const RUN_DID = `+1212${(Date.now() % 1_000_000).toString().padStart(6, "0")}`;

/** A second number, created and released so the index's DELETE path is exercised too. */
const SPARE_DID = `+1213${(Date.now() % 1_000_000).toString().padStart(6, "0")}`;

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
	checks.push({ name, ok, detail });
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
	return ok;
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

class CookieJar {
	private readonly cookies = new Map<string, string>();

	absorb(response: Response): void {
		for (const raw of response.headers.getSetCookie()) {
			const [pair] = raw.split(";");
			if (!pair) continue;
			const separator = pair.indexOf("=");
			if (separator === -1) continue;
			this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
		}
	}

	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

interface JsonResponse {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

function makeClient(baseUrl: string, jar: CookieJar) {
	return async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) {
			headers["content-type"] = "application/json";
		}
		const cookie = jar.header();
		if (cookie) {
			headers.cookie = cookie;
		}
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		jar.absorb(response);
		const text = await response.text();
		let parsed: unknown = null;
		try {
			parsed = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			parsed = { raw: text };
		}
		return {
			status: response.status,
			body:
				typeof parsed === "object" && parsed !== null
					? (parsed as Record<string, unknown>)
					: { value: parsed },
		};
	};
}

type Client = ReturnType<typeof makeClient>;

function data(response: JsonResponse): Record<string, unknown> {
	const value = response.body.data;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function rows(response: JsonResponse): Record<string, unknown>[] {
	const value = response.body.data;
	return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function id(response: JsonResponse): string {
	const value = data(response).id;
	return typeof value === "string" ? value : "";
}

function warnings(response: JsonResponse): { code?: string; field?: string }[] {
	const value = response.body.warnings;
	return Array.isArray(value) ? (value as { code?: string; field?: string }[]) : [];
}

function diagnostics(response: JsonResponse): { code?: string; field?: string }[] {
	const value = response.body.diagnostics;
	return Array.isArray(value) ? (value as { code?: string; field?: string }[]) : [];
}

function references(response: JsonResponse): { kind?: string; id?: string; field?: string }[] {
	const value = response.body.references;
	return Array.isArray(value) ? (value as { kind?: string; id?: string; field?: string }[]) : [];
}

// ---------------------------------------------------------------------------------------------
// Docker-managed NATS
// ---------------------------------------------------------------------------------------------

interface NatsHandle {
	readonly url: string;
	readonly containerId: string;
}

/**
 * Containers this harness starts all carry this prefix, so a run that was killed before its
 * cleanup could not leave a broker listening on a port the next run has no idea about.
 */
const NATS_CONTAINER_PREFIX = "optimiq-verify-pbx";

/** Removes containers a previous, interrupted run left behind. Best effort by construction. */
async function sweepStaleNats(): Promise<void> {
	try {
		const { stdout } = await execFileAsync("docker", [
			"ps",
			"-aq",
			"--filter",
			`name=${NATS_CONTAINER_PREFIX}`,
		]);
		const stale = stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (stale.length > 0) {
			await execFileAsync("docker", ["rm", "-f", ...stale]);
			console.log(`  (removed ${stale.length} stale verify-pbx NATS container(s))`);
		}
	} catch {
		// No docker, or nothing to sweep. Either way there is nothing to report.
	}
}

async function startNats(): Promise<NatsHandle | undefined> {
	const port = await findFreePort();
	await sweepStaleNats();
	try {
		const { stdout } = await execFileAsync("docker", [
			"run",
			"-d",
			"--rm",
			"--name",
			`${NATS_CONTAINER_PREFIX}-${RUN_ID}`,
			"-p",
			`${port}:4222`,
			"nats:2.11-alpine",
			"-js",
		]);
		const containerId = stdout.trim();
		// JetStream needs a moment before it accepts stream/KV management calls.
		await delay(1500);
		return { url: `nats://127.0.0.1:${port}`, containerId };
	} catch (error) {
		console.log(
			`  (docker unavailable — NATS checks will be skipped: ${
				error instanceof Error ? error.message.split("\n")[0] : String(error)
			})`,
		);
		return undefined;
	}
}

async function stopNats(handle: NatsHandle): Promise<void> {
	try {
		await execFileAsync("docker", ["rm", "-f", handle.containerId]);
	} catch (error) {
		console.error("could not remove the NATS container", error);
	}
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;
	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	console.log("\nstarting NATS (nats:2.11-alpine, JetStream)\n");
	const nats = await startNats();

	// `@optimiq-voice/config` parses the environment at import time and the PBX module reads it in
	// a provider factory, so it has to be complete before anything that imports either is loaded.
	// Every import below is therefore dynamic.
	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.PBX_DATABASE_URL = pbxDatabaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;
	if (nats === undefined) {
		delete process.env.NATS_URL;
	} else {
		process.env.NATS_URL = nats.url;
	}

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule, registerAuthTransport } = await import("../src/auth/auth-bootstrap");
	const { registerPbxTransport } = await import("../src/pbx/pbx-bootstrap");
	const { PbxModule } = await import("../src/pbx/pbx.module");
	const { createPostgresClient } = await import("@optimiq-voice/db");
	const { routingCacheKey, ROUTING_CACHE_BUCKET } = await import("@optimiq-voice/routing");
	const { ROUTING_RESOLVE_RPC } = await import("@optimiq-voice/events/schemas");
	const { DID_INDEX_KV, kvKeyFor, QUEUE_MEMBERSHIP_KV } = await import(
		"@optimiq-voice/events/streams"
	);

	const sql = createPostgresClient({
		url: databaseUrl,
		applicationName: "verify-pbx",
		poolMaxConnectionsOverride: 2,
	});

	console.log(`booting the auth slice + PBX area on ${baseUrl}\n`);
	const app = await NestFactory.create(createApiRootModule([], [PbxModule]), new FastifyAdapter(), {
		logger: ["error"],
	});
	app.enableShutdownHooks();
	await registerAuthTransport(app);
	const rpcServed = await registerPbxTransport(app);
	await app.listen(port, "127.0.0.1");
	await delay(200);

	const ownerEmail = `pbx-owner-${RUN_ID}@verify.optimiq.test`;
	const otherEmail = `pbx-other-${RUN_ID}@verify.optimiq.test`;
	const password = "Verify-Pbx-Slice-2026!";
	const jarA = new CookieJar();
	const jarB = new CookieJar();
	const clientA: Client = makeClient(baseUrl, jarA);
	const clientB: Client = makeClient(baseUrl, jarB);
	let organizationA = "";
	let organizationB = "";

	try {
		// --- 0. two tenants ---------------------------------------------------------------------
		console.log("0. two organizations, two owners");
		await clientA("POST", "/api/auth/sign-up/email", {
			name: "PBX Owner A",
			email: ownerEmail,
			password,
		});
		const createA = await clientA("POST", "/api/auth/organization/create", {
			name: `PBX Org A ${RUN_ID}`,
			slug: `pbx-org-a-${RUN_ID}`,
		});
		organizationA = typeof createA.body.id === "string" ? createA.body.id : "";
		await clientA("POST", "/api/auth/organization/set-active", { organizationId: organizationA });
		check("organization A created", organizationA.length > 0, organizationA);

		await clientB("POST", "/api/auth/sign-up/email", {
			name: "PBX Owner B",
			email: otherEmail,
			password,
		});
		const createB = await clientB("POST", "/api/auth/organization/create", {
			name: `PBX Org B ${RUN_ID}`,
			slug: `pbx-org-b-${RUN_ID}`,
		});
		organizationB = typeof createB.body.id === "string" ? createB.body.id : "";
		await clientB("POST", "/api/auth/organization/set-active", { organizationId: organizationB });
		check("organization B created", organizationB.length > 0, organizationB);

		// --- 1. authentication is required ------------------------------------------------------
		console.log("\n1. the area denies by default");
		const anonymous = await fetch(`${baseUrl}/api/v1/extensions`);
		check("an anonymous list is 401", anonymous.status === 401, `status ${anonymous.status}`);

		// --- 2. extensions: the full round trip ---------------------------------------------------
		console.log("\n2. extensions CRUD");
		const extensionA = await clientA("POST", "/api/v1/extensions", {
			number: "1001",
			label: "Alice Nguyen",
			sipSecretRef: "secret://verify/1001",
			tollClass: "international",
		});
		check("create extension 1001 -> 201", extensionA.status === 201, `status ${extensionA.status}`);
		const extensionAId = id(extensionA);
		check("create returns the row with an id", extensionAId.length > 0, extensionAId);
		check(
			"create returns a warnings array in the envelope",
			Array.isArray(extensionA.body.warnings),
			JSON.stringify(warnings(extensionA).map((warning) => warning.code)),
		);

		const extensionB = await clientA("POST", "/api/v1/extensions", {
			number: "1002",
			label: "Ben Okafor",
			sipSecretRef: "secret://verify/1002",
		});
		const extensionBId = id(extensionB);
		await clientA("POST", "/api/v1/extensions", {
			number: "1003",
			label: "Carla Reyes",
			sipSecretRef: "secret://verify/1003",
		});

		const duplicate = await clientA("POST", "/api/v1/extensions", {
			number: "1001",
			label: "Duplicate",
			sipSecretRef: "secret://verify/dup",
		});
		check("a duplicate number is 409", duplicate.status === 409, `status ${duplicate.status}`);
		check("the 409 carries code PBX_CONFLICT", duplicate.body.code === "PBX_CONFLICT");

		const invalidBody = await clientA("POST", "/api/v1/extensions", {
			number: "1004",
			label: "No secret ref",
		});
		check("a missing required field is 400", invalidBody.status === 400);
		check("the 400 carries per-field issues", diagnosticsOrIssues(invalidBody).length > 0);

		const unknownKey = await clientA("POST", "/api/v1/extensions", {
			number: "1005",
			label: "Typo",
			sipSecretRef: "secret://verify/1005",
			recordEnabled: true,
		});
		check(
			"an unknown key is rejected rather than dropped",
			unknownKey.status === 400,
			`status ${unknownKey.status}`,
		);

		const listExtensions = await clientA("GET", "/api/v1/extensions");
		check("list returns 200", listExtensions.status === 200);
		check("list returns three extensions", rows(listExtensions).length === 3);
		check(
			"list carries the paging envelope",
			listExtensions.body.total === 3 &&
				listExtensions.body.page === 1 &&
				listExtensions.body.limit === 20 &&
				listExtensions.body.totalPages === 1,
			JSON.stringify({
				total: listExtensions.body.total,
				page: listExtensions.body.page,
				limit: listExtensions.body.limit,
				totalPages: listExtensions.body.totalPages,
			}),
		);

		const paged = await clientA("GET", "/api/v1/extensions?page=2&limit=2");
		check(
			"page 2 of limit 2 returns the third row and the full total",
			rows(paged).length === 1 && paged.body.total === 3 && paged.body.totalPages === 2,
			`${rows(paged).length} row(s), total ${String(paged.body.total)}`,
		);

		const searched = await clientA("GET", "/api/v1/extensions?search=okafor");
		check(
			"search matches case-insensitively on the label",
			rows(searched).length === 1 && rows(searched)[0]?.number === "1002",
			`${rows(searched).length} row(s)`,
		);

		const gotExtension = await clientA("GET", `/api/v1/extensions/${extensionAId}`);
		check("get returns the row", gotExtension.status === 200 && id(gotExtension) === extensionAId);

		const patched = await clientA("PATCH", `/api/v1/extensions/${extensionAId}`, {
			label: "Alice N.",
			doNotDisturb: true,
		});
		check(
			"patch applies only the supplied keys",
			patched.status === 200 &&
				data(patched).label === "Alice N." &&
				data(patched).doNotDisturb === true &&
				data(patched).tollClass === "international",
			`tollClass ${String(data(patched).tollClass)}`,
		);

		const missing = await clientA("GET", "/api/v1/extensions/019fd3c2-dead-76be-a6b3-b0f1914e39b6");
		check("an unknown id is 404", missing.status === 404, `status ${missing.status}`);
		check("the 404 carries code PBX_NOT_FOUND", missing.body.code === "PBX_NOT_FOUND");

		// --- 3. tenant isolation -------------------------------------------------------------------
		console.log("\n3. RLS isolation between the two organizations");
		const listB = await clientB("GET", "/api/v1/extensions");
		check(
			"organization B sees none of A's extensions",
			listB.status === 200 && rows(listB).length === 0,
			`${rows(listB).length} row(s)`,
		);

		const crossRead = await clientB("GET", `/api/v1/extensions/${extensionAId}`);
		check("B reading A's extension by id is 404", crossRead.status === 404);

		const crossPatch = await clientB("PATCH", `/api/v1/extensions/${extensionAId}`, {
			label: "hijacked",
		});
		check("B patching A's extension is 404", crossPatch.status === 404);

		const crossDelete = await clientB("DELETE", `/api/v1/extensions/${extensionAId}`);
		check("B deleting A's extension is 404", crossDelete.status === 404);

		const stillThere = await clientA("GET", `/api/v1/extensions/${extensionAId}`);
		check(
			"A's extension survived B's attempts",
			stillThere.status === 200 && data(stillThere).label === "Alice N.",
		);

		// B may create its own 1001 — the unique index is per organization.
		const bOwn = await clientB("POST", "/api/v1/extensions", {
			number: "1001",
			label: "B's own 1001",
			sipSecretRef: "secret://verify/b-1001",
		});
		check(
			"B can use the same extension number in its own tenant",
			bOwn.status === 201,
			`status ${bOwn.status}`,
		);

		// --- 4. the rest of the inventory ---------------------------------------------------------
		console.log("\n4. trunks, voicemail boxes, ring groups, IVR menus");
		const trunk = await clientA("POST", "/api/v1/trunks", {
			name: "Demo carrier",
			kind: "ip-auth",
			sipDomain: "sip.demo-carrier.test",
			sipProxy: "sip.demo-carrier.test:5060",
			maxChannels: 30,
		});
		const trunkId = id(trunk);
		check("create trunk -> 201", trunk.status === 201, `status ${trunk.status}`);

		const mailbox = await clientA("POST", "/api/v1/voicemail-boxes", {
			mailboxNumber: "8000",
			label: "General voicemail",
			emailAddress: "voicemail@demo.optimiq.test",
			emailMode: "notify",
		});
		const mailboxId = id(mailbox);
		check("create voicemail box -> 201", mailbox.status === 201, `status ${mailbox.status}`);

		const ringGroup = await clientA("POST", "/api/v1/ring-groups", {
			name: "Sales",
			extensionNumber: "2000",
			strategy: "simultaneous",
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: mailboxId,
		});
		const ringGroupId = id(ringGroup);
		check("create ring group -> 201", ringGroup.status === 201, `status ${ringGroup.status}`);
		check(
			"an empty ring group is saved and warns rather than failing",
			ringGroup.status === 201 &&
				warnings(ringGroup).some((warning) => warning.code === "empty-ring-group"),
			JSON.stringify(warnings(ringGroup).map((warning) => warning.code)),
		);

		const member1 = await clientA("POST", `/api/v1/ring-groups/${ringGroupId}/destinations`, {
			ordinal: 1,
			destinationType: "extension",
			destinationRef: extensionAId,
		});
		check("add a ring-group member -> 201", member1.status === 201, `status ${member1.status}`);
		check(
			"the empty-ring-group warning clears once a member exists",
			!warnings(member1).some((warning) => warning.code === "empty-ring-group"),
			JSON.stringify(warnings(member1).map((warning) => warning.code)),
		);

		await clientA("POST", `/api/v1/ring-groups/${ringGroupId}/destinations`, {
			ordinal: 2,
			destinationType: "extension",
			destinationRef: extensionBId,
		});
		const members = await clientA("GET", `/api/v1/ring-groups/${ringGroupId}/destinations`);
		check("the members list returns both, in ordinal order", rows(members).length === 2);

		const orphanChild = await clientA(
			"GET",
			"/api/v1/ring-groups/019fd3c2-dead-76be-a6b3-b0f1914e39b6/destinations",
		);
		check(
			"a child collection under an unknown parent is 404",
			orphanChild.status === 404,
			`status ${orphanChild.status}`,
		);

		const ivr = await clientA("POST", "/api/v1/ivr-menus", {
			name: "Main menu",
			extensionNumber: "3000",
			directDialEnabled: true,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: mailboxId,
			invalidDestinationType: "voicemail",
			invalidDestinationRef: mailboxId,
		});
		const ivrId = id(ivr);
		check("create IVR menu -> 201", ivr.status === 201, `status ${ivr.status}`);

		const option1 = await clientA("POST", `/api/v1/ivr-menus/${ivrId}/options`, {
			ordinal: 1,
			matchValue: "1",
			label: "Sales",
			destinationType: "ring-group",
			destinationRef: ringGroupId,
		});
		check("add an IVR option -> 201", option1.status === 201, `status ${option1.status}`);

		// --- 5. destination validation ------------------------------------------------------------
		console.log("\n5. destination validation: shape and a real existence check");
		const danglingOption = await clientA("POST", `/api/v1/ivr-menus/${ivrId}/options`, {
			ordinal: 9,
			matchValue: "9",
			destinationType: "ring-group",
			destinationRef: "019fd3c2-dead-76be-a6b3-b0f1914e39b6",
		});
		check(
			"an option pointing at a non-existent ring group is 422",
			danglingOption.status === 422,
			`status ${danglingOption.status}`,
		);
		check(
			"the 422 is PBX_INVALID_DESTINATION and names the field",
			danglingOption.body.code === "PBX_INVALID_DESTINATION" &&
				issuesOf(danglingOption).some((issue) => issue.field === "destinationRef"),
			JSON.stringify(issuesOf(danglingOption)),
		);

		const crossTenantDestination = await clientB("POST", "/api/v1/ring-groups", {
			name: "B points at A",
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: mailboxId,
		});
		check(
			"B cannot point a destination at A's mailbox",
			crossTenantDestination.status === 422,
			`status ${crossTenantDestination.status}`,
		);

		const badShape = await clientA("POST", `/api/v1/ivr-menus/${ivrId}/options`, {
			ordinal: 8,
			matchValue: "8",
			destinationType: "external",
			destinationRef: extensionAId,
		});
		check(
			"a value-backed destination carrying a ref is 422",
			badShape.status === 422,
			`status ${badShape.status}`,
		);

		// --- 6. compile-on-write: the routing entities ---------------------------------------------
		console.log("\n6. routing entities and compile-on-write");
		const timeCondition = await clientA("POST", "/api/v1/time-conditions", {
			name: "Business hours",
			timezone: "America/New_York",
			destinationType: "ivr",
			destinationRef: ivrId,
			nomatchDestinationType: "voicemail",
			nomatchDestinationRef: mailboxId,
		});
		const timeConditionId = id(timeCondition);
		check(
			"create time condition -> 201",
			timeCondition.status === 201,
			`status ${timeCondition.status}`,
		);
		check(
			"a condition with no rules warns rather than failing",
			warnings(timeCondition).some((warning) => warning.code === "empty-time-condition"),
			JSON.stringify(warnings(timeCondition).map((warning) => warning.code)),
		);

		const rule = await clientA("POST", `/api/v1/time-conditions/${timeConditionId}/rules`, {
			ordinal: 1,
			label: "Weekdays 09:00-17:00",
			predicates: [{ weekdays: [1, 2, 3, 4, 5], timeOfDay: { from: "09:00", to: "17:00" } }],
		});
		check("add a time rule -> 201", rule.status === 201, `status ${rule.status}`);

		const badTimezone = await clientA("POST", "/api/v1/time-conditions", {
			name: "Nowhere",
			timezone: "Mars/Olympus_Mons",
			destinationType: "ivr",
			destinationRef: ivrId,
		});
		check(
			"an unknown timezone fails the compile with a 422",
			badTimezone.status === 422 && badTimezone.body.code === "ROUTING_COMPILE_FAILED",
			`status ${badTimezone.status} code ${String(badTimezone.body.code)}`,
		);
		check(
			"the compile 422 carries the unknown-timezone diagnostic",
			diagnostics(badTimezone).some((entry) => entry.code === "unknown-timezone"),
			JSON.stringify(diagnostics(badTimezone).map((entry) => entry.code)),
		);
		const afterBadTimezone = await clientA("GET", "/api/v1/time-conditions?search=Nowhere");
		check(
			"the rejected time condition was ROLLED BACK, not persisted",
			rows(afterBadTimezone).length === 0,
			`${rows(afterBadTimezone).length} row(s) found`,
		);

		const did = await clientA("POST", "/api/v1/phone-numbers", {
			e164: RUN_DID,
			label: "Main line",
			destinationType: "ivr",
			destinationRef: ivrId,
			callerIdNamePrefix: "[Main] ",
		});
		const didId = id(did);
		check("create DID -> 201", did.status === 201, `status ${did.status}`);

		// --- the DID is claimed platform-wide, not per tenant --------------------------------------
		//
		// Two organizations claiming one number is not a configuration choice: an inbound INVITE for
		// it would have to be attributed to one of them with nothing that can decide which, and the
		// loser's calls, recordings and CDRs would be filed under the winner. The constraint lives in
		// the database because that is the only place it is atomic with the write.
		const stolenDid = await clientB("POST", "/api/v1/phone-numbers", {
			e164: RUN_DID,
			label: "Poaching A's number",
			destinationType: "extension",
			destinationRef: id(bOwn),
		});
		check(
			"a second organization claiming the same DID is 409",
			stolenDid.status === 409,
			`status ${stolenDid.status}`,
		);
		check(
			"the 409 says the number is claimed platform-wide, without naming who holds it",
			typeof stolenDid.body.message === "string" &&
				String(stolenDid.body.message).includes("already provisioned on this platform") &&
				!String(stolenDid.body.message).includes(organizationA),
			String(stolenDid.body.message).slice(0, 90),
		);
		const notStolen = await clientB("GET", "/api/v1/phone-numbers");
		check(
			"the refused DID was not written into B",
			rows(notStolen).every((row) => row.e164 !== RUN_DID),
			`${String(rows(notStolen).length)} row(s)`,
		);

		const inbound = await clientA("POST", "/api/v1/inbound-routes", {
			name: "Main line",
			matchKind: "exact",
			matchPattern: RUN_DID,
			phoneNumberId: didId,
			destinationType: "time-condition",
			destinationRef: timeConditionId,
			failoverDestinationType: "voicemail",
			failoverDestinationRef: mailboxId,
		});
		check("create inbound route -> 201", inbound.status === 201, `status ${inbound.status}`);

		const outbound = await clientA("POST", "/api/v1/outbound-routes", {
			name: "National",
			matchKind: "prefix",
			dialPatterns: ["0"],
			stripDigits: 1,
			prependDigits: "+1",
			tollClass: "national",
			trunkPriority: [{ trunkId, order: 1 }],
		});
		const outboundId = id(outbound);
		check("create outbound route -> 201", outbound.status === 201, `status ${outbound.status}`);

		const noTollClass = await clientA("POST", "/api/v1/outbound-routes", {
			name: "Missing toll class",
			dialPatterns: ["9"],
			trunkPriority: [],
		});
		check(
			"an outbound route without a toll class is refused at the DTO",
			noTollClass.status === 400,
			`status ${noTollClass.status}`,
		);

		const featureCode = await clientA("POST", "/api/v1/feature-codes", {
			code: "*97",
			action: "voicemail-check",
			label: "Check my voicemail",
		});
		check("create feature code -> 201", featureCode.status === 201, `status ${featureCode.status}`);

		// `voicemail-direct` takes a REQUIRED argument (`*99` + the mailbox number), so a second code
		// starting with `*99` can never be dialed unambiguously — a compile error, not a warning.
		await clientA("POST", "/api/v1/feature-codes", { code: "*99", action: "voicemail-direct" });
		const conflictingCode = await clientA("POST", "/api/v1/feature-codes", {
			code: "*991",
			action: "redial",
		});
		check(
			"a feature code shadowed by an argument-taking one fails the compile",
			conflictingCode.status === 422 && conflictingCode.body.code === "ROUTING_COMPILE_FAILED",
			`status ${conflictingCode.status} code ${String(conflictingCode.body.code)}`,
		);

		// --- 6b. queues, agents and tiers -----------------------------------------------------------
		console.log("\n6b. queues, agents and tiers");
		const queue = await clientA("POST", "/api/v1/queues", {
			name: "Support",
			extensionNumber: "2100",
			strategy: "longest-idle",
			maxWaitSeconds: 300,
			announcePositionEnabled: true,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: mailboxId,
		});
		const queueId = id(queue);
		check("create queue -> 201", queue.status === 201, `status ${queue.status}`);
		check(
			"the queue kept the values it was given",
			data(queue).maxWaitSeconds === 300 && data(queue).strategy === "longest-idle",
			`maxWaitSeconds ${String(data(queue).maxWaitSeconds)}`,
		);

		const duplicateQueue = await clientA("POST", "/api/v1/queues", { name: "Support" });
		check(
			"a duplicate queue name is 409",
			duplicateQueue.status === 409 && duplicateQueue.body.code === "PBX_CONFLICT",
			`status ${duplicateQueue.status}`,
		);
		check(
			"the 409 echoes the column the unique index is actually on",
			duplicateQueue.body.field === "name",
			`field ${String(duplicateQueue.body.field)}`,
		);

		const unreachableAgent = await clientA("POST", "/api/v1/queue-agents", { name: "Nobody" });
		check(
			"an agent with no way to be dialed is refused at the DTO",
			unreachableAgent.status === 400,
			`status ${unreachableAgent.status}`,
		);

		const agentA = await clientA("POST", "/api/v1/queue-agents", {
			name: "Ben Okafor",
			contactKind: "extension",
			extensionId: extensionBId,
		});
		const agentAId = id(agentA);
		check("create queue agent -> 201", agentA.status === 201, `status ${agentA.status}`);

		const agentB = await clientA("POST", "/api/v1/queue-agents", {
			name: "Overflow line",
			contactKind: "external",
			contact: "+13105550199",
		});
		const agentBId = id(agentB);
		check(
			"an external agent needs only a dial string",
			agentB.status === 201,
			`status ${agentB.status}`,
		);

		const tierA = await clientA("POST", `/api/v1/queues/${queueId}/tiers`, {
			queueAgentId: agentAId,
			level: 1,
			position: 1,
		});
		check("add a queue tier -> 201", tierA.status === 201, `status ${tierA.status}`);
		await clientA("POST", `/api/v1/queues/${queueId}/tiers`, {
			queueAgentId: agentBId,
			level: 2,
			position: 1,
		});
		const tiers = await clientA("GET", `/api/v1/queues/${queueId}/tiers`);
		check(
			"the tier list returns both, lowest level first",
			rows(tiers).length === 2 && rows(tiers)[0]?.level === 1,
			`${rows(tiers).length} row(s)`,
		);

		const duplicateTier = await clientA("POST", `/api/v1/queues/${queueId}/tiers`, {
			queueAgentId: agentAId,
		});
		check(
			"the same agent cannot be tiered into one queue twice",
			duplicateTier.status === 409,
			`status ${duplicateTier.status}`,
		);

		const orphanTier = await clientA(
			"POST",
			"/api/v1/queues/019fd3c2-dead-76be-a6b3-b0f1914e39b6/tiers",
			{ queueAgentId: agentAId },
		);
		check(
			"a tier under an unknown queue is 404",
			orphanTier.status === 404,
			`status ${orphanTier.status}`,
		);

		const tierBAgent = await clientB("POST", "/api/v1/queue-agents", {
			name: "B's agent",
			contactKind: "external",
			contact: "+13105550188",
		});
		check("B may create its own agent", tierBAgent.status === 201, `status ${tierBAgent.status}`);
		const crossTierList = await clientB("GET", `/api/v1/queues/${queueId}/tiers`);
		check(
			"B cannot list A's queue tiers",
			crossTierList.status === 404,
			`status ${crossTierList.status}`,
		);

		// --- 6c. conferences and park lots ----------------------------------------------------------
		console.log("\n6c. conferences and park lots");
		const conference = await clientA("POST", "/api/v1/conferences", {
			name: "Standup",
			roomNumber: "9000",
			maxMembers: 25,
		});
		const conferenceId = id(conference);
		check("create conference -> 201", conference.status === 201, `status ${conference.status}`);

		const pinAttempt = await clientA("POST", "/api/v1/conferences", {
			name: "Board",
			roomNumber: "9001",
			pinHash: "$2b$10$notahash",
		});
		check(
			"a PIN digest cannot be pasted into a conference row",
			pinAttempt.status === 400,
			`status ${pinAttempt.status}`,
		);

		const badRange = await clientA("POST", "/api/v1/park-lots", {
			name: "Backwards",
			slotStart: 720,
			slotEnd: 701,
		});
		check(
			"a park lot whose range ends before it starts is a 400, not a 503",
			badRange.status === 400,
			`status ${badRange.status}`,
		);

		const parkLot = await clientA("POST", "/api/v1/park-lots", {
			name: "Front desk",
			slotStart: 701,
			slotEnd: 720,
			timeoutSeconds: 180,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: mailboxId,
		});
		const parkLotId = id(parkLot);
		check("create park lot -> 201", parkLot.status === 201, `status ${parkLot.status}`);

		// --- 6d. the new entities are routable ------------------------------------------------------
		console.log("\n6d. a queue, a conference and a park lot as destinations");
		const queueOption = await clientA("POST", `/api/v1/ivr-menus/${ivrId}/options`, {
			ordinal: 3,
			matchValue: "3",
			label: "Support queue",
			destinationType: "queue",
			destinationRef: queueId,
		});
		check(
			"an IVR option may now point at a queue — the destination type finally has a CRUD behind it",
			queueOption.status === 201,
			`status ${queueOption.status}`,
		);

		const conferenceOption = await clientA("POST", `/api/v1/ivr-menus/${ivrId}/options`, {
			ordinal: 4,
			matchValue: "4",
			label: "Standup",
			destinationType: "conference",
			destinationRef: conferenceId,
		});
		check(
			"an IVR option may point at a conference",
			conferenceOption.status === 201,
			`status ${conferenceOption.status}`,
		);

		const parkOption = await clientA("POST", `/api/v1/ivr-menus/${ivrId}/options`, {
			ordinal: 5,
			matchValue: "5",
			label: "Park",
			destinationType: "park",
			destinationRef: parkLotId,
		});
		check(
			"an IVR option may point at a park lot",
			parkOption.status === 201,
			`status ${parkOption.status}`,
		);

		const parkCode = await clientA("POST", "/api/v1/feature-codes", {
			code: "*5",
			action: "call-park",
			params: { lotId: parkLotId },
		});
		check(
			"a call-park code may pin a lot — the one parameter the compiler reads",
			parkCode.status === 201,
			`status ${parkCode.status}`,
		);
		const strayParam = await clientA("POST", "/api/v1/feature-codes", {
			code: "*70",
			action: "redial",
			params: { lotId: parkLotId },
		});
		check(
			"a parameter on an action that reads none is refused rather than stored",
			strayParam.status === 400,
			`status ${strayParam.status}`,
		);
		const paramFields = await clientA("GET", "/api/v1/feature-codes/param-fields");
		check(
			"the API describes each action's parameters so a form can render them",
			paramFields.status === 200 &&
				Array.isArray((data(paramFields)["call-park"] as unknown[] | undefined) ?? undefined),
			`status ${paramFields.status}`,
		);

		const deleteBusyLot = await clientA("DELETE", `/api/v1/park-lots/${parkLotId}`);
		check(
			"deleting a lot a feature code pins is 409, not a compile failure two saves later",
			deleteBusyLot.status === 409 &&
				references(deleteBusyLot).some((entry) => entry.field === "params.lotId"),
			`status ${deleteBusyLot.status} ${JSON.stringify(references(deleteBusyLot))}`,
		);

		// --- 6e. reorder ----------------------------------------------------------------------------
		console.log("\n6e. PUT …/options/reorder");
		const optionsBefore = await clientA("GET", `/api/v1/ivr-menus/${ivrId}/options`);
		const optionIds = rows(optionsBefore).map((row) => String(row.id));
		check("the menu has four options to reorder", optionIds.length === 4, `${optionIds.length}`);

		const reversed = [...optionIds].reverse();
		const reordered = await clientA("PUT", `/api/v1/ivr-menus/${ivrId}/options/reorder`, {
			ids: reversed,
		});
		check("reorder -> 200", reordered.status === 200, `status ${reordered.status}`);
		check(
			"the reorder returns the collection in the order it was asked for",
			rows(reordered)
				.map((row) => String(row.id))
				.join(",") === reversed.join(","),
			rows(reordered)
				.map((row) => String(row.ordinal))
				.join(","),
		);
		check(
			"ordinals were rewritten to 0…n-1 rather than left with gaps",
			rows(reordered)
				.map((row) => Number(row.ordinal))
				.join(",") === "0,1,2,3",
			rows(reordered)
				.map((row) => String(row.ordinal))
				.join(","),
		);
		const optionsAfter = await clientA("GET", `/api/v1/ivr-menus/${ivrId}/options`);
		check(
			"a fresh read agrees with what the reorder returned",
			rows(optionsAfter)
				.map((row) => String(row.id))
				.join(",") === reversed.join(","),
		);

		const shortOrder = await clientA("PUT", `/api/v1/ivr-menus/${ivrId}/options/reorder`, {
			ids: reversed.slice(0, 2),
		});
		check(
			"a partial order is refused rather than silently moving the rows nobody mentioned",
			shortOrder.status === 400 && shortOrder.body.code === "PBX_VALIDATION_FAILED",
			`status ${shortOrder.status} code ${String(shortOrder.body.code)}`,
		);
		const duplicatedOrder = await clientA("PUT", `/api/v1/ivr-menus/${ivrId}/options/reorder`, {
			ids: [reversed[0] as string, ...reversed.slice(1), reversed[0] as string],
		});
		check(
			"an order that repeats an id is refused",
			duplicatedOrder.status === 400,
			`status ${duplicatedOrder.status}`,
		);
		const stillFour = await clientA("GET", `/api/v1/ivr-menus/${ivrId}/options`);
		check(
			"a refused reorder changed nothing",
			rows(stillFour)
				.map((row) => String(row.id))
				.join(",") === reversed.join(","),
		);

		// --- 6f. null resets a defaulted column -----------------------------------------------------
		console.log("\n6f. null on a defaulted numeric column means 'use the default'");
		const beforeReset = await clientA("GET", `/api/v1/queues/${queueId}`);
		check(
			"the queue still holds the non-default value it was created with",
			data(beforeReset).maxWaitSeconds === 300,
			String(data(beforeReset).maxWaitSeconds),
		);
		const reset = await clientA("PATCH", `/api/v1/queues/${queueId}`, { maxWaitSeconds: null });
		check(
			"a null on a notNull-with-default column is accepted, not a 503",
			reset.status === 200,
			`status ${reset.status}`,
		);
		check(
			"it reset to the schema default (0) rather than writing NULL",
			data(reset).maxWaitSeconds === 0,
			String(data(reset).maxWaitSeconds),
		);
		const clearNullable = await clientA("PATCH", `/api/v1/queues/${queueId}`, {
			extensionNumber: null,
		});
		check(
			"a null on a genuinely nullable column still clears to NULL",
			clearNullable.status === 200 && data(clearNullable).extensionNumber === null,
			String(data(clearNullable).extensionNumber),
		);

		const simulateQueue = await clientA("POST", "/api/v1/routing/simulate", {
			routingContext: "internal",
			destinationNumber: "*5",
			callerNumber: "1002",
			at: "2026-08-05T19:00:00.000Z",
		});
		check(
			"the pinned park lot resolves through its feature code",
			data(simulateQueue).destinationType === "feature-code",
			String(data(simulateQueue).destinationType),
		);

		// --- 7. referenced deletes ------------------------------------------------------------------
		console.log("\n7. deletes that would leave a dangling pointer");
		const deleteRingGroup = await clientA("DELETE", `/api/v1/ring-groups/${ringGroupId}`);
		check(
			"deleting a ring group an IVR option targets is 409",
			deleteRingGroup.status === 409,
			`status ${deleteRingGroup.status}`,
		);
		check(
			"the 409 is PBX_REFERENCED and names the referring IVR option",
			deleteRingGroup.body.code === "PBX_REFERENCED" &&
				references(deleteRingGroup).some((entry) => entry.kind === "ivr-menu-option"),
			JSON.stringify(references(deleteRingGroup)),
		);

		const deleteTrunk = await clientA("DELETE", `/api/v1/trunks/${trunkId}`);
		check(
			"deleting a trunk an outbound route lists is 409",
			deleteTrunk.status === 409,
			`status ${deleteTrunk.status}`,
		);
		check(
			"the trunk 409 names the outbound route from the JSONB list",
			references(deleteTrunk).some((entry) => entry.id === outboundId),
			JSON.stringify(references(deleteTrunk)),
		);

		const deleteTimeCondition = await clientA(
			"DELETE",
			`/api/v1/time-conditions/${timeConditionId}`,
		);
		check(
			"deleting a time condition a route gates on is 409",
			deleteTimeCondition.status === 409,
			`status ${deleteTimeCondition.status}`,
		);

		const deleteFreeExtension = await clientA(
			"DELETE",
			"/api/v1/extensions/" + (await freeExtensionId(clientA)),
		);
		check(
			"an unreferenced extension deletes cleanly",
			deleteFreeExtension.status === 200,
			`status ${deleteFreeExtension.status}`,
		);

		// --- 8. compile and simulate -----------------------------------------------------------------
		console.log("\n8. compile and simulate");
		const compiled = await clientA("POST", "/api/v1/routing/compile");
		check("POST /routing/compile -> 200", compiled.status === 200, `status ${compiled.status}`);
		const expectedKey = routingCacheKey(organizationA);
		check(
			"the compile reports the cache key packages/routing specifies",
			data(compiled).cacheKey === expectedKey,
			`${String(data(compiled).cacheKey)} vs ${expectedKey}`,
		);
		check(
			"the compile reports a snapshot hash",
			typeof data(compiled).snapshotHash === "string" &&
				(data(compiled).snapshotHash as string).length === 64,
		);

		const simulateOpen = await clientA("POST", "/api/v1/routing/simulate", {
			routingContext: "inbound",
			destinationNumber: RUN_DID,
			callerNumber: "+13105550111",
			// A Wednesday at 14:00 New York = 19:00Z.
			at: "2026-08-05T19:00:00.000Z",
		});
		check(
			"simulate inside business hours reaches the IVR",
			simulateOpen.status === 200 &&
				data(simulateOpen).matched === true &&
				data(simulateOpen).destinationType === "ivr-menu",
			`${String(data(simulateOpen).destinationType)} / ${String(data(simulateOpen).destinationRef)}`,
		);
		check(
			"the resolved IVR is the one that was created",
			data(simulateOpen).destinationRef === ivrId,
			String(data(simulateOpen).destinationRef),
		);
		check(
			"destinationType is the compiler's own kebab-case vocabulary, untranslated",
			data(simulateOpen).destinationType === "ivr-menu",
			String(data(simulateOpen).destinationType),
		);

		const simulateClosed = await clientA("POST", "/api/v1/routing/simulate", {
			routingContext: "inbound",
			destinationNumber: RUN_DID,
			// The same Wednesday at 03:00 New York = 07:00Z — outside the window.
			at: "2026-08-05T07:00:00.000Z",
		});
		check(
			"simulate outside business hours reaches voicemail",
			data(simulateClosed).destinationType === "voicemail" &&
				data(simulateClosed).destinationRef === mailboxId,
			`${String(data(simulateClosed).destinationType)} / ${String(data(simulateClosed).destinationRef)}`,
		);

		const simulateUnknown = await clientA("POST", "/api/v1/routing/simulate", {
			routingContext: "inbound",
			destinationNumber: "+19995550000",
			at: "2026-08-05T19:00:00.000Z",
		});
		check(
			"an unrouted DID does not match",
			data(simulateUnknown).matched === false,
			String(data(simulateUnknown).matched),
		);

		const simulateOutbound = await clientA("POST", "/api/v1/routing/simulate", {
			routingContext: "outbound",
			destinationNumber: "03105550123",
			callerNumber: "1002",
			at: "2026-08-05T19:00:00.000Z",
		});
		check(
			"an outbound call from a national extension reaches the trunk",
			data(simulateOutbound).matched === true &&
				data(simulateOutbound).destinationType === "trunk-dial",
			`${String(data(simulateOutbound).destinationType)} reason ${String(data(simulateOutbound).reason)}`,
		);
		check(
			"digit manipulation applied strip-then-prepend",
			data(simulateOutbound).dialedNumber === "+13105550123",
			String(data(simulateOutbound).dialedNumber),
		);

		const simulateBarred = await clientA("POST", "/api/v1/routing/simulate", {
			routingContext: "outbound",
			destinationNumber: "03105550123",
			// 1003 is `local`, which does not cover a `national` route.
			callerNumber: "1003",
			at: "2026-08-05T19:00:00.000Z",
		});
		check(
			"a local-class extension is barred from the national route",
			data(simulateBarred).matched === false,
			`matched ${String(data(simulateBarred).matched)} reason ${String(data(simulateBarred).reason)}`,
		);

		const simulateFeatureCode = await clientA("POST", "/api/v1/routing/simulate", {
			routingContext: "internal",
			destinationNumber: "*97",
			callerNumber: "1002",
			at: "2026-08-05T19:00:00.000Z",
		});
		check(
			"a feature code resolves in the internal context",
			data(simulateFeatureCode).destinationType === "feature-code",
			String(data(simulateFeatureCode).destinationType),
		);

		const simulateB = await clientB("POST", "/api/v1/routing/simulate", {
			routingContext: "inbound",
			destinationNumber: RUN_DID,
			at: "2026-08-05T19:00:00.000Z",
		});
		check(
			"B's simulation of A's DID does not match — the artifact is per tenant",
			data(simulateB).matched === false,
			String(data(simulateB).matched),
		);

		// --- 9. the NATS half -------------------------------------------------------------------------
		if (nats === undefined) {
			console.log("\n9. NATS checks SKIPPED (docker unavailable)");
		} else {
			console.log("\n9. routing-cache KV and rpc.routing.v1.resolve");
			check("the resolve rpc was registered at boot", rpcServed, String(rpcServed));

			const { connect } = await import("nats");
			const { ClientProxyFactory, Transport } = await import("@nestjs/microservices");
			const { firstValueFrom } = await import("rxjs");
			const connection = await connect({ servers: nats.url, name: "verify-pbx" });

			/**
			 * The rpc is driven through a NestJS `ClientProxy`, not a raw `connection.request`.
			 *
			 * That is not convenience — it is the contract. Nest's NATS transport does request-reply
			 * with its own envelope (`{ pattern, data, id }`), and its server treats a message with
			 * **no `id`** as a fire-and-forget event and never replies. A raw request therefore times
			 * out against a perfectly healthy responder, and `apps/engine` — which speaks the same
			 * transport, per plan §3.5 — would not. Using the client the engine uses is what makes
			 * this check mean something.
			 */
			const rpcClient = ClientProxyFactory.create({
				transport: Transport.NATS,
				options: { servers: [nats.url], name: "verify-pbx-rpc" },
			});
			await rpcClient.connect();

			try {
				const manager = await connection.jetstreamManager();
				const bucket = await manager.jetstream().views.kv(ROUTING_CACHE_BUCKET);
				const entry = await bucket.get(expectedKey);
				check("the artifact is in the routing-cache bucket", entry !== null, expectedKey);

				if (entry !== null) {
					const artifact = JSON.parse(new TextDecoder().decode(entry.value)) as {
						organizationId: string;
						snapshotHash: string;
						artifactVersion: number;
					};
					check(
						"the cached artifact belongs to organization A",
						artifact.organizationId === organizationA,
						artifact.organizationId,
					);
					check(
						"the cached artifact matches the hash the compile reported",
						artifact.snapshotHash === data(compiled).snapshotHash,
						`${artifact.snapshotHash} vs ${String(data(compiled).snapshotHash)}`,
					);
					check(
						"the cached artifact carries a version",
						typeof artifact.artifactVersion === "number",
						String(artifact.artifactVersion),
					);
				}

				// --- the queue-membership bucket ---------------------------------------------------
				//
				// The ACD's read model: the roster `apps/engine` distributes every queued caller
				// against. It rides on the `onMutation` seam rather than on `onArtifactCompiled`,
				// because `queue_agent` and `queue_tier` are deliberately NOT routing inputs — so the
				// interesting assertion is that a tier write, which recompiles NOTHING, still reaches
				// the bucket.
				const rosterBucket = await manager.jetstream().views.kv(QUEUE_MEMBERSHIP_KV.name);
				const rosterKey = kvKeyFor.queueMembership(organizationA, queueId);
				await delay(600);
				const rosterEntry = await rosterBucket.get(rosterKey);
				check("the queue has a roster in the queue-membership bucket", rosterEntry !== null, rosterKey);

				interface RosterValue {
					readonly orgId?: string;
					readonly queueId?: string;
					readonly wrapUpSeconds?: number;
					readonly tierRulesApply?: boolean;
					readonly revision?: number;
					readonly agents?: {
						readonly agentId: string;
						readonly contact: string;
						readonly contactKind: string;
						readonly level: number;
						readonly position: number;
						readonly enabled: boolean;
					}[];
				}
				const readRoster = async (key: string): Promise<RosterValue | undefined> => {
					const entry = await rosterBucket.get(key);
					return entry === null || entry.value.length === 0
						? undefined
						: (JSON.parse(new TextDecoder().decode(entry.value)) as RosterValue);
				};

				const roster = await readRoster(rosterKey);
				check(
					"the roster names the tenant and the queue it belongs to",
					roster?.orgId === organizationA && roster.queueId === queueId,
					`${String(roster?.orgId)} / ${String(roster?.queueId)}`,
				);
				check(
					"the roster holds both tiered agents, ordered by level",
					roster?.agents?.length === 2 &&
						roster.agents[0]?.agentId === agentAId &&
						roster.agents[1]?.agentId === agentBId,
					JSON.stringify(roster?.agents?.map((agent) => [agent.agentId, agent.level]) ?? []),
				);
				check(
					"an extension agent's contact is a resolved DIAL STRING, not an extension id",
					roster?.agents?.[0]?.contact === "PJSIP/1002",
					String(roster?.agents?.[0]?.contact),
				);
				check(
					"an external agent's dial string is passed through untouched",
					roster?.agents?.[1]?.contact === "+13105550199" &&
						roster.agents[1]?.contactKind === "external",
					String(roster?.agents?.[1]?.contact),
				);
				check(
					"the roster carries the tier rules, which are meaningless without the tiers",
					typeof roster?.tierRulesApply === "boolean" &&
						typeof roster.wrapUpSeconds === "number",
					`tierRulesApply=${String(roster?.tierRulesApply)} wrapUp=${String(roster?.wrapUpSeconds)}`,
				);

				// An agent's CONTACT changing is the case the projection exists for: the roster holds
				// a dial string derived from `extension.number`, so a renumber moves every queue that
				// agent serves — and nothing about the queue itself was touched.
				await clientA("PATCH", `/api/v1/extensions/${extensionBId}`, { number: "1502" });
				await delay(600);
				const renumbered = await readRoster(rosterKey);
				check(
					"renumbering an extension republishes the rosters that dial it",
					renumbered?.agents?.[0]?.contact === "PJSIP/1502",
					String(renumbered?.agents?.[0]?.contact),
				);
				check(
					"…and advances the revision the engine logs",
					(renumbered?.revision ?? 0) > (roster?.revision ?? 0),
					`${String(roster?.revision)} -> ${String(renumbered?.revision)}`,
				);

				// Removing a membership is a `queue_tier` delete, which recompiles nothing at all.
				const tierList = await clientA("GET", `/api/v1/queues/${queueId}/tiers`);
				const firstTierId = typeof rows(tierList)[0]?.id === "string" ? String(rows(tierList)[0]?.id) : "";
				await clientA("DELETE", `/api/v1/queues/${queueId}/tiers/${firstTierId}`);
				await delay(600);
				const afterTierDelete = await readRoster(rosterKey);
				check(
					"removing a tier takes the seat out of the roster",
					afterTierDelete?.agents?.length === 1,
					`${String(afterTierDelete?.agents?.length)} seat(s)`,
				);

				// Disabling an agent keeps the seat with `enabled: false` — the engine skips it and a
				// wallboard greys it, which "not in the roster" cannot express.
				await clientA("PATCH", `/api/v1/queue-agents/${agentBId}`, { enabled: false });
				await delay(600);
				const afterDisable = await readRoster(rosterKey);
				check(
					"a disabled agent stays in the roster, marked disabled",
					afterDisable?.agents?.length === 1 && afterDisable.agents[0]?.enabled === false,
					JSON.stringify(afterDisable?.agents ?? []),
				);

				const otherRoster = await rosterBucket.get(
					kvKeyFor.queueMembership(organizationB, queueId),
				);
				check(
					"another tenant has no entry under this queue's id",
					otherRoster === null || otherRoster.value.length === 0,
				);

				// --- the did-index bucket ---------------------------------------------------------
				//
				// THE multi-tenant inbound lookup: an INVITE arrives with a dialled number and nothing
				// that says whose it is, and this is what answers. Written after the commit by
				// `DidIndexPublisher`, read per call by the engine.
				const didBucket = await manager.jetstream().views.kv(DID_INDEX_KV.name);
				const didKey = kvKeyFor.didIndex(RUN_DID);
				const didEntry = await didBucket.get(didKey);
				check("the DID is in the did-index bucket", didEntry !== null, didKey);

				if (didEntry !== null) {
					const indexed = JSON.parse(new TextDecoder().decode(didEntry.value)) as {
						organizationId?: string;
						phoneNumberId?: string;
						e164?: string;
					};
					check(
						"the did-index entry names the organization that owns the number",
						indexed.organizationId === organizationA,
						String(indexed.organizationId),
					);
					check(
						"the did-index entry names the phone_number row",
						indexed.phoneNumberId === didId,
						`${String(indexed.phoneNumberId)} vs ${didId}`,
					);
					check(
						"the did-index entry keeps the E.164 as stored, punctuation and all",
						indexed.e164 === RUN_DID,
						String(indexed.e164),
					);
				}

				// The key is the DIGITS of the number, so the form the control plane stores and the
				// form a carrier delivers land on one entry. A lookup that only worked for one of them
				// would work on a developer box and miss in production.
				check(
					"the dialled form of the number resolves to the same key",
					kvKeyFor.didIndex(RUN_DID.replace("+", "")) === didKey &&
						kvKeyFor.didIndex(`${RUN_DID.slice(0, 2)} (${RUN_DID.slice(2, 5)}) ${RUN_DID.slice(5)}`) ===
							didKey,
					didKey,
				);

				const request = {
					orgId: organizationA,
					direction: "inbound" as const,
					destinationNumber: RUN_DID,
					callerNumber: "+13105550111",
					routingContext: "inbound",
					at: "2026-08-05T19:00:00.000Z",
				};
				const answer = (await firstValueFrom(
					rpcClient.send<Record<string, unknown>>(ROUTING_RESOLVE_RPC.subject, request),
				)) as Record<string, unknown>;
				check("rpc.routing.v1.resolve replied", typeof answer === "object" && answer !== null);
				check("the rpc reply matched", answer.matched === true, JSON.stringify(answer.matched));
				check(
					"the rpc reply names the IVR in kebab-case",
					answer.destinationType === "ivr-menu" && answer.destinationRef === ivrId,
					`${String(answer.destinationType)} / ${String(answer.destinationRef)}`,
				);
				check(
					"the rpc reply carries the cache key and a TTL",
					answer.cacheKey === expectedKey && typeof answer.ttlMs === "number",
					`${String(answer.cacheKey)} ttl ${String(answer.ttlMs)}`,
				);
				check("the rpc reply carries the artifact", typeof answer.artifact === "object");

				const parsedReply = ROUTING_RESOLVE_RPC.response.safeParse(answer);
				check(
					"the rpc reply satisfies routingResolveResponseSchema",
					parsedReply.success,
					parsedReply.success ? "" : JSON.stringify(parsedReply.error.issues.slice(0, 3)),
				);

				const malformedAnswer = (await firstValueFrom(
					rpcClient.send<Record<string, unknown>>(ROUTING_RESOLVE_RPC.subject, {
						orgId: "not-a-uuid",
					}),
				)) as Record<string, unknown>;
				check(
					"a malformed rpc request is answered, not dropped",
					malformedAnswer.matched === false && typeof malformedAnswer.reason === "string",
					String(malformedAnswer.reason).slice(0, 60),
				);
				// --- voicemail: the engine's fact becomes a mailbox row ---------------------------
				//
				// The engine records the audio and publishes `voicemail.message.left`; this asserts the
				// other half — the durable consumer that files it and answers with the box's counts.
				// Published exactly as the engine publishes it, so the two halves are proven against one
				// contract rather than against each other's assumptions.
				const { makeVoicemailEvent } = await import("@optimiq-voice/events/schemas");
				const { createEntityId } = await import("@optimiq-voice/identifiers");
				const messageId = createEntityId();
				const messageEnvelope = makeVoicemailEvent("message.left", {
					orgId: organizationA,
					mailboxId,
					source: "engine",
					data: {
						messageId,
						mailboxNumber: "8000",
						callId: createEntityId(),
						legId: createEntityId(),
						recordingId: createEntityId(),
						objectKey: `voicemail/${RUN_ID}/message.wav`,
						durationMs: 8_200,
						callerIdNumber: "+15551234567",
						callerIdName: "Ada",
						receivedAt: new Date().toISOString(),
					},
				});

				const mwiSubscription = connection.subscribe(`voicemail.evt.v1.${organizationA}.>`);
				const mwiSeen: Record<string, unknown>[] = [];
				void (async () => {
					for await (const raw of mwiSubscription) {
						const decoded = JSON.parse(new TextDecoder().decode(raw.data)) as {
							type?: string;
							data?: Record<string, unknown>;
						};
						if (decoded.type === "mwi.updated" && decoded.data !== undefined) {
							mwiSeen.push(decoded.data);
						}
					}
				})();

				await connection
					.jetstream()
					.publish(
						messageEnvelope.subject,
						new TextEncoder().encode(JSON.stringify(messageEnvelope)),
						{ msgID: messageEnvelope.id },
					);
				// Published twice, deliberately: a redelivery is what JetStream guarantees, and one row
				// is what the mailbox has to end up with.
				await connection
					.jetstream()
					.publish(
						messageEnvelope.subject,
						new TextEncoder().encode(JSON.stringify(messageEnvelope)),
						{ msgID: `${messageEnvelope.id}-retry` },
					);

				const { createPbxDatabaseClient: openPbx, sql: pbxQuery } = await import(
					"@optimiq-voice/pbx-db"
				);
				const pbxRead = openPbx({
					url: pbxDatabaseUrl,
					applicationName: "verify-pbx-voicemail",
					poolMaxConnectionsOverride: 2,
				});
				try {
					let filed: Record<string, unknown>[] = [];
					for (let attempt = 0; attempt < 30 && filed.length === 0; attempt += 1) {
						await delay(200);
						filed = (await pbxRead.withTenantScope(organizationA, async (transaction) => {
							const result = await transaction.execute(
								pbxQuery`select "id", "voicemail_box_id", "folder", "duration_ms", "object_key",
									"caller_id_number", "call_leg_ref"
									from "voicemail_message" where "id" = ${messageId}::uuid`,
							);
							return (
								Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
							) as Record<string, unknown>[];
						})) as Record<string, unknown>[];
					}

					check("the voicemail message was filed into pbx-db", filed.length === 1, `${String(filed.length)} row(s)`);
					check(
						"the row names the box, the folder and the audio the engine recorded",
						filed[0]?.voicemail_box_id === mailboxId &&
							filed[0]?.folder === "new" &&
							filed[0]?.duration_ms === 8200 &&
							String(filed[0]?.object_key).includes(RUN_ID),
						JSON.stringify(filed[0] ?? {}).slice(0, 140),
					);

					const duplicated = (await pbxRead.withTenantScope(organizationA, async (transaction) => {
						const result = await transaction.execute(
							pbxQuery`select count(*)::int as "total" from "voicemail_message"
								where "voicemail_box_id" = ${mailboxId}::uuid`,
						);
						return (
							Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
						) as { total: number }[];
					})) as { total: number }[];
					check(
						"a redelivered message files ONE row, not two copies of one voicemail",
						duplicated[0]?.total === 1,
						String(duplicated[0]?.total),
					);

					for (let attempt = 0; attempt < 25 && mwiSeen.length === 0; attempt += 1) {
						await delay(200);
					}
					check("an MWI update was published for the box", mwiSeen.length > 0, String(mwiSeen.length));
					check(
						"the MWI update carries absolute counts, not a delta",
						mwiSeen[0]?.newCount === 1 && mwiSeen[0]?.savedCount === 0,
						JSON.stringify(mwiSeen[0] ?? {}),
					);
				} finally {
					mwiSubscription.unsubscribe();
					await pbxRead.close();
				}

				// Releasing a number must take its index entry with it, or the next tenant to be sold
				// that DID inherits calls routed to the previous one.
				const releaseTarget = await clientA("POST", "/api/v1/phone-numbers", {
					e164: SPARE_DID,
					label: "Spare line",
					destinationType: "extension",
					destinationRef: extensionAId,
				});
				check("create a second DID -> 201", releaseTarget.status === 201);
				await delay(300);
				const spareKey = kvKeyFor.didIndex(SPARE_DID);
				check(
					"the second DID is indexed too",
					(await didBucket.get(spareKey)) !== null,
					spareKey,
				);

				const released = await clientA("DELETE", `/api/v1/phone-numbers/${id(releaseTarget)}`);
				check("delete the second DID -> 200", released.status === 200, `status ${released.status}`);
				await delay(300);
				const afterRelease = await didBucket.get(spareKey);
				check(
					"releasing a DID removes its did-index entry",
					afterRelease === null || afterRelease.value.length === 0,
					spareKey,
				);
			} finally {
				await rpcClient.close();
				await connection.drain();
			}
		}
	} finally {
		console.log("\ncleaning up");
		try {
			await app.close();
			if (organizationA) {
				await sql`delete from "organization" where "id" = ${organizationA}`;
			}
			if (organizationB) {
				await sql`delete from "organization" where "id" = ${organizationB}`;
			}
			await sql`delete from "user" where "email" in (${ownerEmail}, ${otherEmail})`;
			// The PBX rows are in the other database and carry no FK to the organization, so they
			// have to be removed explicitly or every run leaves a tenant behind.
			const { createPbxDatabaseClient, sql: pbxSql } = await import("@optimiq-voice/pbx-db");
			const pbx = createPbxDatabaseClient({
				url: pbxDatabaseUrl,
				applicationName: "verify-pbx-cleanup",
				poolMaxConnectionsOverride: 2,
			});
			try {
				for (const organizationId of [organizationA, organizationB].filter(Boolean)) {
					await pbx.withTenantScope(organizationId, async (transaction) => {
						for (const table of [
							"inbound_route",
							"outbound_route",
							"phone_number",
							"ivr_menu_option",
							"ivr_menu",
							"ring_group_destination",
							"ring_group",
							"queue_tier",
							"queue_agent",
							"queue",
							"park_lot",
							"conference",
							"time_condition_rule",
							"time_condition",
							"feature_code",
							"voicemail_box",
							"extension",
							"trunk",
						]) {
							await transaction.execute(pbxSql`delete from ${pbxSql.identifier(table)}`);
						}
					});
				}
			} finally {
				await pbx.close();
			}
		} catch (error) {
			console.error("cleanup failed", error);
		}
		await sql.end({ timeout: 5 });
		if (nats !== undefined) {
			await stopNats(nats);
		}
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.error(`FAILED: ${failed.map((entry) => entry.name).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log("PBX area verification PASSED");
}

/** `issues` on a 400/422 body, whichever the failure used. */
function issuesOf(response: JsonResponse): { field?: string; code?: string }[] {
	const value = response.body.issues;
	return Array.isArray(value) ? (value as { field?: string; code?: string }[]) : [];
}

function diagnosticsOrIssues(response: JsonResponse): unknown[] {
	return [...issuesOf(response), ...diagnostics(response)];
}

/** An extension nothing points at, for the "a clean delete works" case. */
async function freeExtensionId(client: Client): Promise<string> {
	const list = await client("GET", "/api/v1/extensions?search=Carla");
	const first = rows(list)[0];
	return typeof first?.id === "string" ? first.id : "";
}

await main();
