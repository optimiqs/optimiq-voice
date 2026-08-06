/**
 * End-to-end verification of the voicemail surface.
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/api verify:voicemail
 *
 * `verify-pbx.ts` proves the CRUD and the routing artifact; this proves the four things that were
 * follow-ups when the compiler's voicemail embeddings landed, and it proves them against the same
 * real stack — the auth slice plus the PBX area on an ephemeral port, a real PostgreSQL, and a
 * real NATS in Docker.
 *
 *  1. **The snapshot loader.** `moh_class` and `voicemail_greeting` are loaded and
 *     `voicemail_box.pin_hash` with them, so the compiled artifact carries a mailbox's greeting,
 *     its PIN digest and a resolved MOH class NAME. Until this landed the compiler embedded none
 *     of them, and `*97` authenticated by the calling extension — which is to say, not at all.
 *  2. **The set-PIN endpoint.** The digest it writes is parseable by `packages/routing` (the
 *     package that owns the format and deliberately holds no KDF) and verifies against the PIN it
 *     was made from — checked with the same code path `apps/engine` uses, not with a regex.
 *  3. **The messages API.** List, read/unread, delete-to-trash, purge, signed playback, and the
 *     MWI counts that follow each of them. Plus the two negatives that matter: a tampered token is
 *     refused, and organization B cannot see organization A's mailbox at all.
 *  4. **`rpc.voicemail.v1.list`.** The responder the engine's `*97` menu has been calling into
 *     silence. Including the cross-check `packages/events` states in the request schema itself:
 *     `mailboxNumber` is a CLAIM to be checked against the box, never authorization, because a
 *     broker request is not a session.
 *
 * The NATS half is skipped, loudly, when Docker is unavailable. Everything else still runs.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The tagged-template `sql` from `@optimiq-voice/pbx-db`, as a type.
 *
 * A `typeof import(...)` rather than a hand-written signature: the seed helpers hand its output
 * straight to Drizzle's `execute`, so the two have to agree about what a fragment is, and a
 * simplified local signature would type-check here and fail there.
 */
type PbxSql = typeof import("@optimiq-voice/pbx-db").sql;

const execFileAsync = promisify(execFile);

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
/** Shared with `verify-auth-slice.ts` for the reason that script records: one JWKS, one secret. */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
/** 32 characters minimum, which the env schema enforces at boot rather than at first download. */
const MEDIA_SECRET = "verify-voicemail-media-secret-0123456789";
const RUN_ID = Date.now().toString(36);

const MAILBOX_NUMBER = `9${(Date.now() % 1000).toString().padStart(3, "0")}`;
const EXTENSION_NUMBER = `8${(Date.now() % 1000).toString().padStart(3, "0")}`;
const GOOD_PIN = "80412";

// ---------------------------------------------------------------------------------------------
// Harness — the same shape as `verify-pbx.ts`, deliberately, so a reader moving between them is
// reading one harness rather than two.
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

// ---------------------------------------------------------------------------------------------
// Docker-managed NATS
// ---------------------------------------------------------------------------------------------

interface NatsHandle {
	readonly url: string;
	readonly containerId: string;
}

