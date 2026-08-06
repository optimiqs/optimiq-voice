/**
 * End-to-end verification of the Telnyx carrier integration (decision D5).
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/api verify:carrier
 *
 * It boots the real HTTP slice — `createApiRootModule([], [PbxModule])` against a real PostgreSQL —
 * **twice**, and points it at the in-package fake Telnyx (`@optimiq-voice/telnyx/fake`) through the
 * `TELNYX_API_BASE` override.
 *
 * ## Why twice
 *
 * The unconfigured deployment is a first-class supported state, not an error case: `TELNYX_API_KEY`
 * is absent on every developer machine and every CI runner, and the promise is that the carrier
 * endpoints answer 503 with a code the UI can render while **nothing else changes**. That promise
 * is only testable on a process that genuinely booted without a key — the client is constructed
 * once, in a provider factory, so flipping an environment variable mid-run would prove nothing. So
 * phase A boots with no key and asserts the degraded surface; phase B boots with one and asserts
 * the real flows.
 *
 * ## What it proves, in order
 *
 *  A1. Without a key: every carrier endpoint is 503 `CARRIER_NOT_CONFIGURED`, the webhook receiver
 *      refuses rather than accepting unverifiable deliveries, and ordinary PBX CRUD is untouched.
 *  B1. Search reaches the carrier and is reshaped into our vocabulary (no Telnyx field names on the
 *      wire).
 *  B2. Ordering a number that was never searched is refused with the carrier's own `85000` — the
 *      two-step protocol Telnyx enforces.
 *  B3. Ordering a searched number creates a `phone_number` row THROUGH the slice service, so the
 *      global-uniqueness index, compile-on-write and the `did-index` KV publish all happen.
 *  B4. The same number cannot be bought twice.
 *  B5. Trunk provisioning creates a profile and a connection at the carrier and writes real SIP
 *      credentials into the trunk row; re-provisioning updates in place and rotates the password.
 *  B6. A DID can be pointed at a provisioned trunk, and cannot be pointed at a BYO-SIP one.
 *  B7. Release deletes the row AND gives the number back; the plain delete deliberately does not.
 *  B8. Webhook signatures are verified for real: a genuine Ed25519 signature is accepted, and a
 *      tampered body, a wrong key, a missing header and a stale timestamp are each rejected.
 *
 * The NATS half (did-index) is skipped, loudly, when Docker is unavailable — same as `verify:pbx`.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
/** Shared with `verify-pbx.ts`: better-auth encrypts its JWKS with this and stores them in the DB. */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const RUN_ID = Date.now().toString(36);

// ---------------------------------------------------------------------------------------------
// Harness — same shape as verify-pbx.ts, deliberately
// ---------------------------------------------------------------------------------------------

/**
 * The one rejection this harness swallows, and why it is not a blanket suppressor.
 *
 * `PbxModule` publishes the compiled artifact and the DID index with `void publisher.publish(...)`
 * — deliberately fire-and-forget, so a broker outage degrades the routing cache rather than the
 * API. Neither call attaches a `.catch()`, so shutting the application down while one is in flight
 * turns NATS's `CONNECTION_DRAINING` into an unhandled rejection and kills this process before it
 * can report. Matching on that exact code keeps every other unhandled rejection fatal, which is
 * what a verification script needs. The missing `.catch()` is recorded as a follow-up; it belongs
 * to the publisher, not to this file.
 */
process.on("unhandledRejection", (reason) => {
	if (reason instanceof Error && /CONNECTION_DRAINING/u.test(reason.message)) {
		console.log("  (ignored a CONNECTION_DRAINING rejection from a fire-and-forget publish)");
		return;
	}
	throw reason;
});

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

