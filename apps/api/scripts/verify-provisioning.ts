/**
 * End-to-end verification of the device-provisioning area.
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/api verify:provisioning
 *
 * It boots the real HTTP slice — `createApiRootModule([], [PbxModule, ProvisioningModule])` on an
 * ephemeral port against a real PostgreSQL — and drives it as a client and as a phone would.
 * `AppModule` is excluded for the same reason `verify-pbx.ts` excludes it: its `RuntimeHostService`
 * starts the gRPC servers, the ARI client and the InfluxDB writer, none of which this gate is about.
 *
 * What it proves, in order:
 *
 *  1. Device, profile, line and key CRUD round-trips, including MAC normalization and the per-org
 *     uniqueness that normalization is what makes real.
 *  2. A profile a device still points at cannot be deleted, and the 409 names the device.
 *  3. The four-level settings cascade resolves model < organization < profile < device, observed
 *     through what the rendered configuration actually contains.
 *  4. Each of the five vendor templates renders with the account lines a phone needs, in its own
 *     syntax, with its own filename and content type.
 *  5. **Token authentication.** A valid token renders; an invalid one, an unknown one, a revoked
 *     one and one for a disabled device all produce the SAME 404 body — the property that keeps the
 *     endpoint from being an oracle. Regenerating invalidates the previous token immediately.
 *  6. The rate limit trips and answers 429 with `Retry-After`.
 *  7. `provision.evt.v1.<orgId>` carries `device.requested`, `device.rendered` and
 *     `device.rejected` with the reasons the response deliberately does not disclose.
 *  8. RLS isolation: organization B cannot see, read, patch or delete A's devices, cannot reach
 *     A's device through a nested route, and can hold the same MAC address itself.
 *
 * The NATS half is skipped, loudly, when Docker is unavailable.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
/** Shared with `verify-auth-slice.ts`: better-auth encrypts its JWKS keys with it. */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const RUN_ID = Date.now().toString(36);

const SIP_SERVER = "pbx.verify.optimiq.test";
const SECRET_KEY = "verify-provisioning-root-key-0123456789";

/**
 * A distinct, well-formed MAC per call.
 *
 * Twelve lower-case hex characters, prefixed with a plausible OUI, with the run's start time and a
 * counter in the tail. MACs are unique per organization, so a fixed address would make two runs — or
 * one run and the leftovers of a crashed one — collide with a 409 that has nothing to do with what
 * the run is checking.
 */
let macCounter = 0;
function runMac(): string {
	macCounter += 1;
	const tail = ((Date.now() % 0x100_0000) * 0x100 + macCounter) % 0x1_0000_0000;
	return `0015${tail.toString(16).padStart(8, "0")}`.slice(0, 12);
}

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

/** A phone: no session, no cookie jar, raw text back. */
async function fetchAsPhone(
	url: string,
	userAgent = "Yealink SIP-T54W 96.86.0.15",
): Promise<{ status: number; body: string; contentType: string; retryAfter: string | null }> {
	const response = await fetch(url, { headers: { "user-agent": userAgent } });
	return {
		status: response.status,
		body: await response.text(),
		contentType: response.headers.get("content-type") ?? "",
		retryAfter: response.headers.get("retry-after"),
	};
}

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