const NATS_CONTAINER_PREFIX = "optimiq-verify-voicemail";

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
			console.log(`  (removed ${stale.length} stale verify-voicemail NATS container(s))`);
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
		const containerId = stdout.trim();
		await delay(1_200);
		return { url: `nats://127.0.0.1:${port}`, containerId };
	} catch (error) {
		console.warn(
			`  (docker unavailable — broker checks will be skipped: ${
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

	// A real directory with a real file in it: the media route stats the object and streams it, and
	// a check that stopped at "the URL was minted" would not notice a root that resolves nowhere.
	const mediaRoot = await mkdtemp(join(tmpdir(), "optimiq-vm-"));
	const audio = Buffer.from("RIFF....WAVEfmt verify-voicemail", "utf8");

	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.PBX_DATABASE_URL = pbxDatabaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;
	process.env.PBX_VOICEMAIL_MEDIA_ROOT = mediaRoot;
	process.env.PBX_VOICEMAIL_URL_SECRET = MEDIA_SECRET;
	process.env.PBX_VOICEMAIL_URL_TTL_SECONDS = "300";
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
	const { parseVoicemailPinHash, ROUTING_CACHE_BUCKET, routingCacheKey } = await import(
		"@optimiq-voice/routing"
	);
	const { verifyVoicemailPin } = await import("../src/pbx/voicemail-boxes/voicemail-pin.service");
	const { createPbxDatabaseClient, sql: pbxSql } = await import("@optimiq-voice/pbx-db");

	const sql = createPostgresClient({
		url: databaseUrl,
		applicationName: "verify-voicemail",
		poolMaxConnectionsOverride: 2,
	});
	const pbx = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "verify-voicemail-seed",
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

	const ownerEmail = `vm-owner-${RUN_ID}@verify.optimiq.test`;
	const otherEmail = `vm-other-${RUN_ID}@verify.optimiq.test`;
	const password = "Verify-Voicemail-2026!";
	const jarA = new CookieJar();
	const jarB = new CookieJar();
	const clientA: Client = makeClient(baseUrl, jarA);
	const clientB: Client = makeClient(baseUrl, jarB);
	let organizationA = "";
	let organizationB = "";

	try {
		// --- 0. two tenants -----------------------------------------------------------------------
		console.log("0. two organizations");
		await clientA("POST", "/api/auth/sign-up/email", {
			name: "VM Owner A",
			email: ownerEmail,
			password,
		});
		const createA = await clientA("POST", "/api/auth/organization/create", {
			name: `VM Org A ${RUN_ID}`,
			slug: `vm-org-a-${RUN_ID}`,
		});
		organizationA = typeof createA.body.id === "string" ? createA.body.id : "";
		await clientA("POST", "/api/auth/organization/set-active", { organizationId: organizationA });
		check("organization A created", organizationA.length > 0, organizationA);

		await clientB("POST", "/api/auth/sign-up/email", {
			name: "VM Owner B",
			email: otherEmail,
			password,
		});
		const createB = await clientB("POST", "/api/auth/organization/create", {
			name: `VM Org B ${RUN_ID}`,
			slug: `vm-org-b-${RUN_ID}`,
		});
		organizationB = typeof createB.body.id === "string" ? createB.body.id : "";
		await clientB("POST", "/api/auth/organization/set-active", { organizationId: organizationB });
		check("organization B created", organizationB.length > 0, organizationB);

		// --- 1. a mailbox, an extension, and the two tables the loader just learned to read --------
		console.log("\n1. seed: extension, mailbox, MOH class, greeting");
		const extension = await clientA("POST", "/api/v1/extensions", {
			number: EXTENSION_NUMBER,
			label: "Verify VM",
			sipSecretRef: `secret://verify-voicemail/${EXTENSION_NUMBER}`,
			voicemailEnabled: true,
		});
		check("create extension -> 201", extension.status === 201, `status ${extension.status}`);
		const extensionId = id(extension);

		const mailbox = await clientA("POST", "/api/v1/voicemail-boxes", {
			mailboxNumber: MAILBOX_NUMBER,
			label: "Verify mailbox",
			extensionId,
			mwiEnabled: true,
		});
		check("create voicemail box -> 201", mailbox.status === 201, `status ${mailbox.status}`);
		const mailboxId = id(mailbox);

		check(
			"a mailbox response carries NO pinHash",
			!Object.hasOwn(data(mailbox), "pinHash"),
			Object.keys(data(mailbox)).join(","),
		);
		const listedBoxes = await clientA("GET", "/api/v1/voicemail-boxes");
		check(
			"neither does a mailbox LIST",
			rows(listedBoxes).every((row) => !Object.hasOwn(row, "pinHash")),
			`${String(rows(listedBoxes).length)} row(s)`,
		);

		/*
		 * `moh_class` and `voicemail_greeting` have no CRUD endpoints yet — they are media
		 * provisioning, a later wave — so they are seeded directly, inside the tenant scope so RLS is
		 * still the thing that scopes them. That is the honest way to test a LOADER: the rows exist,
		 * and the question is whether the compiler sees them.
		 */
		// `uuidV7PrimaryKey()` is generated in the application layer, not by a column default — the
		// same rule every table in `pbx-db` follows — so a raw insert has to mint the id itself.
		const { createEntityId } = await import("@optimiq-voice/identifiers");
		const mohClassId = createEntityId();
		await pbx.withTenantScope(organizationA, async (transaction) => {
			await transaction.execute(
				pbxSql`insert into "moh_class" ("id", "organization_id", "name", "source")
					values (${mohClassId}::uuid, ${organizationA}::uuid, ${`verify-moh-${RUN_ID}`}, 'library')`,
			);
		});
		check("a moh_class row was seeded", mohClassId.length > 0, mohClassId);

		await pbx.withTenantScope(organizationA, async (transaction) => {
			await transaction.execute(
				pbxSql`insert into "voicemail_greeting"
					("id", "organization_id", "voicemail_box_id", "kind", "object_key", "active", "duration_ms")
					values (${createEntityId()}::uuid, ${organizationA}::uuid, ${mailboxId}::uuid, 'unavailable',
						${`greetings/${RUN_ID}/unavailable.wav`}, true, 4200)`,
			);
		});

		// The extension names the class, so the compiled extension node is where the resolved NAME
		// has to appear. A `mohClassId` with no `mohClass` beside it is exactly the state the loader
		// was in before it learned to read the table.
		const namedMoh = await clientA("PATCH", `/api/v1/extensions/${extensionId}`, { mohClassId });
		check("point the extension at the MOH class -> 200", namedMoh.status === 200, `status ${namedMoh.status}`);

		// --- 2. the set-PIN endpoint ---------------------------------------------------------------
		console.log("\n2. POST /voicemail-boxes/:id/pin");
		const badShapes: readonly [string, string][] = [
			["12ab", "letters"],
			["123", "too short"],
			["12345678901", "too long"],
			["0000", "one repeated digit"],
			["1234", "a straight run"],
			["9876", "a descending run"],
		];
		for (const [pin, why] of badShapes) {
			const refused = await clientA("POST", `/api/v1/voicemail-boxes/${mailboxId}/pin`, { pin });
			check(
				`a PIN of ${why} is refused with a field-addressable 400`,
				refused.status === 400 && refused.body.code === "PBX_INVALID_BODY",
				`status ${refused.status} ${String(refused.body.code)}`,
			);
		}

		const setPin = await clientA("POST", `/api/v1/voicemail-boxes/${mailboxId}/pin`, {
			pin: GOOD_PIN,
		});
		check("setting a good PIN -> 201", setPin.status === 201, `status ${setPin.status}`);
		check(
			"the reply says a PIN is set and carries no digest",
			data(setPin).pinSet === true && !Object.hasOwn(data(setPin), "pinHash"),
			JSON.stringify(data(setPin)),
		);

		const storedDigest = await readPinHash(pbx, pbxSql, organizationA, mailboxId);
		const parsedDigest = parseVoicemailPinHash(storedDigest);
		check(
			"the stored digest is in the format packages/routing owns",
			parsedDigest !== undefined,
			String(storedDigest).slice(0, 32),
		);
		check(
			"it declares the recommended scrypt parameters",
			parsedDigest?.params.cost === 16_384 &&
				parsedDigest.params.blockSize === 8 &&
				parsedDigest.params.parallelism === 1,
			JSON.stringify(parsedDigest?.params ?? {}),
		);
		check(
			"the digest verifies against the PIN it was made from",
			await verifyVoicemailPin(GOOD_PIN, storedDigest ?? ""),
		);
		check(
			"and refuses a different PIN",
			!(await verifyVoicemailPin("80413", storedDigest ?? "")),
		);
		check(
			"re-setting the PIN produces a DIFFERENT digest (a fresh salt, not a re-run)",
			await (async () => {
				await clientA("POST", `/api/v1/voicemail-boxes/${mailboxId}/pin`, { pin: GOOD_PIN });
				const second = await readPinHash(pbx, pbxSql, organizationA, mailboxId);
				return second !== storedDigest && (await verifyVoicemailPin(GOOD_PIN, second ?? ""));
			})(),
		);

		// --- 3. the snapshot loader, seen through the compiled artifact ----------------------------
		console.log("\n3. the compiled artifact carries the embeddings");
		const compiled = await clientA("POST", "/api/v1/routing/compile", {});
		check("compile -> 200", compiled.status === 200, `status ${compiled.status}`);
		const firstHash = String(data(compiled).snapshotHash ?? "");
		check("the compile reports a snapshot hash", firstHash.length > 0, firstHash.slice(0, 16));

		if (nats === undefined) {
			console.log("  (artifact inspection SKIPPED — no broker to read the KV bucket from)");
		} else {
			const { connect } = await import("nats");
			const inspectConnection = await connect({ servers: nats.url, name: "verify-vm-kv" });
			try {
				const manager = await inspectConnection.jetstreamManager();
				const bucket = await manager.jetstream().views.kv(ROUTING_CACHE_BUCKET);
				const entry = await bucket.get(routingCacheKey(organizationA));
				const artifact =
					entry === null
						? undefined
						: (JSON.parse(new TextDecoder().decode(entry.value)) as ArtifactShape);
				check("the artifact is in the routing-cache bucket", artifact !== undefined);

				const voicemailNodes = collectNodes(artifact).filter((node) => node.kind === "voicemail");
				const leaveNode = voicemailNodes.find(
					(node) => node.voicemailBoxId === mailboxId && node.mode === "leave",
				);
				const checkNode = voicemailNodes.find(
					(node) => node.voicemailBoxId === mailboxId && node.mode === "check",
				);
				check(
					"the artifact holds a voicemail node for the mailbox",
					leaveNode !== undefined,
					`${String(voicemailNodes.length)} voicemail node(s)`,
				);
				check(
					"the LEAVE node carries the active greeting as an object:// media ref",
					typeof leaveNode?.greetingMedia === "string" &&
						leaveNode.greetingMedia.startsWith("object://") &&
						leaveNode.greetingMedia.includes(RUN_ID),
					String(leaveNode?.greetingMedia),
				);
				check(
					"and names the greeting KIND it came from",
					leaveNode?.greetingKind === "unavailable",
					String(leaveNode?.greetingKind),
				);
				check(
					"the mailbox's PIN digest is embedded, so *97 can authenticate on the call path",
					typeof (checkNode ?? leaveNode)?.pinHash === "string" &&
						parseVoicemailPinHash((checkNode ?? leaveNode)?.pinHash) !== undefined,
					String((checkNode ?? leaveNode)?.pinHash).slice(0, 24),
				);

				const extensionNode = collectNodes(artifact).find(
					(node) => node.kind === "extension" && node.mohClassId === mohClassId,
				);
				check(
					"an extension node resolves its moh_class id to the NAME a media server accepts",
					extensionNode?.mohClass === `verify-moh-${RUN_ID}`,
					`${String(extensionNode?.mohClassId)} -> ${String(extensionNode?.mohClass)}`,
				);
			} finally {
				await inspectConnection.drain();
			}
		}

		// Clearing the PIN must move the artifact: `pin_hash` is a routing input now, so a mailbox
		// that lost its PIN and an engine that still challenges for one is exactly the drift the
		// loader change was made to remove.
		const cleared = await clientA("DELETE", `/api/v1/voicemail-boxes/${mailboxId}/pin`);
		check("clearing the PIN -> 200", cleared.status === 200, `status ${cleared.status}`);
		check("the reply says no PIN is set", data(cleared).pinSet === false);
		check(
			"the column is NULL again",
			(await readPinHash(pbx, pbxSql, organizationA, mailboxId)) === null,
		);
		const recompiled = await clientA("POST", "/api/v1/routing/compile", {});
		check(
			"clearing the PIN changed the snapshot hash",
			String(data(recompiled).snapshotHash ?? "") !== firstHash,
			`${firstHash.slice(0, 12)} -> ${String(data(recompiled).snapshotHash).slice(0, 12)}`,
		);
		// Put it back: the RPC and the message checks below want a mailbox in its normal state.
		await clientA("POST", `/api/v1/voicemail-boxes/${mailboxId}/pin`, { pin: GOOD_PIN });

		// --- 4. messages ---------------------------------------------------------------------------
		console.log("\n4. the messages API");
		await writeFile(join(mediaRoot, "message.wav"), audio);
		const messageIds = await seedMessages(pbx, pbxSql, organizationA, mailboxId, [
			{ objectKey: "message.wav", callerIdNumber: "+15551110001", durationMs: 5_000 },
			{ objectKey: "message.wav", callerIdNumber: "+15551110002", durationMs: 9_500 },
		]);
		check("two messages were seeded", messageIds.length === 2, messageIds.join(","));

		const listed = await clientA("GET", `/api/v1/voicemail-boxes/${mailboxId}/messages`);
		check("list messages -> 200", listed.status === 200, `status ${listed.status}`);
		check("both messages are listed", rows(listed).length === 2, String(rows(listed).length));
		check(
			"newest first",
			String(rows(listed)[0]?.id) === messageIds[1],
			`${String(rows(listed)[0]?.id)} vs ${String(messageIds[1])}`,
		);
		check(
			"every message reads as unread, because they are in the `new` folder",
			rows(listed).every((row) => row.read === false && row.folder === "new"),
		);
		check(
			"the list never carries the object key — playback is a signed URL, not a path",
			rows(listed).every((row) => !Object.hasOwn(row, "objectKey")),
		);
		check(
			"the envelope carries the mailbox's counts, so a badge never adds up a page",
			mailboxOf(listed).newCount === 2 && mailboxOf(listed).savedCount === 0,
			JSON.stringify(mailboxOf(listed)),
		);

		const markedRead = await clientA(
			"PATCH",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[0]}`,
			{ read: true },
		);
		check("mark read -> 200", markedRead.status === 200, `status ${markedRead.status}`);
		check(
			"read means OUT of the `new` folder — one fact, which is what the lamp is defined by",
			data(markedRead).read === true && data(markedRead).folder === "saved",
			JSON.stringify(data(markedRead)),
		);
		check(
			"and the counts moved with it",
			mailboxOf(markedRead).newCount === 1 && mailboxOf(markedRead).savedCount === 1,
			JSON.stringify(mailboxOf(markedRead)),
		);

		const markedUnread = await clientA(
			"PATCH",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[0]}`,
			{ read: false },
		);
		check(
			"mark unread puts it back in `new`",
			markedUnread.status === 200 && data(markedUnread).folder === "new",
			`status ${markedUnread.status} ${String(data(markedUnread).folder)}`,
		);

		const contradictory = await clientA(
			"PATCH",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[0]}`,
			{ read: true, folder: "deleted" },
		);
		check(
			"a body carrying BOTH `read` and `folder` is refused rather than silently resolved",
			contradictory.status === 400,
			`status ${contradictory.status}`,
		);

		const inboxOnly = await clientA(
			"GET",
			`/api/v1/voicemail-boxes/${mailboxId}/messages?folder=deleted`,
		);
		check("the trash is empty to start with", rows(inboxOnly).length === 0);

		const trashed = await clientA(
			"DELETE",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[0]}`,
		);
		check("delete -> 200", trashed.status === 200, `status ${trashed.status}`);
		check(
			"a delete is a MOVE to the trash, not a row that is gone",
			data(trashed).purged === false,
			JSON.stringify(data(trashed)),
		);
		const afterTrash = await clientA(
			"GET",
			`/api/v1/voicemail-boxes/${mailboxId}/messages?folder=deleted`,
		);
		check("the message is in the trash", rows(afterTrash).length === 1);
		const inboxAfterTrash = await clientA("GET", `/api/v1/voicemail-boxes/${mailboxId}/messages`);
		check(
			"and out of the inbox, which is `new` + `saved` and never the trash",
			rows(inboxAfterTrash).length === 1,
			String(rows(inboxAfterTrash).length),
		);

		const purged = await clientA(
			"DELETE",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[0]}?purge=true`,
		);
		check(
			"purge removes the row",
			purged.status === 200 && data(purged).purged === true,
			JSON.stringify(data(purged)),
		);
		const gone = await clientA(
			"DELETE",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[0]}`,
		);
		check("a purged message is a 404 afterwards", gone.status === 404, `status ${gone.status}`);

		// --- 5. signed playback --------------------------------------------------------------------
		console.log("\n5. signed playback");
		const minted = await clientA(
			"POST",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[1]}/play-url`,
			{},
		);
		check("mint a playback URL -> 201", minted.status === 201, `status ${minted.status}`);
		const url = String(data(minted).url ?? "");
		check(
			"the token rides in a QUERY parameter, not a path segment",
			url.startsWith("/api/v1/voicemail-boxes/media?token="),
			url.slice(0, 48),
		);

		const played = await fetch(`${baseUrl}${url}`);
		const playedBody = Buffer.from(await played.arrayBuffer());
		check("following it ANONYMOUSLY streams the audio", played.status === 200, `status ${played.status}`);
		check(
			"the bytes are the object the engine wrote",
			playedBody.equals(audio),
			`${String(playedBody.length)} bytes`,
		);
		check(
			"and it is served with a no-store, inline audio disposition",
			played.headers.get("cache-control") === "private, no-store" &&
				(played.headers.get("content-type") ?? "").startsWith("audio/"),
			`${String(played.headers.get("cache-control"))} / ${String(played.headers.get("content-type"))}`,
		);

		const tampered = `${url.slice(0, -2)}${url.slice(-2) === "AA" ? "AB" : "AA"}`;
		const forged = await fetch(`${baseUrl}${tampered}`);
		check("a tampered token is refused", forged.status === 403, `status ${forged.status}`);

		/*
		 * The two token families share a secret and a scheme and MUST NOT share a key. A voicemail
		 * token is minted under `HMAC(secret, "optimiq-voicemail-media-v1")`, so a token minted with
		 * the raw secret — which is what the recordings route uses — cannot verify here at all.
		 */
		const { mintRecordingToken } = await import("../src/cdr/recordings/recording-token");
		const crossFamily = mintRecordingToken(
			{ r: messageIds[1] ?? "", o: organizationA, e: Math.floor(Date.now() / 1000) + 300 },
			MEDIA_SECRET,
		);
		const crossed = await fetch(
			`${baseUrl}/api/v1/voicemail-boxes/media?token=${encodeURIComponent(crossFamily)}`,
		);
		check(
			"a token signed with the RAW secret (the recordings family) is refused",
			crossed.status === 403,
			`status ${crossed.status}`,
		);

		// --- 6. tenant isolation --------------------------------------------------------------------
		console.log("\n6. tenant isolation");
		const foreignList = await clientB("GET", `/api/v1/voicemail-boxes/${mailboxId}/messages`);
		check(
			"organization B cannot list organization A's mailbox",
			foreignList.status === 404,
			`status ${foreignList.status}`,
		);
		const foreignPin = await clientB("POST", `/api/v1/voicemail-boxes/${mailboxId}/pin`, {
			pin: GOOD_PIN,
		});
		check(
			"nor set its PIN",
			foreignPin.status === 404,
			`status ${foreignPin.status}`,
		);
		const foreignPlay = await clientB(
			"POST",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[1]}/play-url`,
			{},
		);
		check("nor mint a link to its audio", foreignPlay.status === 404, `status ${foreignPlay.status}`);

		// --- 7. rpc.voicemail.v1.list ---------------------------------------------------------------
		if (nats === undefined) {
			console.log("\n7. rpc.voicemail.v1.list SKIPPED (docker unavailable)");
		} else {
			console.log("\n7. rpc.voicemail.v1.list");
			check("the pbx transport was registered at boot", rpcServed, String(rpcServed));

			const { connect } = await import("nats");
			const { ClientProxyFactory, Transport } = await import("@nestjs/microservices");
			const { VOICEMAIL_LIST_RPC } = await import("@optimiq-voice/events/schemas");
			const connection = await connect({ servers: nats.url, name: "verify-voicemail" });
			// Driven through a Nest `ClientProxy` rather than a raw request, for the reason
			// `verify-pbx.ts` records: Nest's NATS transport wraps the payload in its own envelope, so
			// a raw `connection.request` would prove the subject and nothing about the contract.
			const rpcClient = ClientProxyFactory.create({
				transport: Transport.NATS,
				options: { servers: [nats.url], name: "verify-voicemail-rpc" },
			});
			await rpcClient.connect();

			const mwiSeen: Record<string, unknown>[] = [];
			const mwiSubscription = connection.subscribe(`voicemail.evt.v1.${organizationA}.>`);
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

			try {
				const { firstValueFrom, timeout } = await import("rxjs");
				const ask = async (payload: unknown): Promise<Record<string, unknown>> =>
					(await firstValueFrom(
						rpcClient
							.send<Record<string, unknown>>(VOICEMAIL_LIST_RPC.subject, payload)
							.pipe(timeout(5_000)),
					)) as Record<string, unknown>;

				const answer = await ask({
					orgId: organizationA,
					voicemailBoxId: mailboxId,
					mailboxNumber: MAILBOX_NUMBER,
					folder: "new",
					limit: 20,
				});
				check("rpc.voicemail.v1.list replied", typeof answer === "object" && answer !== null);
				check("the reply found the mailbox", answer.found === true, JSON.stringify(answer.found));
				const replyMessages = Array.isArray(answer.messages)
					? (answer.messages as Record<string, unknown>[])
					: [];
				check(
					"it lists the mailbox's new messages",
					replyMessages.length === 1 && replyMessages[0]?.messageId === messageIds[1],
					`${String(replyMessages.length)} message(s)`,
				);
				check(
					"each message carries the OBJECT KEY, which the engine renders as object://",
					typeof replyMessages[0]?.objectKey === "string" &&
						String(replyMessages[0]?.objectKey).length > 0,
					String(replyMessages[0]?.objectKey),
				);
				check(
					"and the counts, so the menu can say how many there are",
					answer.newCount === 1,
					JSON.stringify({ newCount: answer.newCount, savedCount: answer.savedCount }),
				);
				check(
					"the reply satisfies voicemailListResponseSchema",
					VOICEMAIL_LIST_RPC.response.safeParse(answer).success,
					JSON.stringify(VOICEMAIL_LIST_RPC.response.safeParse(answer).error?.issues ?? []).slice(0, 120),
				);

				/*
				 * The check the contract asks for by name. A request that reached the broker is not a
				 * request that is entitled to a mailbox: the box id and the claimed number have to
				 * describe the same row, or any process on the network could read any mailbox by
				 * guessing an id.
				 */
				const mismatched = await ask({
					orgId: organizationA,
					voicemailBoxId: mailboxId,
					mailboxNumber: "0000",
					folder: "new",
					limit: 20,
				});
				check(
					"a mailboxNumber that does not match the box is REFUSED, not answered",
					mismatched.found === false && typeof mismatched.reason === "string",
					String(mismatched.reason),
				);
				check(
					"and the refusal carries an empty list, never `found: true` with no messages",
					Array.isArray(mismatched.messages) && (mismatched.messages as unknown[]).length === 0,
				);

				const foreignOrg = await ask({
					orgId: organizationB,
					voicemailBoxId: mailboxId,
					mailboxNumber: MAILBOX_NUMBER,
					folder: "new",
					limit: 20,
				});
				check(
					"a request naming another organization sees nothing — RLS, not a predicate",
					foreignOrg.found === false,
					String(foreignOrg.reason),
				);

				const unknownBox = await ask({
					orgId: organizationA,
					voicemailBoxId: "00000000-0000-4000-8000-000000000000",
					mailboxNumber: MAILBOX_NUMBER,
					folder: "new",
					limit: 20,
				});
				check("an unknown mailbox is refused with a reason", unknownBox.found === false);

				const malformed = await ask({ orgId: "not-a-uuid" });
				check(
					"a malformed request is ANSWERED, not dropped — the caller is already listening",
					malformed.found === false && typeof malformed.reason === "string",
					String(malformed.reason).slice(0, 60),
				);

				// --- MWI, from the HTTP side ---------------------------------------------------------
				mwiSeen.length = 0;
				await clientA(
					"PATCH",
					`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[1]}`,
					{ read: true },
				);
				for (let attempt = 0; attempt < 25 && mwiSeen.length === 0; attempt += 1) {
					await delay(200);
				}
				check("marking a message read publishes an MWI update", mwiSeen.length > 0, String(mwiSeen.length));
				check(
					"it carries absolute counts and says WHY they moved",
					mwiSeen[0]?.newCount === 0 &&
						mwiSeen[0]?.savedCount === 1 &&
						mwiSeen[0]?.reason === "message-read",
					JSON.stringify(mwiSeen[0] ?? {}),
				);
				check(
					"the counts agree with what the list endpoint reports",
					await (async () => {
						const now = await clientA("GET", `/api/v1/voicemail-boxes/${mailboxId}/messages`);
						return mailboxOf(now).newCount === 0 && mailboxOf(now).savedCount === 1;
					})(),
				);

				mwiSeen.length = 0;
				await clientA(
					"DELETE",
					`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageIds[1]}`,
				);
				for (let attempt = 0; attempt < 25 && mwiSeen.length === 0; attempt += 1) {
					await delay(200);
				}
				check(
					"deleting one publishes an MWI update too, with its own reason",
					mwiSeen[0]?.reason === "message-deleted" &&
						mwiSeen[0]?.newCount === 0 &&
						mwiSeen[0]?.savedCount === 0,
					JSON.stringify(mwiSeen[0] ?? {}),
				);
			} finally {
				mwiSubscription.unsubscribe();
				await rpcClient.close();
				await connection.drain();
			}
		}
	} finally {
		console.log("\ncleaning up");
		try {
			await app.close();
			for (const organizationId of [organizationA, organizationB].filter(Boolean)) {
				await pbx.withTenantScope(organizationId, async (transaction) => {
					for (const table of [
						"voicemail_message",
						"voicemail_greeting",
						"voicemail_box",
						"extension",
						"moh_class",
					]) {
						await transaction.execute(pbxSql`delete from ${pbxSql.identifier(table)}`);
					}
				});
			}
			if (organizationA) {
				await sql`delete from "organization" where "id" = ${organizationA}`;
			}
			if (organizationB) {
				await sql`delete from "organization" where "id" = ${organizationB}`;
			}
			await sql`delete from "user" where "email" in (${ownerEmail}, ${otherEmail})`;
		} catch (error) {
			console.error("cleanup failed", error);
		}
		await pbx.close();
		await sql.end({ timeout: 5 });
		await rm(mediaRoot, { recursive: true, force: true });
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
	console.log("voicemail verification PASSED");
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface ArtifactShape {
	readonly nodes?: Record<string, Record<string, unknown>>;
}

interface PlanNodeShape {
	readonly kind?: string;
	readonly mode?: string;
	readonly voicemailBoxId?: string;
	readonly greetingMedia?: string;
	readonly greetingKind?: string;
	readonly pinHash?: string;
	readonly mohClassId?: string;
	readonly mohClass?: string;
}

/**
 * Every node in the artifact, whatever shape the node table happens to have.
 *
 * The artifact is a NODE TABLE rather than a tree (`packages/routing` §2.2), so this is a values
 * walk rather than a traversal. Written defensively because this script asserts against the
 * artifact's CONTENT, not its container: a future envelope change should fail the content checks
 * with a clear message rather than throw here.
 */
function collectNodes(artifact: ArtifactShape | undefined): readonly PlanNodeShape[] {
	const table = artifact?.nodes;
	if (table === undefined || table === null || typeof table !== "object") {
		return [];
	}
	return Object.values(table).filter(
		(node) => typeof node === "object" && node !== null,
	) as readonly PlanNodeShape[];
}

function mailboxOf(response: JsonResponse): {
	readonly newCount?: number;
	readonly savedCount?: number;
} {
	const value = response.body.mailbox;
	return typeof value === "object" && value !== null
		? (value as { newCount?: number; savedCount?: number })
		: {};
}

function unwrap(result: unknown): Record<string, unknown>[] {
	return (
		Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
	) as Record<string, unknown>[];
}

/** Reads the digest straight out of the column, because no endpoint returns it — by design. */
async function readPinHash(
	pbx: PbxDatabaseClient,
	pbxSql: PbxSql,
	organizationId: string,
	mailboxId: string,
): Promise<string | null> {
	return await pbx.withTenantScope(organizationId, async (transaction) => {
		const found = unwrap(
			await transaction.execute(
				pbxSql`select "pin_hash" from "voicemail_box" where "id" = ${mailboxId}::uuid`,
			),
		);
		const value = found[0]?.pin_hash;
		return typeof value === "string" ? value : null;
	});
}

/**
 * Seeds messages the way the consumer would have filed them.
 *
 * Direct inserts rather than published `voicemail.message.left` events, because `verify-pbx.ts`
 * already proves that path end to end (the engine's fact becoming a row, idempotently) and this
 * script is about what happens to a row AFTER it exists. Duplicating the publish here would make
 * every check below depend on JetStream delivery timing for no additional coverage.
 */
async function seedMessages(
	pbx: PbxDatabaseClient,
	pbxSql: PbxSql,
	organizationId: string,
	mailboxId: string,
	messages: readonly {
		readonly objectKey: string;
		readonly callerIdNumber: string;
		readonly durationMs: number;
	}[],
): Promise<readonly string[]> {
	const ids: string[] = [];
	for (const [index, message] of messages.entries()) {
		// One at a time and with a distinct `received_at`, so "newest first" is a claim the data can
		// actually falsify — two rows written in the same millisecond would order by id alone.
		const receivedAt = new Date(Date.now() - (messages.length - index) * 60_000).toISOString();
		const { createEntityId } = await import("@optimiq-voice/identifiers");
		const messageId = createEntityId();
		const inserted = await pbx.withTenantScope(organizationId, async (transaction) =>
			unwrap(
				await transaction.execute(
					pbxSql`insert into "voicemail_message"
						("id", "organization_id", "voicemail_box_id", "folder", "caller_id_number",
						 "received_at", "duration_ms", "object_key", "size_bytes")
						values (${messageId}::uuid, ${organizationId}::uuid, ${mailboxId}::uuid, 'new',
							${message.callerIdNumber}, ${receivedAt}::timestamptz, ${message.durationMs},
							${message.objectKey}, 32)
						returning "id"`,
				),
			),
		);
		const value = inserted[0]?.id;
		if (typeof value === "string") {
			ids.push(value);
		}
	}
	return ids;
}

await main();
