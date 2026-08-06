/**
 * End-to-end verification of the CDR area (P5 gate).
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   CDR_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_cdr \
 *     pnpm --filter @optimiq-voice/api verify:cdr
 *
 * It boots the real HTTP slice — `createApiRootModule([], [CdrModule])`, the auth slice plus the
 * CDR area, on an ephemeral port against a real PostgreSQL and a real JetStream — publishes
 * synthetic `cdr.leg.write` and `channel.record.*` events exactly as `apps/engine` does, and then
 * asks the API the questions a reporting client would.
 *
 * `AppModule` is excluded for the same reason `verify-pbx.ts` excludes it: its `RuntimeHostService`
 * starts the gRPC servers, the ARI client and the InfluxDB writer, none of which this gate is
 * about.
 *
 * What it proves, in order:
 *
 *  1. Boot-time RLS preflight passes against the live CDR catalogue (append-only by privilege).
 *  2. The durable writer files published legs into `call_legs`, for two organizations at once.
 *  3. Tenant isolation: neither organization can list, read or reach the other's legs — enforced
 *     by RLS inside `withTenantScope`, not by a `where` clause we could forget.
 *  4. Idempotency: republishing the same leg id produces ONE row, at the layer that is supposed to
 *     produce one (the composite primary key, outside the broker's dedupe window).
 *  5. The loose→checked mapping: a kebab plan-node destination becomes the snake reporting value,
 *     and a carrier hangup cause we do not name survives as its numeric code.
 *  6. Partitions are created on demand for a month nobody warmed, and the row lands in it rather
 *     than in the default partition.
 *  7. Every filter narrows what it claims to, and the cursor is stable: page 2 does not repeat
 *     page 1, and re-reading page 1 returns the same rows.
 *  8. The failure taxonomy: a too-wide range and a forged cursor are named 400s.
 *  9. Poison messages are quarantined with a replayable stream sequence rather than dropped.
 * 10. `channel.record.*` produces a recordings row AND sets the leg's `recording_key`.
 * 11. Signed download URLs round trip: a valid token streams the object, an expired one is a 410,
 *     a tampered one is a 403, and the media route is unreachable without a token.
 *
 * Docker is required: the writers are durable JetStream consumers and there is nothing to verify
 * without a broker. The script says so and exits non-zero rather than skipping.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_CDR_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_cdr";

/** Shared with the other verification scripts: better-auth's JWKS keys are encrypted with it. */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
/** 48 characters, comfortably over the 32 the env contract demands. */
const RECORDING_SECRET = "verify-cdr-recording-signing-key-0123456789abcd";
const RUN_ID = Date.now().toString(36);

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

function rows(response: JsonResponse): Record<string, unknown>[] {
	const value = response.body.data;
	return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function data(response: JsonResponse): Record<string, unknown> {
	const value = response.body.data;
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

// ---------------------------------------------------------------------------------------------
// Docker-managed NATS
// ---------------------------------------------------------------------------------------------

const NATS_CONTAINER_PREFIX = "optimiq-verify-cdr";

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
			console.log(`  (removed ${stale.length} stale verify-cdr NATS container(s))`);
		}
	} catch {
		// No docker, or nothing to sweep.
	}
}

async function startNats(): Promise<{ url: string; containerId: string } | undefined> {
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
		console.error(
			`docker is required for verify:cdr (the writers are durable JetStream consumers): ${
				error instanceof Error ? error.message.split("\n")[0] : String(error)
			}`,
		);
		return undefined;
	}
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

interface LegFixture {
	readonly id: string;
	readonly callId: string;
	readonly leg: "a" | "b";
	readonly originatingLegId?: string | null;
	readonly direction: "inbound" | "outbound" | "internal";
	readonly fromNumber: string;
	readonly fromName?: string | null;
	readonly toNumber: string;
	readonly destinationType: string;
	readonly startedAt: string;
	readonly durationMs: number;
	readonly billsecMs: number;
	readonly hangupCause: string;
	readonly hangupCauseCode: number;
	readonly disposition: string;
}