function provisioning(response: JsonResponse): Record<string, unknown> {
	const value = response.body.provisioning;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function tokenOf(response: JsonResponse): string {
	const value = provisioning(response).token;
	return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------------------------
// Docker-managed NATS
// ---------------------------------------------------------------------------------------------

interface NatsHandle {
	readonly url: string;
	readonly containerId: string;
}

const NATS_CONTAINER_PREFIX = "optimiq-verify-provisioning";

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
			console.log(`  (removed ${stale.length} stale container(s))`);
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
			`  (docker unavailable — event checks will be skipped: ${
				error instanceof Error ? error.message.split("\n")[0] : String(error)
			})`,
		);
		return undefined;
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

	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.PBX_DATABASE_URL = pbxDatabaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;
	process.env.PROVISION_SIP_SERVER = SIP_SERVER;
	process.env.PROVISION_SIP_SECRET_KEY = SECRET_KEY;
	process.env.PROVISION_BASE_URL = baseUrl;
	// Small enough to trip deliberately, large enough that the ordinary render checks below do not.
	process.env.PROVISION_RATE_LIMIT_PER_MINUTE = "6";
	if (nats === undefined) {
		delete process.env.NATS_URL;
	} else {
		process.env.NATS_URL = nats.url;
	}

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule, registerAuthTransport } = await import("../src/auth/auth-bootstrap");
	const { PbxModule } = await import("../src/pbx/pbx.module");
	const { ProvisioningModule } = await import("../src/provisioning/provisioning.module");
	const { createPostgresClient } = await import("@optimiq-voice/db");
	const { subjectFilterFor } = await import("@optimiq-voice/events/subjects");

	const sql = createPostgresClient({
		url: databaseUrl,
		applicationName: "verify-provisioning",
		poolMaxConnectionsOverride: 2,
	});

	console.log(`booting the auth slice + PBX area + provisioning on ${baseUrl}\n`);
	const app = await NestFactory.create(
		createApiRootModule([], [PbxModule, ProvisioningModule]),
		new FastifyAdapter(),
		{ logger: ["error"] },
	);
	app.enableShutdownHooks();
	await registerAuthTransport(app);
	await app.listen(port, "127.0.0.1");
	await delay(200);

	const ownerEmail = `prov-owner-${RUN_ID}@verify.optimiq.test`;
	const otherEmail = `prov-other-${RUN_ID}@verify.optimiq.test`;
	const password = "Verify-Provisioning-2026!";
	const jarA = new CookieJar();
	const jarB = new CookieJar();
	const clientA: Client = makeClient(baseUrl, jarA);
	const clientB: Client = makeClient(baseUrl, jarB);
	let organizationA = "";
	let organizationB = "";

	// A subscriber for the provisioning events, opened before any render happens.
	let natsConnection: import("nats").NatsConnection | undefined;
	const observedEvents: { type: string; orgId: string; data: Record<string, unknown> }[] = [];

	try {
		// --- 0. two tenants --------------------------------------------------------------------
		console.log("0. two organizations");
		await clientA("POST", "/api/auth/sign-up/email", {
			name: "Provisioning Owner A",
			email: ownerEmail,
			password,
		});
		const createA = await clientA("POST", "/api/auth/organization/create", {
			name: `Prov Org A ${RUN_ID}`,
			slug: `prov-org-a-${RUN_ID}`,
		});
		organizationA = typeof createA.body.id === "string" ? createA.body.id : "";
		await clientA("POST", "/api/auth/organization/set-active", { organizationId: organizationA });
		check("organization A created", organizationA.length > 0, organizationA);

		await clientB("POST", "/api/auth/sign-up/email", {
			name: "Provisioning Owner B",
			email: otherEmail,
			password,
		});
		const createB = await clientB("POST", "/api/auth/organization/create", {
			name: `Prov Org B ${RUN_ID}`,
			slug: `prov-org-b-${RUN_ID}`,
		});
		organizationB = typeof createB.body.id === "string" ? createB.body.id : "";
		await clientB("POST", "/api/auth/organization/set-active", { organizationId: organizationB });
		check("organization B created", organizationB.length > 0, organizationB);

		if (nats !== undefined) {
			const { connect } = await import("nats");
			natsConnection = await connect({ servers: nats.url, name: "verify-provisioning-sub" });
			const subscription = natsConnection.subscribe(subjectFilterFor.allProvision());
			void (async () => {
				for await (const message of subscription) {
					try {
						const envelope = JSON.parse(new TextDecoder().decode(message.data)) as {
							type?: string;
							orgId?: string;
							data?: Record<string, unknown>;
						};
						observedEvents.push({
							type: String(envelope.type ?? ""),
							orgId: String(envelope.orgId ?? ""),
							data: envelope.data ?? {},
						});
					} catch {
						// A malformed message is not this harness's problem.
					}
				}
			})();
			await delay(200);
		}

		// --- 1. the area denies by default --------------------------------------------------------
		console.log("\n1. the CRUD surface denies by default");
		const anonymousList = await fetch(`${baseUrl}/api/v1/devices`);
		check(
			"an anonymous device list is 401",
			anonymousList.status === 401,
			`status ${anonymousList.status}`,
		);
		const anonymousCatalog = await fetch(`${baseUrl}/api/v1/provisioning/catalog`);
		check(
			"an anonymous catalog read is 401",
			anonymousCatalog.status === 401,
			`status ${anonymousCatalog.status}`,
		);

		// --- 2. the catalogue ---------------------------------------------------------------------
		console.log("\n2. the vendor catalogue");
		const catalog = await clientA("GET", "/api/v1/provisioning/catalog");
		const vendors = Array.isArray(data(catalog).vendors)
			? (data(catalog).vendors as Record<string, unknown>[])
			: [];
		check("catalog returns 200", catalog.status === 200);
		check(
			"catalog covers the five v1 vendors plus softphone and generic",
			vendors.length === 7,
			`${vendors.length} entries`,
		);
		check(
			"catalog reports the deployment as configured",
			data(catalog).configured === true,
			JSON.stringify(data(catalog).missing),
		);
		check(
			"every provisionable vendor ships its sources and its caveats",
			vendors
				.filter((entry) => entry.provisionable === true && entry.vendor !== "softphone")
				.every(
					(entry) =>
						Array.isArray(entry.sources) &&
						entry.sources.length > 0 &&
						Array.isArray(entry.caveats) &&
						entry.caveats.length > 0,
				),
		);

		// --- 3. device CRUD -------------------------------------------------------------------------
		console.log("\n3. device CRUD");
		const macA = runMac();
		const created = await clientA("POST", "/api/v1/devices", {
			// Deliberately the colon-separated spelling an administrator reads off the sticker.
			macAddress: macA.replace(/(..)(?=.)/gu, "$1:").toUpperCase(),
			vendor: "yealink",
			model: "T54W",
			label: "Reception",
		});
		check(
			"create device -> 200",
			created.status === 200 || created.status === 201,
			`status ${created.status}`,
		);
		const deviceA = id(created);
		check("create returns the row with an id", deviceA.length > 0, deviceA);
		check(
			"the MAC is normalized to twelve lower-case hex characters",
			data(created).macAddress === macA,
			String(data(created).macAddress),
		);
		const tokenA = tokenOf(created);
		check(
			"create mints a provisioning token, shown once",
			tokenA.includes("."),
			`${tokenA.length} chars`,
		);
		check(
			"create returns the URL a phone fetches",
			String(provisioning(created).configUrl ?? "").startsWith(`${baseUrl}/provision/`),
			String(provisioning(created).configUrl),
		);
		check(
			"the plaintext token is NOT the stored reference",
			data(created).provisioningToken !== tokenA &&
				tokenA.startsWith(`${String(data(created).provisioningToken)}.`),
			String(data(created).provisioningToken),
		);
		/**
		 * Inverted deliberately. This used to assert that the response carried a 64-hex digest,
		 * which passed — and in passing documented that `provisioning_token_hash` was on the wire.
		 * The digest is the stored half of a live credential and is now `secretColumns` on
		 * `DEVICE_RESOURCE`, so the thing worth checking is that it is NOT there.
		 */
		check(
			"the stored hash never leaves the server",
			data(created).provisioningTokenHash === undefined &&
				!Object.hasOwn(data(created), "provisioningTokenHash"),
			String(data(created).provisioningTokenHash),
		);

		const duplicate = await clientA("POST", "/api/v1/devices", {
			// A DIFFERENT spelling of the same address must still collide.
			macAddress: macA.replace(/(....)(?=.)/gu, "$1.").toUpperCase(),
			vendor: "yealink",
		});
		check(
			"a MAC re-entered in another spelling is a 409, not a second row",
			duplicate.status === 409 && duplicate.body.code === "PBX_CONFLICT",
			`status ${duplicate.status}`,
		);

		const badMac = await clientA("POST", "/api/v1/devices", { macAddress: "not-a-mac" });
		check("a malformed MAC is a field-addressed 400", badMac.status === 400);

		const unknownKey = await clientA("POST", "/api/v1/devices", {
			macAddress: runMac(),
			provisioningToken: "attacker-chosen",
		});
		check(
			"a client-supplied provisioning token is refused, not silently dropped",
			unknownKey.status === 400,
			`status ${unknownKey.status}`,
		);

		const listed = await clientA("GET", "/api/v1/devices");
		check("list returns the device", listed.status === 200 && rows(listed).length === 1);
		check(
			"list carries the paging envelope",
			listed.body.total === 1 && listed.body.page === 1 && listed.body.limit === 20,
		);

		const searched = await clientA(
			"GET",
			`/api/v1/devices?search=${encodeURIComponent(
				macA
					.slice(0, 6)
					.replace(/(..)(?=.)/gu, "$1:")
					.toUpperCase(),
			)}`,
		);
		check(
			"searching by the MAC spelling on the sticker finds the row",
			rows(searched).length === 1,
			`${rows(searched).length} row(s)`,
		);

		const patched = await clientA("PATCH", `/api/v1/devices/${deviceA}`, { label: "Front desk" });
		check(
			"patch applies only the supplied keys",
			patched.status === 200 && data(patched).label === "Front desk",
		);

		// --- 4. profiles ----------------------------------------------------------------------------
		console.log("\n4. device profiles");
		const profile = await clientA("POST", "/api/v1/device-profiles", {
			name: `Desk phones ${RUN_ID}`,
			vendor: "yealink",
			settings: { "local_time.time_zone": "+0", "features.dnd.enable": 1 },
		});
		check("create profile -> 201", profile.status === 201, `status ${profile.status}`);
		const profileId = id(profile);

		const profileKey = await clientA("POST", `/api/v1/device-profiles/${profileId}/keys`, {
			category: "memory",
			keyIndex: 1,
			keyType: "blf",
			value: "2001",
			label: "Profile BLF",
		});
		check("create a profile key -> 201", profileKey.status === 201, `status ${profileKey.status}`);

		await clientA("PATCH", `/api/v1/devices/${deviceA}`, { deviceProfileId: profileId });

		const refusedDelete = await clientA("DELETE", `/api/v1/device-profiles/${profileId}`);
		const references = Array.isArray(refusedDelete.body.references)
			? (refusedDelete.body.references as Record<string, unknown>[])
			: [];
		check(
			"deleting a profile a device uses is a 409",
			refusedDelete.status === 409 && refusedDelete.body.code === "PBX_REFERENCED",
			`status ${refusedDelete.status}`,
		);
		check(
			"the 409 names the device rather than just refusing",
			references.some((entry) => entry.id === deviceA),
			JSON.stringify(references.map((entry) => entry.kind)),
		);

		// --- 5. lines and keys ------------------------------------------------------------------------
		console.log("\n5. lines and keys");
		const extension = await clientA("POST", "/api/v1/extensions", {
			number: "1001",
			label: "Alice Nguyen",
			sipSecretRef: `secret://verify-prov/${RUN_ID}/1001`,
		});
		const extensionId = id(extension);
		check("an extension exists to assign", extensionId.length > 0);

		const line = await clientA("POST", `/api/v1/devices/${deviceA}/lines`, {
			lineNumber: 1,
			extensionId,
			label: "Reception",
		});
		check("create a device line -> 201", line.status === 201, `status ${line.status}`);

		const duplicateLine = await clientA("POST", `/api/v1/devices/${deviceA}/lines`, {
			lineNumber: 1,
			extensionId,
		});
		check("a second line on the same number is a 409", duplicateLine.status === 409);

		const deviceKey = await clientA("POST", `/api/v1/devices/${deviceA}/keys`, {
			category: "memory",
			keyIndex: 1,
			keyType: "speed-dial",
			value: "3001",
			label: "Device override",
		});
		check("create a device key -> 201", deviceKey.status === 201, `status ${deviceKey.status}`);

		const listedLines = await clientA("GET", `/api/v1/devices/${deviceA}/lines`);
		check("list lines returns the collection unpaginated", rows(listedLines).length === 1);

		const orphanLines = await clientA(
			"GET",
			"/api/v1/devices/019fd3c2-dead-76be-a6b3-b0f1914e39b6/lines",
		);
		check("a nested route under an unknown device is a 404", orphanLines.status === 404);

		// --- 6. the render endpoint, authenticated by token ---------------------------------------
		console.log("\n6. the render endpoint");
		const configUrl = `${baseUrl}/provision/${tokenA}/config`;
		const rendered = await fetchAsPhone(configUrl);
		check("a valid token renders 200", rendered.status === 200, `status ${rendered.status}`);
		check(
			"the body is the vendor's own format, not JSON",
			rendered.body.startsWith("#!version:1.0.0.1"),
			rendered.body.split("\n")[0] ?? "",
		);
		check(
			"the content type is the template's",
			rendered.contentType.includes("text/plain"),
			rendered.contentType,
		);
		check(
			"the account carries the extension's credentials",
			rendered.body.includes("account.1.user_name = 1001") &&
				rendered.body.includes("account.1.auth_name = 1001"),
		);
		check(
			"the account carries a derived password rather than an empty field",
			/account\.1\.password = [A-Za-z0-9_-]{24}/u.test(rendered.body),
		);
		check(
			"the server address comes from PROVISION_SIP_SERVER",
			rendered.body.includes(`account.1.sip_server.1.address = ${SIP_SERVER}`),
		);

		// --- 7. the cascade, observed through the rendered output -----------------------------------
		console.log("\n7. the settings cascade");
		check(
			"a profile setting reaches the configuration",
			rendered.body.includes("local_time.time_zone = +0"),
		);
		await clientA("PATCH", `/api/v1/devices/${deviceA}`, {
			settings: { "local_time.time_zone": "+1", "phone.only.here": "device" },
		});
		const overridden = await fetchAsPhone(configUrl);
		check(
			"a device setting OVERRIDES the profile's",
			overridden.body.includes("local_time.time_zone = +1") &&
				!overridden.body.includes("local_time.time_zone = +0"),
		);
		check(
			"a device-only setting is additive rather than replacing the profile's bag",
			overridden.body.includes("phone.only.here = device") &&
				overridden.body.includes("features.dnd.enable = 1"),
		);
		check(
			"a device key overrides the profile key at the same (category, index)",
			overridden.body.includes("linekey.1.value = 3001") &&
				!overridden.body.includes("linekey.1.value = 2001"),
		);

		// --- 8. every vendor renders --------------------------------------------------------------
		console.log("\n8. every vendor template renders");
		const vendorExpectations: readonly {
			vendor: string;
			model: string;
			needle: string;
			contentType: string;
		}[] = [
			{ vendor: "poly", model: "VVX450", needle: 'reg.1.auth.userId="1002"', contentType: "xml" },
			{
				vendor: "grandstream",
				model: "GRP2615",
				needle: '<item name="account.1.sip.userid">1002</item>',
				contentType: "xml",
			},
			{
				vendor: "fanvil",
				model: "X5U",
				needle: "SIP1 Register User :1002",
				contentType: "text/plain",
			},
			{
				vendor: "snom",
				model: "D785",
				needle: '<user_pname idx="1" perm="R">1002</user_pname>',
				contentType: "xml",
			},
			{
				vendor: "softphone",
				model: "GROUNDWIRE",
				needle: '"username": "1002"',
				contentType: "json",
			},
		];

		const secondExtension = await clientA("POST", "/api/v1/extensions", {
			number: "1002",
			label: "Ben Okafor",
			sipSecretRef: `secret://verify-prov/${RUN_ID}/1002`,
		});
		const secondExtensionId = id(secondExtension);

		for (const expectation of vendorExpectations) {
			const device = await clientA("POST", "/api/v1/devices", {
				macAddress: runMac(),
				vendor: expectation.vendor,
				model: expectation.model,
				label: `${expectation.vendor} test`,
			});
			const deviceId = id(device);
			await clientA("POST", `/api/v1/devices/${deviceId}/lines`, {
				lineNumber: 1,
				extensionId: secondExtensionId,
			});
			await clientA("POST", `/api/v1/devices/${deviceId}/keys`, {
				category: "memory",
				keyIndex: 1,
				keyType: "blf",
				value: "1001",
				label: "Alice",
			});
			const result = await fetchAsPhone(`${baseUrl}/provision/${tokenOf(device)}/config`);
			check(
				`${expectation.vendor} renders 200 with its own account line`,
				result.status === 200 && result.body.includes(expectation.needle),
				result.status === 200 ? "body did not contain the account line" : `status ${result.status}`,
			);
			check(
				`${expectation.vendor} answers with its own content type`,
				result.contentType.includes(expectation.contentType),
				result.contentType,
			);
		}

		// --- 9. the softphone payload ------------------------------------------------------------
		console.log("\n9. the softphone payload");
		const payloadResponse = await fetch(`${baseUrl}/provision/${tokenA}/payload`);
		const payload = (await payloadResponse.json()) as { data?: Record<string, unknown> };
		const accounts = Array.isArray(payload.data?.accounts)
			? (payload.data.accounts as Record<string, unknown>[])
			: [];
		check("the payload endpoint answers 200", payloadResponse.status === 200);
		check("the payload carries one account per line", accounts.length === 1);
		check(
			"the payload's sip URI is complete enough to type in by hand",
			String(accounts[0]?.sipUri ?? "").startsWith("sip:1001:"),
			String(accounts[0]?.sipUri),
		);
		check(
			"the QR target is the payload URL, not a sip: URI that would place a call",
			String((payload.data?.qr as Record<string, unknown> | undefined)?.url ?? "").includes(
				"/payload",
			),
		);
		check(
			"the payload is not cached by anything in the path",
			payloadResponse.headers.get("cache-control") === "no-store",
			String(payloadResponse.headers.get("cache-control")),
		);

		// --- 10. token authentication ---------------------------------------------------------------
		console.log("\n10. token authentication");
		const reference = String(data(created).provisioningToken);
		const unknownToken = await fetchAsPhone(
			`${baseUrl}/provision/AAAAAAAAAAAAAAAAAAAAAA.zzzz/config`,
		);
		check("an unknown token is 404", unknownToken.status === 404, `status ${unknownToken.status}`);

		const wrongSecret = await fetchAsPhone(`${baseUrl}/provision/${reference}.wrongsecret/config`);
		check("a valid reference with the wrong secret is 404", wrongSecret.status === 404);
		check(
			"unknown and wrong-secret are INDISTINGUISHABLE — the endpoint is not an oracle",
			unknownToken.body === wrongSecret.body,
			`"${unknownToken.body.slice(0, 60)}" vs "${wrongSecret.body.slice(0, 60)}"`,
		);

		const referenceOnly = await fetchAsPhone(`${baseUrl}/provision/${reference}/config`);
		check(
			"the reference alone does not authenticate — the secret is not optional",
			referenceOnly.status === 404,
			`status ${referenceOnly.status}`,
		);

		/**
		 * An absurd token is refused by Fastify's router (414, `FST_ERR_MAX_PARAM_LENGTH`) before it
		 * ever reaches the handler, which is earlier than our own length guard and therefore better.
		 * 404 is accepted too so the check keeps meaning if that default ever moves.
		 *
		 * The pair matters: the router's cap is 100 characters by default, and a minted token is 66.
		 * If the token ever grew past the cap, EVERY phone would get a 414 — so the second assertion
		 * pins the margin rather than leaving it to be discovered in production.
		 */
		const malformed = await fetchAsPhone(`${baseUrl}/provision/${"x".repeat(400)}/config`);
		check(
			"an absurd token is refused before any query",
			malformed.status === 414 || malformed.status === 404,
			`status ${malformed.status}`,
		);
		check(
			"a real token is comfortably under the router's parameter cap",
			tokenA.length < 100,
			`${tokenA.length} chars`,
		);

		// Disable the device: same 404, same body.
		await clientA("PATCH", `/api/v1/devices/${deviceA}`, { enabled: false });
		const disabled = await fetchAsPhone(configUrl);
		check("a disabled device does not serve a configuration", disabled.status === 404);
		check(
			"disabled is INDISTINGUISHABLE from unknown — no enrolment is confirmed",
			disabled.body === unknownToken.body,
		);
		await clientA("PATCH", `/api/v1/devices/${deviceA}`, { enabled: true });

		// Rotation invalidates the previous token, immediately.
		const rotated = await clientA("POST", `/api/v1/devices/${deviceA}/provisioning-token`, {});
		const tokenA2 = tokenOf(rotated);
		check("rotation returns a new token", tokenA2.length > 0 && tokenA2 !== tokenA);
		const oldToken = await fetchAsPhone(configUrl);
		check(
			"the PREVIOUS token stops working the instant it is rotated",
			oldToken.status === 404,
			`status ${oldToken.status}`,
		);
		const newToken = await fetchAsPhone(`${baseUrl}/provision/${tokenA2}/config`);
		check("the new token works", newToken.status === 200, `status ${newToken.status}`);

		const expiring = await clientA("POST", `/api/v1/devices/${deviceA}/provisioning-token`, {
			expiresInDays: 0,
		});
		check("a zero TTL means no expiry", provisioning(expiring).expiresAt === null);
		const tokenA3 = tokenOf(expiring);

		// --- 11. the rate limit --------------------------------------------------------------------
		console.log("\n11. the rate limit");
		let limited: Awaited<ReturnType<typeof fetchAsPhone>> | undefined;
		for (let attempt = 0; attempt < 12; attempt += 1) {
			const response = await fetchAsPhone(`${baseUrl}/provision/${tokenA3}/config`);
			if (response.status === 429) {
				limited = response;
				break;
			}
		}
		check(
			"the rate limit trips with a 429",
			limited?.status === 429,
			`status ${limited?.status ?? "never"}`,
		);
		check(
			"the 429 carries Retry-After so a phone in a boot loop can back off",
			limited?.retryAfter !== null && limited?.retryAfter !== undefined,
			String(limited?.retryAfter),
		);

		// --- 12. RLS isolation ----------------------------------------------------------------------
		console.log("\n12. RLS isolation between the two organizations");
		const listB = await clientB("GET", "/api/v1/devices");
		check(
			"organization B sees none of A's devices",
			listB.status === 200 && rows(listB).length === 0,
			`${rows(listB).length} row(s)`,
		);
		const crossRead = await clientB("GET", `/api/v1/devices/${deviceA}`);
		check("B reading A's device by id is 404", crossRead.status === 404);
		const crossPatch = await clientB("PATCH", `/api/v1/devices/${deviceA}`, { label: "hijacked" });
		check("B patching A's device is 404", crossPatch.status === 404);
		const crossDelete = await clientB("DELETE", `/api/v1/devices/${deviceA}`);
		check("B deleting A's device is 404", crossDelete.status === 404);
		const crossLines = await clientB("GET", `/api/v1/devices/${deviceA}/lines`);
		check("B listing A's device's lines is 404", crossLines.status === 404);
		const crossRotate = await clientB("POST", `/api/v1/devices/${deviceA}/provisioning-token`, {});
		check(
			"B cannot rotate A's provisioning token",
			crossRotate.status === 404,
			`status ${crossRotate.status}`,
		);
		const crossProfiles = await clientB("GET", "/api/v1/device-profiles");
		check("B sees none of A's profiles", rows(crossProfiles).length === 0);

		const bOwnMac = await clientB("POST", "/api/v1/devices", {
			macAddress: macA,
			vendor: "yealink",
			label: "B's own phone",
		});
		check(
			"B may hold the same MAC — uniqueness is per organization, matching the schema",
			bOwnMac.status === 200 || bOwnMac.status === 201,
			`status ${bOwnMac.status}`,
		);
		const bToken = tokenOf(bOwnMac);
		const bRender = await fetchAsPhone(`${baseUrl}/provision/${bToken}/config`);
		check(
			"B's token renders B's device, never A's",
			bRender.status === 200 && !bRender.body.includes("1001"),
			`status ${bRender.status}`,
		);

		const stillThere = await clientA("GET", `/api/v1/devices/${deviceA}`);
		check(
			"A's device survived every one of B's attempts",
			stillThere.status === 200 && data(stillThere).label === "Front desk",
		);

		// --- 13. events -----------------------------------------------------------------------------
		console.log("\n13. provisioning events");
		if (nats === undefined) {
			console.log("  (skipped — no broker)");
		} else {
			await delay(600);
			const forA = observedEvents.filter((event) => event.orgId === organizationA);
			check(
				"device.requested is published for an authenticated fetch",
				forA.some((event) => event.type === "device.requested"),
				`${forA.length} event(s) for org A`,
			);
			check(
				"device.rendered is published with the template that produced the config",
				forA.some(
					(event) =>
						event.type === "device.rendered" &&
						typeof event.data.templateId === "string" &&
						Number(event.data.bytes) > 0,
				),
			);
			check(
				"device.rejected carries the reason the HTTP response deliberately withheld",
				forA.some(
					(event) => event.type === "device.rejected" && event.data.reason === "invalid-token",
				),
				JSON.stringify(
					forA
						.filter((event) => event.type === "device.rejected")
						.map((event) => event.data.reason),
				),
			);
			check(
				"a rate-limited fetch is published as such",
				forA.some(
					(event) => event.type === "device.rejected" && event.data.reason === "rate-limited",
				),
			);
			check(
				"a disabled device's refusal is published as `disabled`, not as an invalid token",
				forA.some((event) => event.type === "device.rejected" && event.data.reason === "disabled"),
			);
			check(
				"every event carries the normalized MAC",
				forA
					.filter(
						(event) => event.type !== "device.rejected" || event.data.macAddress !== undefined,
					)
					.every((event) => /^[0-9a-f]{12}$/u.test(String(event.data.macAddress ?? ""))),
			);
			check(
				"no event for organization A leaked into organization B's subject",
				!observedEvents.some(
					(event) => event.orgId === organizationB && String(event.data.macAddress) === macA,
				) || observedEvents.filter((event) => event.orgId === organizationB).length > 0,
			);
		}

		// --- 14. the check-in record ------------------------------------------------------------------
		console.log("\n14. the check-in record");
		const afterRender = await clientA("GET", `/api/v1/devices/${deviceA}`);
		check(
			"a successful render records when the phone last checked in",
			typeof data(afterRender).lastProvisionedAt === "string",
			String(data(afterRender).lastProvisionedAt),
		);
		const rotatedAgain = await clientA("POST", `/api/v1/devices/${deviceA}/provisioning-token`, {});
		check(
			"rotating clears the check-in record, so the UI does not report a dead URL as recent",
			data(rotatedAgain).lastProvisionedAt === null,
			String(data(rotatedAgain).lastProvisionedAt),
		);

		// --- 15. delete ----------------------------------------------------------------------------
		console.log("\n15. delete");
		const removed = await clientA("DELETE", `/api/v1/devices/${deviceA}`);
		check("delete a device -> 200", removed.status === 200, `status ${removed.status}`);
		const goneRender = await fetchAsPhone(`${baseUrl}/provision/${tokenOf(rotatedAgain)}/config`);
		check("a deleted device's token stops resolving", goneRender.status === 404);
		const nowDeletable = await clientA("DELETE", `/api/v1/device-profiles/${profileId}`);
		check(
			"the profile becomes deletable once nothing points at it",
			nowDeletable.status === 200,
			`status ${nowDeletable.status}`,
		);
	} catch (error) {
		console.error("\nverification threw", error);
		check(
			"the harness ran to completion",
			false,
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		console.log("\ncleaning up");
		try {
			if (natsConnection !== undefined && !natsConnection.isClosed()) {
				await natsConnection.drain();
			}
			await app.close();
			if (organizationA) {
				await sql`delete from "organization" where "id" = ${organizationA}`;
			}
			if (organizationB) {
				await sql`delete from "organization" where "id" = ${organizationB}`;
			}
			await sql`delete from "user" where "email" in (${ownerEmail}, ${otherEmail})`;
			const { createPbxDatabaseClient, sql: pbxSql } = await import("@optimiq-voice/pbx-db");
			const pbx = createPbxDatabaseClient({
				url: pbxDatabaseUrl,
				applicationName: "verify-provisioning-cleanup",
				poolMaxConnectionsOverride: 2,
			});
			try {
				for (const organizationId of [organizationA, organizationB].filter(Boolean)) {
					await pbx.withTenantScope(organizationId, async (transaction) => {
						for (const table of [
							"device_key",
							"device_line",
							"device",
							"device_profile_key",
							"device_profile",
							"org_setting",
							"extension",
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
			try {
				await execFileAsync("docker", ["rm", "-f", nats.containerId]);
			} catch (error) {
				console.error("could not remove the NATS container", error);
			}
		}
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.error(`FAILED: ${failed.map((entry) => entry.name).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log("device provisioning verification PASSED");
}

await main();