function carrier(response: JsonResponse): Record<string, unknown> {
	const value = response.body.carrier;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function warningCodes(response: JsonResponse): string[] {
	const value = response.body.warnings;
	return Array.isArray(value)
		? (value as { code?: string }[]).map((entry) => String(entry.code))
		: [];
}

function carrierErrorCodes(response: JsonResponse): string[] {
	const value = response.body.carrierErrors;
	return Array.isArray(value)
		? (value as { code?: string }[]).map((entry) => String(entry.code))
		: [];
}

// ---------------------------------------------------------------------------------------------
// Docker-managed NATS
// ---------------------------------------------------------------------------------------------

interface NatsHandle {
	readonly url: string;
	readonly containerId: string;
}

const NATS_CONTAINER_PREFIX = "optimiq-verify-carrier";

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
			console.log(`  (removed ${stale.length} stale verify-carrier NATS container(s))`);
		}
	} catch {
		// No docker, or nothing to sweep.
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
		await delay(1500);
		return { url: `nats://127.0.0.1:${port}`, containerId: stdout.trim() };
	} catch (error) {
		console.log(
			`  (docker unavailable — did-index checks will be skipped: ${
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

	/**
	 * One port for both phases.
	 *
	 * `@optimiq-voice/config` parses the environment at IMPORT time, so `AUTH_URL` has to be its
	 * final value before the first dynamic import below — which means it cannot change between
	 * phases. Reusing the port is simplest and is safe because phase A is fully closed before phase
	 * B binds it.
	 */
	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	console.log("\nstarting NATS (nats:2.11-alpine, JetStream)\n");
	const nats = await startNats();

	// The PBX/carrier provider factories read the environment at construction time and
	// `@optimiq-voice/config` at import time, so it has to be complete before anything is loaded.
	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.PBX_DATABASE_URL = pbxDatabaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;
	/**
	 * Phase A boots with neither a carrier nor a broker.
	 *
	 * The carrier half is the point of the phase. The broker half is incidental but deliberate: the
	 * unconfigured-deployment checks need nothing from NATS, and starting a JetStream consumer only
	 * to drain it moments later exercises a shutdown path that has nothing to do with what is under
	 * test. `NATS_URL` is set before phase B, which is where the did-index assertions live.
	 */
	delete process.env.NATS_URL;
	// Anything the shell left behind would silently defeat the point of phase A.
	delete process.env.TELNYX_API_KEY;
	delete process.env.TELNYX_PUBLIC_KEY;
	delete process.env.TELNYX_API_BASE;

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule, registerAuthTransport } = await import("../src/auth/auth-bootstrap");
	const { PbxModule } = await import("../src/pbx/pbx.module");
	const { createPostgresClient } = await import("@optimiq-voice/db");
	const { DID_INDEX_KV, kvKeyFor } = await import("@optimiq-voice/events/streams");
	const { startFakeTelnyxServer, generateFakeWebhookKeyPair, signFakeTelnyxWebhook } =
		await import("@optimiq-voice/telnyx/fake");

	const sql = createPostgresClient({
		url: databaseUrl,
		applicationName: "verify-carrier",
		poolMaxConnectionsOverride: 2,
	});

	const fake = await startFakeTelnyxServer();
	const keyPair = generateFakeWebhookKeyPair();
	console.log(`fake Telnyx listening on ${fake.baseUrl}\n`);

	const password = "Verify-Carrier-2026!";
	const ownerEmail = `carrier-owner-${RUN_ID}@verify.optimiq.test`;
	let organizationId = "";
	let phase: { close: () => Promise<void> } | undefined;

	/**
	 * Boots the slice on a fresh port.
	 *
	 * A whole new Nest application per phase rather than a reconfigured one: the Telnyx client is
	 * built once in a provider factory, which is exactly the behaviour under test — a deployment
	 * does not grow a carrier at runtime, it is restarted with one.
	 */
	async function boot(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
		const app = await NestFactory.create(
			createApiRootModule([], [PbxModule]),
			new FastifyAdapter(),
			// The webhook route verifies a signature over the exact request bytes; without this the
			// receiver rejects every delivery, which is the correct behaviour and a useless test.
			{ logger: ["error"], rawBody: true },
		);
		app.enableShutdownHooks();
		await registerAuthTransport(app);
		await app.listen(port, "127.0.0.1");
		await delay(200);
		return { baseUrl, close: async () => await app.close() };
	}

	try {
		// =========================================================================================
		// PHASE A — no carrier configured
		// =========================================================================================
		console.log("A. a deployment with no TELNYX_API_KEY");
		const unconfigured = await boot();
		phase = unconfigured;
		const jar = new CookieJar();
		let client: Client = makeClient(unconfigured.baseUrl, jar);

		await client("POST", "/api/auth/sign-up/email", {
			name: "Carrier Owner",
			email: ownerEmail,
			password,
		});
		const created = await client("POST", "/api/auth/organization/create", {
			name: `Carrier Org ${RUN_ID}`,
			slug: `carrier-org-${RUN_ID}`,
		});
		organizationId = typeof created.body.id === "string" ? created.body.id : "";
		await client("POST", "/api/auth/organization/set-active", { organizationId });
		check("organization created", organizationId.length > 0, organizationId);

		const anonymous = await fetch(`${unconfigured.baseUrl}/api/v1/carrier/available-numbers`);
		check(
			"an anonymous carrier search is 401, not 503",
			anonymous.status === 401,
			`status ${anonymous.status}`,
		);

		const statusOff = await client("GET", "/api/v1/carrier/status");
		check(
			"status is 200 even with no carrier",
			statusOff.status === 200,
			`status ${statusOff.status}`,
		);
		check("status reports the carrier as unconfigured", data(statusOff).configured === false);
		check("status still names the provider", data(statusOff).provider === "telnyx");

		const searchOff = await client("GET", "/api/v1/carrier/available-numbers?country=US");
		check("search without a key is 503", searchOff.status === 503, `status ${searchOff.status}`);
		check(
			"the 503 carries code CARRIER_NOT_CONFIGURED",
			searchOff.body.code === "CARRIER_NOT_CONFIGURED",
			String(searchOff.body.code),
		);

		const orderOff = await client("POST", "/api/v1/carrier/number-orders", {
			e164: "+12125550100",
			destinationType: "hangup",
		});
		check("ordering without a key is 503", orderOff.status === 503, `status ${orderOff.status}`);
		check(
			"the order 503 carries the same code",
			orderOff.body.code === "CARRIER_NOT_CONFIGURED",
			String(orderOff.body.code),
		);

		const webhookOff = await client("POST", "/api/v1/carrier/webhooks/telnyx", { data: {} });
		check(
			"a webhook is refused when no public key is configured",
			webhookOff.status === 503,
			`status ${webhookOff.status}`,
		);
		check(
			"the webhook 503 says why",
			webhookOff.body.code === "CARRIER_WEBHOOK_NOT_CONFIGURED",
			String(webhookOff.body.code),
		);

		/**
		 * The promise that makes the degraded mode acceptable: nothing else is affected. A carrier
		 * outage that took the extension list with it would be a worse failure than the one the
		 * degradation is protecting against.
		 */
		const unaffected = await client("POST", "/api/v1/phone-numbers", {
			e164: `+1999${(Date.now() % 1_000_000).toString().padStart(6, "0")}`,
			destinationType: "hangup",
		});
		check(
			"ordinary phone-number CRUD is unaffected with no carrier",
			unaffected.status === 201,
			`status ${unaffected.status}`,
		);
		if (unaffected.status === 201) {
			await client("DELETE", `/api/v1/phone-numbers/${id(unaffected)}`);
		}

		await unconfigured.close();
		phase = undefined;

		// =========================================================================================
		// PHASE B — carrier configured, pointed at the fake
		// =========================================================================================
		console.log("\nB. a deployment with a carrier, against the in-package fake");
		process.env.TELNYX_API_KEY = "KEY-verify-carrier";
		process.env.TELNYX_API_BASE = fake.baseUrl;
		process.env.TELNYX_PUBLIC_KEY = keyPair.publicKeyBase64;
		process.env.TELNYX_DAILY_SPEND_LIMIT = "25.00";
		if (nats !== undefined) {
			process.env.NATS_URL = nats.url;
		}

		const configured = await boot();
		phase = configured;
		const jarB = new CookieJar();
		client = makeClient(configured.baseUrl, jarB);
		await client("POST", "/api/auth/sign-in/email", { email: ownerEmail, password });
		await client("POST", "/api/auth/organization/set-active", { organizationId });

		const statusOn = await client("GET", "/api/v1/carrier/status");
		check("status reports the carrier as configured", data(statusOn).configured === true);
		check(
			"status reports webhooks as verifiable",
			data(statusOn).webhooksConfigured === true,
			String(data(statusOn).webhooksConfigured),
		);
		check(
			"status names the SIP domain a trunk will register to",
			data(statusOn).sipDomain === "sip.telnyx.com",
			String(data(statusOn).sipDomain),
		);

		// --- B1. search -------------------------------------------------------------------------
		console.log("\nB1. number search");
		const search = await client(
			"GET",
			"/api/v1/carrier/available-numbers?country=US&areaCode=212&limit=3",
		);
		check("search is 200", search.status === 200, `status ${search.status}`);
		const found = rows(search);
		check("search returned the requested page size", found.length === 3, String(found.length));
		check(
			"every result is an E.164 in the requested area code",
			found.every((entry) => String(entry.e164).startsWith("+1212")),
			String(found[0]?.e164),
		);
		/**
		 * The browser must never learn the carrier's field names: the moment `apps/web` renders
		 * `cost_information.monthly_cost`, changing carrier becomes a frontend rewrite.
		 */
		check(
			"results speak our vocabulary, not the carrier's",
			found[0] !== undefined &&
				"monthlyCost" in found[0] &&
				!("cost_information" in found[0]) &&
				!("phone_number" in found[0]),
			Object.keys(found[0] ?? {}).join(","),
		);
		check(
			"costs stay decimal strings, never floats",
			typeof found[0]?.monthlyCost === "string",
			String(found[0]?.monthlyCost),
		);
		const firstFeatures = found[0]?.features;
		check(
			"features are flattened to names",
			Array.isArray(firstFeatures) && (firstFeatures as string[]).includes("voice"),
			JSON.stringify(firstFeatures),
		);

		const target = String(found[0]?.e164);
		const secondTarget = String(found[1]?.e164);
		const thirdTarget = String(found[2]?.e164);

		// --- B2. the two-step protocol ------------------------------------------------------------
		console.log("\nB2. the carrier's search-before-order rule");
		const unsearched = await client("POST", "/api/v1/carrier/number-orders", {
			// A +1-555 number in an area code this run never searched.
			e164: "+14165559999",
			destinationType: "hangup",
		});
		check(
			"ordering a number that was never searched is 422",
			unsearched.status === 422,
			`status ${unsearched.status}`,
		);
		check(
			"the 422 carries CARRIER_REJECTED",
			unsearched.body.code === "CARRIER_REJECTED",
			String(unsearched.body.code),
		);
		check(
			"the carrier's own error code survives to the client",
			carrierErrorCodes(unsearched).includes("85000"),
			carrierErrorCodes(unsearched).join(","),
		);

		// --- B3. the order ------------------------------------------------------------------------
		console.log("\nB3. ordering a number");
		const order = await client("POST", "/api/v1/carrier/number-orders", {
			e164: target,
			label: "Ordered by verify:carrier",
			destinationType: "hangup",
		});
		check("the order is 201", order.status === 201, `status ${order.status}`);
		const orderedId = id(order);
		check("the order returned a phone_number row", orderedId.length > 0, orderedId);
		check(
			"the row carries the number we asked for",
			data(order).e164 === target,
			String(data(order).e164),
		);
		check(
			"the row is marked carrier-managed",
			data(order).carrierProvider === "telnyx",
			String(data(order).carrierProvider),
		);
		check(
			"the row carries the carrier's id for the number",
			typeof data(order).carrierRef === "string" && String(data(order).carrierRef).length > 0,
			String(data(order).carrierRef),
		);
		check(
			"the response names the carrier order",
			typeof carrier(order).orderId === "string" && carrier(order).orderStatus === "success",
			`${String(carrier(order).orderId)} / ${String(carrier(order).orderStatus)}`,
		);
		/**
		 * The single most important structural claim: the order went THROUGH the slice service, so
		 * everything a hand-created DID gets, an ordered one gets. `warnings` is the compile-on-write
		 * envelope, and its presence is the evidence the recompile ran.
		 */
		check(
			"compile-on-write ran (the mutation envelope carries warnings)",
			Array.isArray(order.body.warnings),
			JSON.stringify(warningCodes(order)),
		);

		const listed = await client("GET", "/api/v1/phone-numbers");
		check(
			"the ordered number appears in the ordinary phone-number list",
			rows(listed).some((row) => row.e164 === target),
			String(rows(listed).length),
		);

		// --- B4. no double buying -----------------------------------------------------------------
		console.log("\nB4. the same number cannot be bought twice");
		const duplicate = await client("POST", "/api/v1/carrier/number-orders", {
			e164: target,
			destinationType: "hangup",
		});
		check(
			"a second order for the same number is refused",
			duplicate.status === 422,
			`status ${duplicate.status}`,
		);
		check(
			"the refusal names the carrier's 85001",
			carrierErrorCodes(duplicate).includes("85001"),
			carrierErrorCodes(duplicate).join(","),
		);

		// --- B5. trunk provisioning ---------------------------------------------------------------
		console.log("\nB5. trunk provisioning");
		const trunk = await client("POST", "/api/v1/trunks", {
			name: `Telnyx ${RUN_ID}`,
			// Deliberately placeholder values: the point is that provisioning overwrites them.
			sipDomain: "unprovisioned.invalid",
			sipProxy: "sip:unprovisioned.invalid:5060",
		});
		const trunkId = id(trunk);
		check("a trunk was created to provision", trunkId.length > 0, trunkId);

		const provisioned = await client("POST", `/api/v1/trunks/${trunkId}/provision-telnyx`, {
			concurrentCallLimit: 5,
		});
		check("provisioning is 201", provisioned.status === 201, `status ${provisioned.status}`);
		const credentials = carrier(provisioned);
		check(
			"provisioning returns the carrier's SIP domain",
			credentials.sipDomain === "sip.telnyx.com",
			String(credentials.sipDomain),
		);
		check(
			"the generated SIP username satisfies the carrier's format rule",
			/^ov[A-Za-z0-9]{18}$/u.test(String(credentials.sipUsername)),
			String(credentials.sipUsername),
		);
		check(
			"the generated password is 32 alphanumeric characters",
			/^[A-Za-z0-9]{32}$/u.test(String(credentials.sipPassword)),
			`${String(credentials.sipPassword).length} chars`,
		);
		check(
			"the SIP URI is the AoR the trunk registers as",
			credentials.sipUri === `${String(credentials.sipUsername)}@sip.telnyx.com`,
			String(credentials.sipUri),
		);
		check(
			"a connection and a profile were both created",
			typeof credentials.connectionId === "string" &&
				typeof credentials.outboundVoiceProfileId === "string",
			`${String(credentials.connectionId)} / ${String(credentials.outboundVoiceProfileId)}`,
		);
		check("the first provision is not a re-provision", credentials.reprovisioned === false);

		const trunkRow = await client("GET", `/api/v1/trunks/${trunkId}`);
		check(
			"the trunk row now points at the carrier's proxy",
			data(trunkRow).sipDomain === "sip.telnyx.com" &&
				data(trunkRow).sipProxy === "sip:sip.telnyx.com:5060",
			`${String(data(trunkRow).sipDomain)} / ${String(data(trunkRow).sipProxy)}`,
		);
		check(
			"the trunk row carries the SIP username as its auth user",
			data(trunkRow).authUser === credentials.sipUsername,
			String(data(trunkRow).authUser),
		);
		/**
		 * The password is NOT in the database. It is returned once by the provision call and remains
		 * re-derivable from the carrier via `carrier_ref`, which is a strictly better place for it
		 * than a column every service in the area can read.
		 *
		 * The handle itself is no longer asserted to be PRESENT: `sipSecretRef` is `secretColumns`
		 * on `TRUNK_RESOURCE`, so a read that returned it would be the bug. That the write landed is
		 * proven by the provisioning flow succeeding at all — the engine resolves the handle from
		 * the row, not from this response.
		 */
		check(
			"the trunk row leaks neither the password nor the secret handle",
			data(trunkRow).sipSecretRef === undefined &&
				!JSON.stringify(data(trunkRow)).includes(String(credentials.sipPassword)) &&
				!JSON.stringify(data(trunkRow)).includes(`secret://telnyx/trunk/${trunkId}`),
			JSON.stringify(data(trunkRow).sipSecretRef),
		);
		check(
			"the trunk row records its carrier provenance",
			data(trunkRow).carrierProvider === "telnyx" &&
				data(trunkRow).carrierRef === credentials.connectionId &&
				data(trunkRow).carrierProfileRef === credentials.outboundVoiceProfileId,
			`${String(data(trunkRow).carrierProvider)} / ${String(data(trunkRow).carrierRef)}`,
		);
		check(
			"the trunk registers, at the carrier's recommended interval",
			data(trunkRow).kind === "register" && data(trunkRow).registerExpiresSeconds === 180,
			`${String(data(trunkRow).kind)} / ${String(data(trunkRow).registerExpiresSeconds)}`,
		);

		const reprovisioned = await client("POST", `/api/v1/trunks/${trunkId}/provision-telnyx`, {});
		check(
			"re-provisioning updates in place rather than creating a second connection",
			carrier(reprovisioned).reprovisioned === true &&
				carrier(reprovisioned).connectionId === credentials.connectionId,
			String(carrier(reprovisioned).connectionId),
		);
		check(
			"re-provisioning rotates the password",
			carrier(reprovisioned).sipPassword !== credentials.sipPassword,
			"rotated",
		);
		check(
			"the carrier holds exactly one connection for this trunk",
			fake.state.connections.size === 1,
			String(fake.state.connections.size),
		);

		// --- B6. pointing a DID at a trunk --------------------------------------------------------
		console.log("\nB6. routing an ordered number to a provisioned trunk");
		const routed = await client("POST", "/api/v1/carrier/number-orders", {
			e164: secondTarget,
			destinationType: "hangup",
			trunkId,
		});
		check(
			"ordering onto a provisioned trunk is 201",
			routed.status === 201,
			`status ${routed.status}`,
		);
		const carrierNumberId = String(data(routed).carrierRef);
		const atCarrier = [...fake.state.inventory].find((entry) => entry.ownedId === carrierNumberId);
		check(
			"the carrier has the number pointed at our connection",
			atCarrier?.connectionId === carrier(reprovisioned).connectionId,
			String(atCarrier?.connectionId),
		);

		const byoTrunk = await client("POST", "/api/v1/trunks", {
			name: `BYO ${RUN_ID}`,
			sipDomain: "byo.example.net",
			sipProxy: "sip:byo.example.net:5060",
		});
		const byoOrder = await client("POST", "/api/v1/carrier/number-orders", {
			e164: thirdTarget,
			destinationType: "hangup",
			trunkId: id(byoTrunk),
		});
		check(
			"ordering onto a BYO-SIP trunk is refused, not silently accepted",
			byoOrder.status === 422,
			`status ${byoOrder.status}`,
		);
		check(
			"the refusal says the trunk is not provisioned",
			byoOrder.body.code === "CARRIER_TRUNK_NOT_PROVISIONED",
			String(byoOrder.body.code),
		);
		check(
			"nothing was bought for the refused order",
			fake.state.find(thirdTarget)?.available === true,
			String(fake.state.find(thirdTarget)?.available),
		);

		// --- B7. release --------------------------------------------------------------------------
		console.log("\nB7. release, and the delete that deliberately does not release");
		const released = await client("DELETE", `/api/v1/carrier/numbers/${orderedId}`);
		check("the release is 200", released.status === 200, `status ${released.status}`);
		/**
		 * The claim here is about the RELEASE, not about the tenant.
		 *
		 * This used to be `warnings.length === 0`, which was the same claim for as long as the only
		 * diagnostics a clean tenant could produce were about routing entities. E911 changed that:
		 * `packages/routing` now warns once per DID that carries no `emergency_address_id`, because
		 * RAY BAUM'S Act wants a dispatchable location for every station that can dial `911` — and
		 * the numbers this script buys are, correctly, not given one.
		 *
		 * So the assertion becomes "nothing the release itself caused", expressed as an allow-list
		 * of one. A release that produced a `dangling-destination` or an `empty-trunk-list` would
		 * still fail it, which is what the check was for.
		 */
		const releaseWarnings = warningCodes(released);
		check(
			"the release itself causes no warnings (the E911 ones are about the tenant's numbers)",
			releaseWarnings.every((code) => code === "missing-emergency-address"),
			releaseWarnings.join(","),
		);
		check(
			"the carrier has the number back",
			fake.state.find(target)?.available === true,
			String(fake.state.find(target)?.available),
		);
		check(
			"the row is gone locally",
			(await client("GET", `/api/v1/phone-numbers/${orderedId}`)).status === 404,
		);

		const routedId = id(routed);
		const routedCarrierRef = String(data(routed).carrierRef);
		const plainDelete = await client("DELETE", `/api/v1/phone-numbers/${routedId}`);
		check("the plain delete is 200", plainDelete.status === 200, `status ${plainDelete.status}`);
		/**
		 * Deliberate, and the reason release is a separate route: "remove this DID from the
		 * organization" and "give this DID back to the carrier" are different operations, and a
		 * number being migrated between tenants needs the first without the second.
		 */
		check(
			"the plain delete leaves the number owned at the carrier",
			fake.state.findOwned(routedCarrierRef) !== undefined,
			routedCarrierRef,
		);

		// --- B8. webhooks -------------------------------------------------------------------------
		console.log("\nB8. webhook signature verification");
		const orderRecord = [...fake.state.orders.values()][0];
		const webhookBody = JSON.stringify({
			data: {
				record_type: "event",
				event_type: "number_order.complete",
				id: `evt-${RUN_ID}`,
				occurred_at: new Date().toISOString(),
				payload: {
					id: orderRecord?.id ?? "order-1",
					record_type: "number_order",
					status: "success",
					phone_numbers: [],
					customer_reference: orderRecord?.customerReference ?? "",
				},
			},
			meta: { attempt: 1, delivered_to: `${configured.baseUrl}/api/v1/carrier/webhooks/telnyx` },
		});

		async function postWebhook(
			body: string,
			headers: Record<string, string>,
		): Promise<JsonResponse> {
			const response = await fetch(`${configured.baseUrl}/api/v1/carrier/webhooks/telnyx`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body,
			});
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
		}

		const signed = signFakeTelnyxWebhook(keyPair, webhookBody);
		const accepted = await postWebhook(signed.body, {
			"telnyx-signature-ed25519": signed.signature,
			"telnyx-timestamp": signed.timestamp,
		});
		check(
			"a correctly signed webhook is accepted",
			accepted.status === 200 && accepted.body.received === true,
			`status ${accepted.status}`,
		);

		const tampered = await postWebhook(`${signed.body} `, {
			"telnyx-signature-ed25519": signed.signature,
			"telnyx-timestamp": signed.timestamp,
		});
		check(
			"a body altered after signing is rejected",
			tampered.status === 403 && tampered.body.code === "CARRIER_SIGNATURE_INVALID",
			`status ${tampered.status}`,
		);

		const wrongKey = signFakeTelnyxWebhook(generateFakeWebhookKeyPair(), webhookBody);
		const foreign = await postWebhook(wrongKey.body, {
			"telnyx-signature-ed25519": wrongKey.signature,
			"telnyx-timestamp": wrongKey.timestamp,
		});
		check(
			"a signature from another key is rejected",
			foreign.status === 403,
			`status ${foreign.status}`,
		);

		const unsigned = await postWebhook(webhookBody, {});
		check("an unsigned delivery is rejected", unsigned.status === 403, `status ${unsigned.status}`);

		const stale = signFakeTelnyxWebhook(keyPair, webhookBody, Math.floor(Date.now() / 1000) - 3600);
		const replayed = await postWebhook(stale.body, {
			"telnyx-signature-ed25519": stale.signature,
			"telnyx-timestamp": stale.timestamp,
		});
		check(
			"a validly signed but stale delivery is rejected as a replay",
			replayed.status === 403,
			`status ${replayed.status}`,
		);

		// --- B9. the DID index --------------------------------------------------------------------
		if (nats === undefined) {
			console.log("\nB9. did-index — SKIPPED (docker unavailable)");
		} else {
			console.log("\nB9. the ordered number reaches the did-index");
			const { connect } = await import("nats");
			const connection = await connect({ servers: nats.url, name: "verify-carrier" });
			try {
				const manager = await connection.jetstreamManager();
				const bucket = await manager.jetstream().views.kv(DID_INDEX_KV.name);

				// A number ordered and then released must leave no entry behind — a stale key would
				// route a stranger's calls into this organization. A NATS KV delete leaves a tombstone
				// that `get` still returns, with an empty value, so both shapes count as absent.
				const releasedKey = kvKeyFor.didIndex(target);
				const releasedEntry = await bucket.get(releasedKey);
				check(
					"the released number has no did-index entry",
					releasedEntry === null || releasedEntry.value.length === 0,
					releasedKey,
				);

				// One that is still owned must have one. Order a fresh number so the assertion is not
				// about a row an earlier section deleted.
				const freshSearch = await client(
					"GET",
					"/api/v1/carrier/available-numbers?country=US&areaCode=415&limit=1",
				);
				const freshTarget = String(rows(freshSearch)[0]?.e164);
				const freshOrder = await client("POST", "/api/v1/carrier/number-orders", {
					e164: freshTarget,
					destinationType: "hangup",
				});
				await delay(500);
				const freshKey = kvKeyFor.didIndex(freshTarget);
				const entry = await bucket.get(freshKey);
				check("an ordered number lands in the did-index", entry !== null, freshKey);
				if (entry !== null) {
					const indexed = JSON.parse(new TextDecoder().decode(entry.value)) as {
						organizationId?: string;
						phoneNumberId?: string;
					};
					check(
						"the did-index entry names the ordering organization",
						indexed.organizationId === organizationId,
						String(indexed.organizationId),
					);
					check(
						"the did-index entry names the phone_number row the order created",
						indexed.phoneNumberId === id(freshOrder),
						`${String(indexed.phoneNumberId)} vs ${id(freshOrder)}`,
					);
				}
				await client("DELETE", `/api/v1/carrier/numbers/${id(freshOrder)}`);
			} finally {
				await connection.close();
			}
		}
	} finally {
		if (phase !== undefined) {
			/**
			 * Let the fire-and-forget publishes settle before draining the broker.
			 *
			 * `onArtifactCompiled` publishes with `void publisher.publish(...)` by design — a broker
			 * outage must degrade the routing cache, not the API — so at the moment the last mutation
			 * returns there can still be an in-flight KV write. Closing immediately drains the
			 * connection under it, and the resulting `CONNECTION_DRAINING` surfaces as an unhandled
			 * rejection that kills this process before it can print its summary. The guard below
			 * catches it either way; this pause makes it rare rather than routine. The underlying
			 * missing `.catch()` on the publish path is recorded as a follow-up.
			 */
			await delay(500);
			await phase.close();
		}
		await fake.close();

		// Cleanup: the run's rows, then the tenant.
		try {
			const { createPbxDatabase } = await import("../src/pbx/shared/pbx-database");
			const pbx = createPbxDatabase({
				PBX_DATABASE_URL: pbxDatabaseUrl,
				PBX_DATABASE_MAX_CONNECTIONS: 2,
				PBX_ENSURE_KV_BUCKETS: false,
				// Unused by a cleanup handle — it only ever runs DELETEs — but the env type is total on
				// purpose, so a new field is a compile error at every construction site rather than an
				// `undefined` that reaches a dial string.
				PBX_EXTENSION_DIAL_TEMPLATE: "PJSIP/{number}",
				// Likewise unused: this handle runs no module and therefore no sweeper. The interval is
				// nevertheless the disabling `0` rather than the default, so that if this ever DID boot
				// a module it would not start background work in a cleanup path.
				PBX_OUTBOX_SWEEP_INTERVAL_MS: 0,
				PBX_OUTBOX_BACKOFF_BASE_MS: 15_000,
				PBX_OUTBOX_BACKOFF_CAP_MS: 300_000,
				PBX_OUTBOX_STUCK_ATTEMPTS: 5,
				PBX_OUTBOX_RETENTION_HOURS: 24,
				PBX_VOICEMAIL_MEDIA_ROOT: "/tmp/optimiq-voice-unused",
				PBX_VOICEMAIL_URL_TTL_SECONDS: 300,
				PBX_VOICEMAIL_EMAIL_URL_TTL_SECONDS: 24 * 3600,
				PBX_MEDIA_OBJECT_ROOT: "/tmp/optimiq-voice-unused",
				PBX_MEDIA_MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
			});
			if (organizationId.length > 0) {
				await pbx.withTenantScope(organizationId, async (transaction) => {
					await transaction.execute(
						// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
						(await import("@optimiq-voice/pbx-db")).sql`delete from phone_number`,
					);
					await transaction.execute((await import("@optimiq-voice/pbx-db")).sql`delete from trunk`);
				});
			}
			await pbx.close();
		} catch (error) {
			console.error("cleanup of PBX rows failed", error);
		}
		try {
			if (organizationId.length > 0) {
				await sql`delete from "organization" where id = ${organizationId}`;
			}
			await sql`delete from "user" where email = ${ownerEmail}`;
		} catch (error) {
			console.error("cleanup of the tenant failed", error);
		}
		await sql.end({ timeout: 5 });
		if (nats !== undefined) {
			await stopNats(nats);
		}
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.log("\nfailures:");
		for (const entry of failed) {
			console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`);
		}
		process.exitCode = 1;
	}
}

await main();