function isoMinutesAgo(minutes: number): string {
	return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Waits for an asynchronous consumer to catch up.
 *
 * Polling with a deadline rather than a fixed sleep: a fixed sleep is either flaky on a slow
 * machine or wastes seconds on a fast one, and this harness makes several of these waits.
 */
async function waitFor(
	description: string,
	predicate: () => Promise<boolean>,
	timeoutMs = 20_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return true;
		}
		await delay(250);
	}
	console.log(`  (timed out waiting for ${description})`);
	return false;
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const cdrDatabaseUrl = process.env.CDR_DATABASE_URL ?? DEFAULT_CDR_DATABASE_URL;
	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	console.log("\nstarting NATS (nats:2.11-alpine, JetStream)\n");
	const nats = await startNats();
	if (nats === undefined) {
		process.exitCode = 1;
		return;
	}

	const recordingRoot = await mkdtemp(join(tmpdir(), "optimiq-verify-cdr-"));

	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.CDR_DATABASE_URL = cdrDatabaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;
	process.env.NATS_URL = nats.url;
	process.env.CDR_RECORDING_URL_SECRET = RECORDING_SECRET;
	process.env.CDR_RECORDING_URL_TTL_SECONDS = "60";
	process.env.CDR_RECORDING_ROOT = recordingRoot;
	// The area's env is read in a Nest provider factory, so it has to be complete before anything
	// that imports it is loaded. Every import below is therefore dynamic.

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule, registerAuthTransport } = await import("../src/auth/auth-bootstrap");
	const { assertCdrPreflight } = await import("../src/cdr/cdr-bootstrap");
	const { CdrModule } = await import("../src/cdr/cdr.module");
	const { createPostgresClient } = await import("@optimiq-voice/db");
	const { makeCdrLegWriteEvent, makeCallEvent } = await import("@optimiq-voice/events/schemas");
	const { subjectFor } = await import("@optimiq-voice/events/subjects");
	const { connect } = await import("nats");
	const { createEntityId } = await import("@optimiq-voice/identifiers");

	const sql = createPostgresClient({
		url: databaseUrl,
		applicationName: "verify-cdr",
		poolMaxConnectionsOverride: 2,
	});
	const cdrSql = createPostgresClient({
		url: cdrDatabaseUrl,
		applicationName: "verify-cdr-inspect",
		poolMaxConnectionsOverride: 2,
	});

	console.log("0. boot-time contract");
	try {
		const preflighted = await assertCdrPreflight();
		check("CDR tenant RLS preflight passes against the live catalogue", preflighted);
	} catch (error) {
		check("CDR tenant RLS preflight passes against the live catalogue", false, String(error));
	}

	console.log(`\nbooting the auth slice + CDR area on ${baseUrl}\n`);
	const app = await NestFactory.create(createApiRootModule([], [CdrModule]), new FastifyAdapter(), {
		logger: ["error"],
	});
	app.enableShutdownHooks();
	await registerAuthTransport(app);
	await app.listen(port, "127.0.0.1");
	await delay(500);

	const ownerEmail = `cdr-owner-${RUN_ID}@verify.optimiq.test`;
	const otherEmail = `cdr-other-${RUN_ID}@verify.optimiq.test`;
	const password = "Verify-Cdr-Area-2026!";
	const jarA = new CookieJar();
	const jarB = new CookieJar();
	const clientA: Client = makeClient(baseUrl, jarA);
	const clientB: Client = makeClient(baseUrl, jarB);
	let organizationA = "";
	let organizationB = "";

	const publisher = await connect({ servers: nats.url, name: "verify-cdr-publisher" });
	const jetstream = publisher.jetstream();

	const publishLeg = async (
		organizationId: string,
		fixture: LegFixture,
		options: { readonly subjectOverride?: string; readonly msgId?: string } = {},
	): Promise<void> => {
		const envelope = makeCdrLegWriteEvent({
			orgId: organizationId,
			source: "engine",
			data: fixture as unknown as Parameters<typeof makeCdrLegWriteEvent>[0]["data"],
		});
		await jetstream.publish(
			options.subjectOverride ?? envelope.subject,
			new TextEncoder().encode(JSON.stringify(envelope)),
			{ msgID: options.msgId ?? envelope.id },
		);
	};

	const countLegs = async (organizationId: string): Promise<number> => {
		const result = await cdrSql<{ total: number }[]>`
			select count(*)::int as total from "call_legs" where "organization_id" = ${organizationId}::uuid
		`;
		return result[0]?.total ?? 0;
	};

	try {
		// --- 1. two tenants ---------------------------------------------------------------------
		console.log("\n1. two organizations, two owners");
		await clientA("POST", "/api/auth/sign-up/email", {
			name: "CDR Owner A",
			email: ownerEmail,
			password,
		});
		const createA = await clientA("POST", "/api/auth/organization/create", {
			name: `CDR Org A ${RUN_ID}`,
			slug: `cdr-org-a-${RUN_ID}`,
		});
		organizationA = typeof createA.body.id === "string" ? createA.body.id : "";
		await clientA("POST", "/api/auth/organization/set-active", { organizationId: organizationA });
		check("organization A created", organizationA.length > 0, organizationA);

		await clientB("POST", "/api/auth/sign-up/email", {
			name: "CDR Owner B",
			email: otherEmail,
			password,
		});
		const createB = await clientB("POST", "/api/auth/organization/create", {
			name: `CDR Org B ${RUN_ID}`,
			slug: `cdr-org-b-${RUN_ID}`,
		});
		organizationB = typeof createB.body.id === "string" ? createB.body.id : "";
		await clientB("POST", "/api/auth/organization/set-active", { organizationId: organizationB });
		check("organization B created", organizationB.length > 0, organizationB);

		console.log("\n2. the area denies by default");
		const anonymousList = await fetch(`${baseUrl}/api/v1/cdr`);
		check("an anonymous CDR list is 401", anonymousList.status === 401, `status ${anonymousList.status}`);
		const anonymousRecordings = await fetch(`${baseUrl}/api/v1/recordings`);
		check(
			"an anonymous recordings list is 401",
			anonymousRecordings.status === 401,
			`status ${anonymousRecordings.status}`,
		);
		const anonymousMedia = await fetch(`${baseUrl}/api/v1/recordings/media?token=not-a-token`);
		check(
			"the signed media route refuses a bogus token rather than 401ing",
			anonymousMedia.status === 403,
			`status ${anonymousMedia.status}`,
		);
		const missingToken = await fetch(`${baseUrl}/api/v1/recordings/media`);
		check(
			"the signed media route with no token at all is refused",
			missingToken.status === 403,
			`status ${missingToken.status}`,
		);

		// --- 3. the writer files what the engine publishes ----------------------------------------
		console.log("\n3. the durable writer files published legs");
		const callOne = createEntityId();
		const aLegId = createEntityId();
		const bLegOneId = createEntityId();
		const bLegTwoId = createEntityId();
		const duplicateLegId = createEntityId();
		const coercedLegId = createEntityId();

		const aLeg: LegFixture = {
			id: aLegId,
			callId: callOne,
			leg: "a",
			originatingLegId: null,
			direction: "inbound",
			fromNumber: "+12125550100",
			fromName: "Verify Caller",
			toNumber: "2000",
			destinationType: "ring-group",
			startedAt: isoMinutesAgo(30),
			durationMs: 45_000,
			billsecMs: 30_000,
			hangupCause: "NORMAL_CLEARING",
			hangupCauseCode: 16,
			disposition: "answered",
		};
		const bLegOne: LegFixture = {
			...aLeg,
			id: bLegOneId,
			leg: "b",
			originatingLegId: aLegId,
			direction: "internal",
			fromNumber: "2000",
			toNumber: "1001",
			destinationType: "extension",
			startedAt: isoMinutesAgo(29),
			durationMs: 20_000,
			billsecMs: 18_000,
			disposition: "answered",
		};
		const bLegTwo: LegFixture = {
			...bLegOne,
			id: bLegTwoId,
			toNumber: "1002",
			startedAt: isoMinutesAgo(29),
			durationMs: 8_000,
			billsecMs: 0,
			hangupCause: "LOSE_RACE",
			hangupCauseCode: 502,
			disposition: "no-answer",
		};
		const duplicateLeg: LegFixture = {
			...aLeg,
			id: duplicateLegId,
			callId: createEntityId(),
			startedAt: isoMinutesAgo(20),
			toNumber: "3000",
			destinationType: "queue",
			disposition: "busy",
			hangupCause: "USER_BUSY",
			hangupCauseCode: 17,
		};
		const coercedLeg: LegFixture = {
			...aLeg,
			id: coercedLegId,
			callId: createEntityId(),
			startedAt: isoMinutesAgo(15),
			direction: "outbound",
			fromNumber: "1001",
			toNumber: "+442071234567",
			// A carrier cause the taxonomy has never seen, and a plan node kind that is not a
			// reporting destination type. Both must survive rather than fail the insert.
			destinationType: "trunk-dial",
			hangupCause: "CARRIER_SAYS_NO",
			hangupCauseCode: 811,
			disposition: "failed",
			billsecMs: 0,
		};

		for (const fixture of [aLeg, bLegOne, bLegTwo, duplicateLeg, coercedLeg]) {
			await publishLeg(organizationA, fixture);
		}

		// Organization B gets its own, so isolation is proved against real rows rather than absence.
		const bOrgLegId = createEntityId();
		await publishLeg(organizationB, {
			...aLeg,
			id: bOrgLegId,
			callId: createEntityId(),
			startedAt: isoMinutesAgo(10),
			fromNumber: "+13105550199",
			toNumber: "5000",
			destinationType: "ivr-menu",
		});

		const filedA = await waitFor(
			"organization A's legs to be filed",
			async () => (await countLegs(organizationA)) >= 5,
		);
		check("the writer filed organization A's five legs", filedA, `${String(await countLegs(organizationA))} rows`);
		const filedB = await waitFor(
			"organization B's leg to be filed",
			async () => (await countLegs(organizationB)) >= 1,
		);
		check("the writer filed organization B's leg", filedB);

		// --- 4. idempotency -----------------------------------------------------------------------
		console.log("\n4. idempotency");
		// A DIFFERENT `Nats-Msg-Id` so the broker's 10-minute duplicate window cannot be what
		// suppresses it: this proves the DATABASE layer (the composite primary key) is doing the work.
		await publishLeg(organizationA, duplicateLeg, { msgId: `redelivery-${RUN_ID}` });
		await delay(1500);
		const duplicateRows = await cdrSql<{ total: number }[]>`
			select count(*)::int as total from "call_legs" where "id" = ${duplicateLegId}::uuid
		`;
		check(
			"republishing a leg outside the broker's dedupe window still writes ONE row",
			duplicateRows[0]?.total === 1,
			`${String(duplicateRows[0]?.total)} rows`,
		);
		check(
			"the duplicate did not inflate organization A's total",
			(await countLegs(organizationA)) === 5,
			`${String(await countLegs(organizationA))} rows`,
		);

		// --- 5. the loose→checked mapping ---------------------------------------------------------
		console.log("\n5. the event contract's loose values become legal column values");
		const coercedRow = await cdrSql<
			{ destination_type: string; hangup_cause: string; hangup_cause_code: number; raw: unknown }[]
		>`select "destination_type", "hangup_cause", "hangup_cause_code", "raw"
			from "call_legs" where "id" = ${coercedLegId}::uuid`;
		check(
			"a kebab plan-node destination becomes the snake reporting value",
			coercedRow[0]?.destination_type === "trunk",
			String(coercedRow[0]?.destination_type),
		);
		check(
			"an unnamed carrier cause is stored as NORMAL_UNSPECIFIED",
			coercedRow[0]?.hangup_cause === "NORMAL_UNSPECIFIED",
			String(coercedRow[0]?.hangup_cause),
		);
		check(
			"the numeric cause code survives the round trip verbatim",
			coercedRow[0]?.hangup_cause_code === 811,
			String(coercedRow[0]?.hangup_cause_code),
		);
		check(
			"every coercion is recorded in the row's raw block",
			JSON.stringify(coercedRow[0]?.raw ?? {}).includes("CARRIER_SAYS_NO"),
			JSON.stringify(coercedRow[0]?.raw ?? {}).slice(0, 120),
		);
		const ringGroupRow = await cdrSql<{ destination_type: string }[]>`
			select "destination_type" from "call_legs" where "id" = ${aLegId}::uuid`;
		check(
			"ring-group becomes ring_group",
			ringGroupRow[0]?.destination_type === "ring_group",
			String(ringGroupRow[0]?.destination_type),
		);

		// --- 6. partitions on demand ---------------------------------------------------------------
		console.log("\n6. a month nobody warmed gets its partition");
		const future = new Date();
		future.setUTCMonth(future.getUTCMonth() + 5, 15);
		const futurePartition = `call_legs_${String(future.getUTCFullYear())}_${String(future.getUTCMonth() + 1).padStart(2, "0")}`;
		const futureLegId = createEntityId();
		await publishLeg(organizationA, {
			...aLeg,
			id: futureLegId,
			callId: createEntityId(),
			startedAt: future.toISOString(),
			destinationType: "extension",
		});
		const partitioned = await waitFor(`the ${futurePartition} partition`, async () => {
			const found = await cdrSql<{ relname: string }[]>`
				select "relname" from pg_class where "relname" = ${futurePartition}
			`;
			return found.length > 0;
		});
		check(`the writer created ${futurePartition} on demand`, partitioned);
		const futureLanded = await waitFor("the future leg to land", async () => {
			const found = await cdrSql<{ tableoid: string }[]>`
				select "tableoid"::regclass::text as "tableoid" from "call_legs" where "id" = ${futureLegId}::uuid
			`;
			return found[0]?.tableoid === futurePartition;
		});
		check(
			"the future-dated leg landed in its own partition, not in call_legs_default",
			futureLanded,
		);

		// --- 7. the query API ----------------------------------------------------------------------
		console.log("\n7. the query API");
		const listA = await clientA("GET", "/api/v1/cdr?limit=50");
		check("organization A can list its legs", listA.status === 200, `status ${String(listA.status)}`);
		check("the list envelope carries the resolved range", typeof listA.body.range === "object");
		check(
			"the list envelope carries a cursor field rather than a total",
			"nextCursor" in listA.body && !("total" in listA.body),
			Object.keys(listA.body).join(", "),
		);
		const listedIds = new Set(rows(listA).map((row) => String(row.id)));
		check("the A-leg is listed", listedIds.has(aLegId));
		check("both B-legs are listed", listedIds.has(bLegOneId) && listedIds.has(bLegTwoId));
		check(
			"organization B's leg is NOT in organization A's list",
			!listedIds.has(bOrgLegId),
			bOrgLegId,
		);
		check(
			"the future-dated leg is outside the default 24-hour window",
			!listedIds.has(futureLegId),
		);

		const listB = await clientB("GET", "/api/v1/cdr?limit=50");
		const listedB = new Set(rows(listB).map((row) => String(row.id)));
		check("organization B sees only its own leg", listedB.has(bOrgLegId) && !listedB.has(aLegId));

		console.log("\n8. filters");
		const inbound = await clientA("GET", "/api/v1/cdr?direction=inbound&limit=50");
		check(
			"direction=inbound returns only inbound legs",
			rows(inbound).length > 0 && rows(inbound).every((row) => row.direction === "inbound"),
			`${String(rows(inbound).length)} rows`,
		);
		const busy = await clientA("GET", "/api/v1/cdr?disposition=busy&limit=50");
		check(
			"disposition=busy returns only the busy leg",
			rows(busy).length === 1 && rows(busy)[0]?.id === duplicateLegId,
		);
		const byCause = await clientA("GET", "/api/v1/cdr?hangupCause=LOSE_RACE&limit=50");
		check(
			"hangupCause=LOSE_RACE finds the losing B-leg",
			rows(byCause).length === 1 && rows(byCause)[0]?.id === bLegTwoId,
		);
		const byExtension = await clientA("GET", "/api/v1/cdr?extension=1002&limit=50");
		check(
			"extension= matches either end of a leg, exactly",
			rows(byExtension).length === 1 && rows(byExtension)[0]?.id === bLegTwoId,
		);
		const byExtensionPrefix = await clientA("GET", "/api/v1/cdr?extension=100&limit=50");
		check(
			"extension= is exact, so a prefix matches nothing",
			rows(byExtensionPrefix).length === 0,
			`${String(rows(byExtensionPrefix).length)} rows`,
		);
		const byDid = await clientA("GET", "/api/v1/cdr?did=%2B12125550100&limit=50");
		check("did= matches the E.164 caller", rows(byDid).length >= 1);
		const bySearch = await clientA("GET", "/api/v1/cdr?search=Verify%20Caller&limit=50");
		check("search= matches the caller name", rows(bySearch).length >= 1);
		const bySearchNumber = await clientA("GET", "/api/v1/cdr?search=442071&limit=50");
		check(
			"search= is a partial match over numbers",
			rows(bySearchNumber).length === 1 && rows(bySearchNumber)[0]?.id === coercedLegId,
		);
		const byLeg = await clientA("GET", "/api/v1/cdr?leg=b&limit=50");
		check(
			"leg=b returns only B-legs",
			rows(byLeg).length === 2 && rows(byLeg).every((row) => row.leg === "b"),
		);
		const wildcardSearch = await clientA("GET", "/api/v1/cdr?search=%25&limit=50");
		check(
			"a LIKE metacharacter in search matches literally rather than everything",
			rows(wildcardSearch).length === 0,
			`${String(rows(wildcardSearch).length)} rows`,
		);

		console.log("\n9. cursor pagination");
		const pageOne = await clientA("GET", "/api/v1/cdr?limit=2");
		check("a page returns exactly the limit", rows(pageOne).length === 2);
		check("a page with more behind it carries a cursor", typeof pageOne.body.nextCursor === "string");
		const cursor = String(pageOne.body.nextCursor);
		const pageTwo = await clientA("GET", `/api/v1/cdr?limit=2&cursor=${encodeURIComponent(cursor)}`);
		const pageOneIds = rows(pageOne).map((row) => String(row.id));
		const pageTwoIds = rows(pageTwo).map((row) => String(row.id));
		check(
			"page two does not repeat page one",
			pageTwoIds.every((id) => !pageOneIds.includes(id)),
			pageTwoIds.join(", "),
		);
		const pageOneAgain = await clientA("GET", "/api/v1/cdr?limit=2");
		check(
			"re-reading page one returns the same rows in the same order",
			JSON.stringify(rows(pageOneAgain).map((row) => row.id)) === JSON.stringify(pageOneIds),
		);
		const lastPage = await clientA("GET", "/api/v1/cdr?limit=100");
		check("the last page carries no cursor", lastPage.body.nextCursor === null);

		console.log("\n10. the failure taxonomy");
		const tooWide = await clientA(
			"GET",
			"/api/v1/cdr?from=2020-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z",
		);
		check("a range wider than the cap is a 400", tooWide.status === 400, `status ${String(tooWide.status)}`);
		check("the 400 carries code CDR_RANGE_TOO_WIDE", tooWide.body.code === "CDR_RANGE_TOO_WIDE");
		const badCursor = await clientA("GET", "/api/v1/cdr?cursor=not-a-cursor");
		check("a forged cursor is a 400", badCursor.status === 400, `status ${String(badCursor.status)}`);
		check("the 400 carries code CDR_INVALID_CURSOR", badCursor.body.code === "CDR_INVALID_CURSOR");
		const badDisposition = await clientA("GET", "/api/v1/cdr?disposition=maybe");
		check("a value the column would refuse is a 400", badDisposition.status === 400);

		console.log("\n11. leg and call detail");
		const legDetail = await clientA(
			"GET",
			`/api/v1/cdr/${aLegId}?startedAt=${encodeURIComponent(aLeg.startedAt)}`,
		);
		check("a leg is readable by id plus its partition key", legDetail.status === 200);
		check("the detail carries the media-quality block", "mos" in data(legDetail));
		check("the detail carries its recordings array", Array.isArray(data(legDetail).recordings));
		const foreignLeg = await clientB("GET", `/api/v1/cdr/${aLegId}`);
		check(
			"organization B cannot read organization A's leg",
			foreignLeg.status === 404,
			`status ${String(foreignLeg.status)}`,
		);
		const callDetail = await clientA("GET", `/api/v1/cdr/calls/${callOne}`);
		check("a call returns every leg that shares its call id", callDetail.status === 200);
		const callLegs = Array.isArray(data(callDetail).legs)
			? (data(callDetail).legs as Record<string, unknown>[])
			: [];
		check("the call has three legs", callLegs.length === 3, `${String(callLegs.length)} legs`);
		check(
			"the B-legs name the A-leg that dialled them",
			callLegs.filter((row) => row.originatingLegId === aLegId).length === 2,
		);
		const foreignCall = await clientB("GET", `/api/v1/cdr/calls/${callOne}`);
		check("organization B cannot read organization A's call", foreignCall.status === 404);

		// --- 12. quarantine ------------------------------------------------------------------------
		console.log("\n12. poison messages are quarantined, not dropped");
		await jetstream.publish(
			subjectFor.cdrLeg(organizationA),
			new TextEncoder().encode("this is not an envelope"),
			{ msgID: `garbage-${RUN_ID}` },
		);
		const quarantinedUnreadable = await waitFor("the unreadable message to be quarantined", async () => {
			const found = await cdrSql<{ total: number }[]>`
				select count(*)::int as total from "cdr_write_quarantine"
				where "reason" = 'unreadable' and "subject" = ${subjectFor.cdrLeg(organizationA)}
			`;
			return (found[0]?.total ?? 0) > 0;
		});
		check("bytes that are not a cdr.leg.write are quarantined as unreadable", quarantinedUnreadable);
		const quarantineRow = await cdrSql<{ stream: string; stream_sequence: string | null }[]>`
			select "stream", "stream_sequence" from "cdr_write_quarantine"
			where "reason" = 'unreadable' order by "quarantined_at" desc limit 1
		`;
		// `stream_sequence` is `bigint`, which postgres.js hands back as a STRING rather than a
		// number — a bigint does not fit a JS number, so the driver is right and the assertion is
		// about the VALUE being a usable sequence, not about its JavaScript type.
		const sequence = Number(quarantineRow[0]?.stream_sequence ?? Number.NaN);
		check(
			"the quarantine row names the stream and the sequence a replay would read from",
			quarantineRow[0]?.stream === "CDR" && Number.isInteger(sequence) && sequence > 0,
			JSON.stringify(quarantineRow[0] ?? {}),
		);
		// An envelope for organization B, published onto organization A's subject: the only failure
		// in the writer that could have scoped a write to the wrong tenant.
		const smuggledLegId = createEntityId();
		await publishLeg(
			organizationB,
			{ ...aLeg, id: smuggledLegId, callId: createEntityId(), startedAt: isoMinutesAgo(5) },
			{ subjectOverride: subjectFor.cdrLeg(organizationA), msgId: `smuggled-${RUN_ID}` },
		);
		const quarantinedForeign = await waitFor("the foreign-subject message to be quarantined", async () => {
			const found = await cdrSql<{ total: number }[]>`
				select count(*)::int as total from "cdr_write_quarantine" where "reason" = 'foreign-subject'
			`;
			return (found[0]?.total ?? 0) > 0;
		});
		check(
			"an envelope delivered on another organization's subject is quarantined, not written",
			quarantinedForeign,
		);
		const smuggledRows = await cdrSql<{ total: number }[]>`
			select count(*)::int as total from "call_legs" where "id" = ${smuggledLegId}::uuid
		`;
		check(
			"the smuggled leg reached no table at all",
			smuggledRows[0]?.total === 0,
			`${String(smuggledRows[0]?.total)} rows`,
		);

		// --- 13. recordings ------------------------------------------------------------------------
		console.log("\n13. recordings from channel.record.*");
		const recordingId = createEntityId();
		const objectKey = `${organizationA}/${callOne}/${recordingId}.wav`;
		await mkdir(dirname(join(recordingRoot, objectKey)), { recursive: true });
		// A minimal but real RIFF header, so the media route serves something a player accepts.
		await writeFile(join(recordingRoot, objectKey), Buffer.from("RIFF....WAVEfmt ", "ascii"));

		const started = makeCallEvent("channel.record.started", {
			orgId: organizationA,
			callId: callOne,
			source: "engine",
			data: { legId: aLegId, recordingId, objectKey, kind: "call" },
		});
		await jetstream.publish(started.subject, new TextEncoder().encode(JSON.stringify(started)), {
			msgID: started.id,
		});
		const stopped = makeCallEvent("channel.record.stopped", {
			orgId: organizationA,
			callId: callOne,
			source: "engine",
			data: { legId: aLegId, recordingId, objectKey, durationMs: 30_000, reason: "completed", bytes: 16 },
		});
		await jetstream.publish(stopped.subject, new TextEncoder().encode(JSON.stringify(stopped)), {
			msgID: stopped.id,
		});

		const recordingFiled = await waitFor("the recording row", async () => {
			const found = await cdrSql<{ duration_ms: number }[]>`
				select "duration_ms" from "recordings" where "object_key" = ${objectKey}
			`;
			return found[0]?.duration_ms === 30_000;
		});
		check("channel.record.* produced a finalized recordings row", recordingFiled);
		const enriched = await waitFor("the leg's recording_key", async () => {
			const found = await cdrSql<{ recording_key: string | null }[]>`
				select "recording_key" from "call_legs" where "id" = ${aLegId}::uuid
			`;
			return found[0]?.recording_key === objectKey;
		});
		check("the finished recording set call_legs.recording_key through the writer seam", enriched);
		const recordingRows = await cdrSql<{ total: number }[]>`
			select count(*)::int as total from "recordings" where "object_key" = ${objectKey}
		`;
		check(
			"started + stopped produced ONE row, not two",
			recordingRows[0]?.total === 1,
			`${String(recordingRows[0]?.total)} rows`,
		);

		const recordedFilter = await clientA("GET", "/api/v1/cdr?recorded=true&limit=50");
		check(
			"recorded=true narrows to legs that produced media",
			rows(recordedFilter).length === 1 && rows(recordedFilter)[0]?.id === aLegId,
		);

		const recordingsList = await clientA("GET", "/api/v1/recordings?limit=50");
		check("organization A can list its recordings", recordingsList.status === 200);
		check(
			"the recording is listed with its metadata",
			rows(recordingsList).some((row) => row.objectKey === objectKey),
		);
		const recordingsListB = await clientB("GET", "/api/v1/recordings?limit=50");
		check(
			"organization B sees none of organization A's recordings",
			rows(recordingsListB).length === 0,
			`${String(rows(recordingsListB).length)} rows`,
		);
		const recordingRowId = String(
			rows(recordingsList).find((row) => row.objectKey === objectKey)?.id ?? "",
		);
		const byKind = await clientA("GET", "/api/v1/recordings?kind=voicemail&limit=50");
		check("kind= narrows the recordings list", rows(byKind).length === 0);

		// --- 14. signed URLs -----------------------------------------------------------------------
		console.log("\n14. signed download URLs");
		const minted = await clientA("POST", `/api/v1/recordings/${recordingRowId}/download-url`, {});
		check("a download URL can be minted", minted.status === 201 || minted.status === 200, `status ${String(minted.status)}`);
		const signedUrl = String(data(minted).url ?? "");
		check("the minted URL carries a token rather than the recording id", signedUrl.length > 0 && !signedUrl.includes(recordingRowId), signedUrl.slice(0, 60));

		const fetched = await fetch(`${baseUrl}${signedUrl}`);
		check("the signed URL streams the object anonymously", fetched.status === 200, `status ${String(fetched.status)}`);
		check(
			"the response is typed as audio and marked private",
			(fetched.headers.get("content-type") ?? "").startsWith("audio/") &&
				(fetched.headers.get("cache-control") ?? "").includes("no-store"),
			`${String(fetched.headers.get("content-type"))} / ${String(fetched.headers.get("cache-control"))}`,
		);

		const token = new URL(signedUrl, baseUrl).searchParams.get("token") ?? "";
		const [encodedPayload, signature] = token.split(".");
		const tampered = `${Buffer.from(
			JSON.stringify({ r: recordingRowId, o: organizationB, e: Math.floor(Date.now() / 1000) + 60 }),
			"utf8",
		).toString("base64url")}.${String(signature)}`;
		const tamperedResponse = await fetch(
			`${baseUrl}/api/v1/recordings/media?token=${encodeURIComponent(tampered)}`,
		);
		check(
			"a token edited to name another organization is refused",
			tamperedResponse.status === 403,
			`status ${String(tamperedResponse.status)}`,
		);
		check(
			"the tampered payload really was different from the minted one",
			encodedPayload !== undefined && tampered.split(".")[0] !== encodedPayload,
		);

		// Expiry is proved by minting with a one-second TTL through the env the module already read,
		// which cannot be changed at runtime — so the token is forged with the SAME key instead,
		// which is exactly what an expired-but-genuine token is.
		const { mintRecordingToken } = await import("../src/cdr/recordings/recording-token");
		const expired = mintRecordingToken(
			{ r: recordingRowId, o: organizationA, e: Math.floor(Date.now() / 1000) - 10 },
			RECORDING_SECRET,
		);
		const expiredResponse = await fetch(
			`${baseUrl}/api/v1/recordings/media?token=${encodeURIComponent(expired)}`,
		);
		check(
			"an expired but genuine token is a 410, not a 403",
			expiredResponse.status === 410,
			`status ${String(expiredResponse.status)}`,
		);
		const wrongKey = mintRecordingToken(
			{ r: recordingRowId, o: organizationA, e: Math.floor(Date.now() / 1000) + 60 },
			"a-different-signing-key-that-is-long-enough-01",
		);
		const wrongKeyResponse = await fetch(
			`${baseUrl}/api/v1/recordings/media?token=${encodeURIComponent(wrongKey)}`,
		);
		check(
			"a token signed with another key is a 403",
			wrongKeyResponse.status === 403,
			`status ${String(wrongKeyResponse.status)}`,
		);
		const crossTenantMint = await clientB(
			"POST",
			`/api/v1/recordings/${recordingRowId}/download-url`,
			{},
		);
		check(
			"organization B cannot mint a URL for organization A's recording",
			crossTenantMint.status === 404,
			`status ${String(crossTenantMint.status)}`,
		);
	} finally {
		console.log("\ncleaning up");
		try {
			await publisher.drain();
		} catch {
			// The connection may already be closing.
		}
		try {
			await app.close();
			if (organizationA) {
				await sql`delete from "organization" where "id" = ${organizationA}`;
			}
			if (organizationB) {
				await sql`delete from "organization" where "id" = ${organizationB}`;
			}
			await sql`delete from "user" where "email" in (${ownerEmail}, ${otherEmail})`;
			for (const organizationId of [organizationA, organizationB].filter(Boolean)) {
				await cdrSql`delete from "recordings" where "organization_id" = ${organizationId}::uuid`;
				await cdrSql`delete from "call_events" where "organization_id" = ${organizationId}::uuid`;
				await cdrSql`delete from "call_legs" where "organization_id" = ${organizationId}::uuid`;
				await cdrSql`delete from "cdr_write_quarantine" where "organization_id" = ${organizationId}::uuid`;
			}
			// Quarantine rows for unreadable bytes carry no organization, so they are swept by subject.
			await cdrSql`delete from "cdr_write_quarantine" where "subject" like ${`cdr.leg.v1.${organizationA}`}`;
		} catch (error) {
			console.error("cleanup failed", error);
		}
		await sql.end({ timeout: 5 });
		await cdrSql.end({ timeout: 5 });
		try {
			await execFileAsync("docker", ["rm", "-f", nats.containerId]);
		} catch (error) {
			console.error("could not remove the NATS container", error);
		}
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.error(`FAILED: ${failed.map((entry) => entry.name).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log("CDR area verification PASSED");
}

await main();
