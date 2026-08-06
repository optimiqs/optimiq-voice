/**
 * End-to-end verification of the media library, the conference PINs, E911 and HTTP Range.
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/api verify:media
 *
 * `verify-pbx.ts` proves the CRUD and the routing artifact; `verify-voicemail.ts` proves the
 * mailbox surface. This proves the five things that were follow-ups when those landed, against the
 * same real stack — the auth slice plus the PBX area on an ephemeral port, a real PostgreSQL, and a
 * real NATS in Docker.
 *
 *  1. **The media library.** MOH classes, prompts and voicemail greetings: multipart upload with a
 *     real object written under a real root; magic-byte refusal of a file that is not audio;
 *     the size cap; the reference guard on delete; and the object actually disappearing.
 *  2. **Compile-on-write where it is routing-relevant.** Renaming an MOH class moves the tenant's
 *     `snapshotHash` (five node kinds carry the resolved NAME); activating a greeting puts its
 *     object key into the compiled artifact as `object://<key>`; uploading a prompt does NOT
 *     recompile, because `prompt` is deliberately not a routing table.
 *  3. **Conference PINs, end to end.** The set/clear endpoints `conferences.resource.ts` has been
 *     promising, hashed in the format `packages/routing` owns, verified with the same code path
 *     the engine uses — and, since routing README §7 item 11 closed, BOTH digests travelling into
 *     the compiled artifact, where this script re-verifies them against the PINs it set. The two
 *     assertions that used to read "THE DOCUMENTED GAP" are now their inverses; if they ever fail
 *     open again, this is where it shows.
 *  4. **E911.** The `emergency_address` CRUD, the per-number assignment, the delete guard that
 *     stops a dispatchable location being silently stripped from a live DID, RLS isolation — and,
 *     since §7 item 12 closed, the emergency table in the compiled artifact: `911` in BOTH the
 *     internal and the outbound contexts, pointing at a `trunk-dial` node marked `emergency`.
 *  5. **HTTP Range.** `206` with a correct `content-range` and a correctly sized body, `200` for a
 *     request with no range, `416` for a range past the end — on BOTH pre-existing media routes
 *     (voicemail messages, CDR recordings are covered by shape here and by `verify-cdr.ts` for the
 *     token) and on the two new ones.
 *
 * The NATS half is skipped, loudly, when Docker is unavailable. Everything else still runs.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

type PbxSql = typeof import("@optimiq-voice/pbx-db").sql;

const execFileAsync = promisify(execFile);

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
/** Shared with `verify-auth-slice.ts` for the reason that script records: one JWKS, one secret. */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const MEDIA_SECRET = "verify-media-signing-secret-0123456789";
const RUN_ID = Date.now().toString(36);

const ROOM_NUMBER = `7${(Date.now() % 1000).toString().padStart(3, "0")}`;
const MAILBOX_NUMBER = `6${(Date.now() % 1000).toString().padStart(3, "0")}`;
const GOOD_PIN = "80412";
const MODERATOR_PIN = "51937";
/** Small enough that a 4 kB cap refuses a 16 kB file without making the harness slow. */
const UPLOAD_CAP_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------------------------
// Harness — the same shape as `verify-voicemail.ts`, deliberately, so a reader moving between them
// is reading one harness rather than two.
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
		return { status: response.status, body: await readJson(response) };
	};
}

/**
 * A multipart upload, built with the platform's own `FormData` and `Blob`.
 *
 * The `content-type` header is deliberately NOT set: the runtime derives it from the `FormData`
 * body and appends the boundary, and a hand-written one would produce a body the server cannot
 * parse. That is the same constraint `apps/web` has to honour — see `apiUpload` there — so
 * exercising it here is exercising the real path rather than a convenient one.
 */
function makeUploader(baseUrl: string, jar: CookieJar) {
	return async (
		path: string,
		file: { readonly bytes: Uint8Array; readonly name: string; readonly type: string },
		fields: Readonly<Record<string, string>> = {},
	): Promise<JsonResponse> => {
		const form = new FormData();
		form.append(
			"file",
			new Blob([file.bytes as unknown as BlobPart], { type: file.type }),
			file.name,
		);
		for (const [key, value] of Object.entries(fields)) {
			form.append(key, value);
		}
		const headers: Record<string, string> = { accept: "application/json" };
		const cookie = jar.header();
		if (cookie) {
			headers.cookie = cookie;
		}
		const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: form });
		jar.absorb(response);
		return { status: response.status, body: await readJson(response) };
	};
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	let parsed: unknown = null;
	try {
		parsed = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		parsed = { raw: text };
	}
	return typeof parsed === "object" && parsed !== null
		? (parsed as Record<string, unknown>)
		: { value: parsed };
}

type Client = ReturnType<typeof makeClient>;
type Uploader = ReturnType<typeof makeUploader>;

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
// Audio fixtures — real headers, because the server sniffs magic bytes rather than trusting the
// declared content type. A WAV that says WAV and is not one is exactly what has to be refused.
// ---------------------------------------------------------------------------------------------

/**
 * A minimal, VALID RIFF/WAVE file: 16-bit signed PCM, one channel, at `sampleRateHz`.
 *
 * Built here rather than checked in as a binary fixture so the sample rate and the length are
 * parameters — the warning path ("this is 44.1 kHz, the media server will resample it") needs a
 * file that is genuinely 44.1 kHz, and a checked-in blob would make that a second file to maintain.
 */
function makeWav(sampleRateHz = 8000, channels = 1, samples = 800): Uint8Array {
	const bytesPerSample = 2;
	const dataBytes = samples * channels * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);
	const ascii = (offset: number, text: string): void => {
		for (let index = 0; index < text.length; index += 1) {
			view.setUint8(offset + index, text.charCodeAt(index));
		}
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRateHz, true);
	view.setUint32(28, sampleRateHz * channels * bytesPerSample, true);
	view.setUint16(32, channels * bytesPerSample, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	// A quiet ramp rather than silence, so a truncated body is visible as a wrong byte value rather
	// than as another zero.
	for (let index = 0; index < samples * channels; index += 1) {
		view.setInt16(44 + index * 2, (index % 256) - 128, true);
	}
	return new Uint8Array(buffer);
}

/** A WAV whose `fmt ` says IEEE float — real RIFF, wrong sample format, must be refused. */
function makeFloatWav(): Uint8Array {
	const wav = makeWav();
	new DataView(wav.buffer).setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
	return wav;
}

/** An Ogg container. Not audio this stack can play; must be refused by name. */
function makeOgg(): Uint8Array {
	const bytes = new Uint8Array(64);
	bytes.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
	return bytes;
}

/** An executable that has been renamed `.wav`. The case the magic-byte check exists for. */
function makeFakeWav(): Uint8Array {
	const bytes = new Uint8Array(128);
	bytes.set([0x4d, 0x5a, 0x90, 0x00], 0); // "MZ" — a DOS/PE header
	return bytes;
}

// ---------------------------------------------------------------------------------------------
// Docker-managed NATS
// ---------------------------------------------------------------------------------------------

interface NatsHandle {
	readonly url: string;
	readonly containerId: string;
}

const NATS_CONTAINER_PREFIX = "optimiq-verify-media";

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
			console.log(`  (removed ${stale.length} stale verify-media NATS container(s))`);
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

	// A real directory: uploads land on a real filesystem and the checks below `stat` what landed.
	// A test that stopped at "the API said 201" would not notice a root that resolves nowhere.
	const mediaRoot = await mkdtemp(join(tmpdir(), "optimiq-media-"));

	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.PBX_DATABASE_URL = pbxDatabaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;
	process.env.PBX_VOICEMAIL_MEDIA_ROOT = mediaRoot;
	process.env.PBX_MEDIA_OBJECT_ROOT = mediaRoot;
	process.env.PBX_VOICEMAIL_URL_SECRET = MEDIA_SECRET;
	process.env.PBX_VOICEMAIL_URL_TTL_SECONDS = "300";
	process.env.PBX_MEDIA_MAX_UPLOAD_BYTES = String(UPLOAD_CAP_BYTES);
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
	const { parseVoicemailPinHash, ROUTING_CACHE_BUCKET, routingCacheKey } =
		await import("@optimiq-voice/routing");
	const { verifyVoicemailPin } = await import("../src/pbx/voicemail-boxes/voicemail-pin.service");
	const { decideRange } = await import("../src/media/http-range");
	const { createPbxDatabaseClient, sql: pbxSql } = await import("@optimiq-voice/pbx-db");

	const sql = createPostgresClient({
		url: databaseUrl,
		applicationName: "verify-media",
		poolMaxConnectionsOverride: 2,
	});
	const pbx = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "verify-media-seed",
		poolMaxConnectionsOverride: 2,
	});

	console.log(`booting the auth slice + PBX area on ${baseUrl}\n`);
	const app = await NestFactory.create(createApiRootModule([], [PbxModule]), new FastifyAdapter(), {
		logger: ["error"],
	});
	app.enableShutdownHooks();
	await registerAuthTransport(app);
	await registerPbxTransport(app);
	await app.listen(port, "127.0.0.1");
	await delay(200);

	const ownerEmail = `media-owner-${RUN_ID}@verify.optimiq.test`;
	const otherEmail = `media-other-${RUN_ID}@verify.optimiq.test`;
	const password = "Verify-Media-2026!";
	const jarA = new CookieJar();
	const jarB = new CookieJar();
	const clientA: Client = makeClient(baseUrl, jarA);
	const clientB: Client = makeClient(baseUrl, jarB);
	const uploadA: Uploader = makeUploader(baseUrl, jarA);
	let organizationA = "";
	let organizationB = "";

	try {
		// --- 0. two tenants -----------------------------------------------------------------------
		console.log("0. two organizations");
		await clientA("POST", "/api/auth/sign-up/email", {
			name: "Media Owner A",
			email: ownerEmail,
			password,
		});
		const createA = await clientA("POST", "/api/auth/organization/create", {
			name: `Media Org A ${RUN_ID}`,
			slug: `media-org-a-${RUN_ID}`,
		});
		organizationA = typeof createA.body.id === "string" ? createA.body.id : "";
		await clientA("POST", "/api/auth/organization/set-active", { organizationId: organizationA });
		check("organization A created", organizationA.length > 0, organizationA);

		await clientB("POST", "/api/auth/sign-up/email", {
			name: "Media Owner B",
			email: otherEmail,
			password,
		});
		const createB = await clientB("POST", "/api/auth/organization/create", {
			name: `Media Org B ${RUN_ID}`,
			slug: `media-org-b-${RUN_ID}`,
		});
		organizationB = typeof createB.body.id === "string" ? createB.body.id : "";
		await clientB("POST", "/api/auth/organization/set-active", { organizationId: organizationB });
		check("organization B created", organizationB.length > 0, organizationB);

		// --- 1. MOH classes -------------------------------------------------------------------------
		console.log("\n1. MOH classes");
		const mohClass = await clientA("POST", "/api/v1/moh-classes", {
			name: `hold-${RUN_ID}`,
			description: "Verify media",
		});
		check("create an MOH class -> 201", mohClass.status === 201, `status ${mohClass.status}`);
		const mohClassId = id(mohClass);
		check("it defaults to the library source", data(mohClass).source === "library");

		const badName = await clientA("POST", "/api/v1/moh-classes", { name: "hold]music\ninjected" });
		check(
			"a class name that would break musiconhold.conf is refused",
			badName.status === 400 && badName.body.code === "PBX_INVALID_BODY",
			`status ${badName.status}`,
		);

		const streamNoUri = await clientA("POST", "/api/v1/moh-classes", {
			name: `stream-${RUN_ID}`,
			source: "stream",
		});
		check(
			"a streaming class with no URI is refused, with the field named",
			streamNoUri.status === 400 &&
				JSON.stringify(streamNoUri.body.issues ?? []).includes("streamUri"),
			`status ${streamNoUri.status}`,
		);

		const duplicate = await clientA("POST", "/api/v1/moh-classes", { name: `hold-${RUN_ID}` });
		check(
			"a duplicate class name is a 409",
			duplicate.status === 409,
			`status ${duplicate.status} ${String(duplicate.body.code)}`,
		);

		// --- 2. uploads: what is accepted, and what is refused ---------------------------------------
		console.log("\n2. uploads into the class");
		const goodWav = makeWav();
		const upload = await uploadA(`/api/v1/moh-classes/${mohClassId}/files`, {
			bytes: goodWav,
			name: "hold-loop.wav",
			type: "audio/wav",
		});
		check(
			"uploading an 8 kHz mono PCM WAV -> 201",
			upload.status === 201,
			`status ${upload.status}`,
		);
		const objectKey = String(data(upload).objectKey ?? "");
		check(
			"the row carries an object key under moh/<org>/<class>/",
			objectKey.startsWith(`moh/${organizationA}/${mohClassId}/`),
			objectKey,
		);
		check(
			"and the metadata the schema asks for",
			data(upload).contentType === "audio/wav" &&
				data(upload).sizeBytes === goodWav.length &&
				String(data(upload).checksum ?? "").startsWith("sha256:"),
			JSON.stringify({
				contentType: data(upload).contentType,
				sizeBytes: data(upload).sizeBytes,
				checksum: String(data(upload).checksum ?? "").slice(0, 16),
			}),
		);
		check(
			"the duration was read out of the WAV header",
			data(upload).durationMs === 100,
			String(data(upload).durationMs),
		);
		check(
			"a clean 8 kHz mono file raises no format warnings",
			Array.isArray(upload.body.warnings) && (upload.body.warnings as unknown[]).length === 0,
			JSON.stringify(upload.body.warnings),
		);

		const onDisk = await stat(join(mediaRoot, objectKey)).catch(() => undefined);
		check(
			"the bytes are on disk, under the object root, at exactly that key",
			onDisk?.isFile() === true && onDisk.size === goodWav.length,
			`${String(onDisk?.size)} bytes`,
		);

		const wideband = await uploadA(
			`/api/v1/moh-classes/${mohClassId}/files`,
			{ bytes: makeWav(44_100, 2, 4410), name: "stereo.wav", type: "audio/wav" },
			{ name: `stereo-${RUN_ID}` },
		);
		const widebandWarnings = JSON.stringify(wideband.body.warnings ?? []);
		check(
			"a 44.1 kHz stereo WAV is accepted with warnings rather than refused",
			wideband.status === 201 &&
				widebandWarnings.includes("44100") &&
				widebandWarnings.includes("2 channels"),
			`status ${wideband.status} ${widebandWarnings.slice(0, 90)}`,
		);

		const fakeWav = await uploadA(`/api/v1/moh-classes/${mohClassId}/files`, {
			bytes: makeFakeWav(),
			name: "trojan.wav",
			type: "audio/wav",
		});
		check(
			"a non-audio file NAMED .wav and DECLARED audio/wav is refused by its magic bytes",
			fakeWav.status === 400 && fakeWav.body.code === "MEDIA_UPLOAD_REJECTED",
			`status ${fakeWav.status} ${String(fakeWav.body.code)}`,
		);

		const floatWav = await uploadA(`/api/v1/moh-classes/${mohClassId}/files`, {
			bytes: makeFloatWav(),
			name: "float.wav",
			type: "audio/wav",
		});
		check(
			"a real RIFF/WAVE that is not 16-bit PCM is refused, naming the format",
			floatWav.status === 400 && String(floatWav.body.message ?? "").includes("16-bit PCM"),
			String(floatWav.body.message ?? "").slice(0, 80),
		);

		const ogg = await uploadA(`/api/v1/moh-classes/${mohClassId}/files`, {
			bytes: makeOgg(),
			name: "music.ogg",
			type: "audio/ogg",
		});
		check(
			"an Ogg file is refused before its bytes are read, by its declared type",
			ogg.status === 400 && ogg.body.code === "MEDIA_UPLOAD_REJECTED",
			`status ${ogg.status}`,
		);

		const oversized = await uploadA(`/api/v1/moh-classes/${mohClassId}/files`, {
			// One sample per byte-pair, sized past the cap. `makeWav` writes a real header, so this is
			// refused for its SIZE and not for its contents — which is the check.
			bytes: makeWav(8000, 1, UPLOAD_CAP_BYTES),
			name: "enormous.wav",
			type: "audio/wav",
		});
		check(
			"a file past PBX_MEDIA_MAX_UPLOAD_BYTES is a 413 naming the limit",
			oversized.status === 413 && oversized.body.code === "MEDIA_UPLOAD_TOO_LARGE",
			`status ${oversized.status} ${String(oversized.body.code)}`,
		);

		const noFile = await clientA("POST", `/api/v1/moh-classes/${mohClassId}/files`, {});
		check(
			"a JSON body on an upload route is refused with a sentence, not a 500",
			noFile.status === 400 && noFile.body.code === "MEDIA_UPLOAD_REJECTED",
			`status ${noFile.status} ${String(noFile.body.code)}`,
		);

		const listedFiles = await clientA("GET", `/api/v1/moh-classes/${mohClassId}/files`);
		check(
			"the class lists exactly the two files that were accepted",
			listedFiles.status === 200 && rows(listedFiles).length === 2,
			`${String(rows(listedFiles).length)} file(s)`,
		);
		check(
			"nothing that was refused left an object behind",
			(await countObjects(join(mediaRoot, "moh", organizationA, mohClassId))) === 2,
			mediaRoot,
		);

		const unknownClass = await uploadA(
			`/api/v1/moh-classes/00000000-0000-7000-8000-000000000000/files`,
			{ bytes: goodWav, name: "orphan.wav", type: "audio/wav" },
		);
		check(
			"an upload into a class that does not exist is a 404",
			unknownClass.status === 404,
			`status ${unknownClass.status}`,
		);

		// --- 3. the prompt library --------------------------------------------------------------------
		console.log("\n3. the prompt library");
		const prompt = await uploadA(
			"/api/v1/prompts",
			{ bytes: goodWav, name: "welcome.wav", type: "audio/wav" },
			{ name: `welcome-${RUN_ID}`, language: "en-GB" },
		);
		check("uploading a library prompt -> 201", prompt.status === 201, `status ${prompt.status}`);
		const promptId = id(prompt);
		check(
			"it lands under prompts/<org>/ and keeps the language it was given",
			String(data(prompt).objectKey ?? "").startsWith(`prompts/${organizationA}/`) &&
				data(prompt).language === "en-GB",
			`${String(data(prompt).objectKey)} ${String(data(prompt).language)}`,
		);

		const listedPrompts = await clientA("GET", "/api/v1/prompts");
		check(
			"the library list excludes MOH files",
			rows(listedPrompts).every((row) => row.kind !== "moh"),
			`${String(rows(listedPrompts).length)} row(s)`,
		);
		const listedMoh = await clientA("GET", "/api/v1/prompts?kind=moh");
		check(
			"and includes them when asked explicitly",
			rows(listedMoh).length === 2 && rows(listedMoh).every((row) => row.kind === "moh"),
			`${String(rows(listedMoh).length)} row(s)`,
		);

		const renamedPrompt = await clientA("PATCH", `/api/v1/prompts/${promptId}`, {
			name: `welcome-renamed-${RUN_ID}`,
		});
		check(
			"a prompt's metadata can be patched",
			renamedPrompt.status === 200 && data(renamedPrompt).name === `welcome-renamed-${RUN_ID}`,
			`status ${renamedPrompt.status}`,
		);

		const repointed = await clientA("PATCH", `/api/v1/prompts/${promptId}`, {
			objectKey: "prompts/somebody-else/secret.wav",
		});
		check(
			"a prompt's object key is NOT patchable — it is the only thing between a row and a file",
			repointed.status === 400 && repointed.body.code === "PBX_INVALID_BODY",
			`status ${repointed.status}`,
		);

		// --- 4. the reference guard ---------------------------------------------------------------
		console.log("\n4. the reference guard");
		const ivr = await clientA("POST", "/api/v1/ivr-menus", {
			name: `verify-media-ivr-${RUN_ID}`,
			greetingPromptId: promptId,
			timeoutDestinationType: "hangup",
		});
		check("an IVR menu can point at the prompt", ivr.status === 201, `status ${ivr.status}`);
		const ivrId = id(ivr);

		const refusedPrompt = await clientA("DELETE", `/api/v1/prompts/${promptId}`);
		check(
			"deleting a prompt an IVR still plays is a 409 naming the menu",
			refusedPrompt.status === 409 &&
				JSON.stringify(refusedPrompt.body.references ?? []).includes(ivrId),
			`status ${refusedPrompt.status} ${String(refusedPrompt.body.code)}`,
		);
		check(
			"and the object is still on disk — a refused delete unlinks nothing",
			(
				await stat(join(mediaRoot, String(data(prompt).objectKey))).catch(() => undefined)
			)?.isFile() === true,
		);

		await clientA("PATCH", `/api/v1/ivr-menus/${ivrId}`, { greetingPromptId: null });
		const deletedPrompt = await clientA("DELETE", `/api/v1/prompts/${promptId}`);
		check(
			"once nothing points at it, the prompt deletes",
			deletedPrompt.status === 200,
			`status ${deletedPrompt.status}`,
		);
		check(
			"and its object is gone from the store",
			(await stat(join(mediaRoot, String(data(prompt).objectKey))).catch(() => undefined)) ===
				undefined,
		);

		// --- 5. compile-on-write, seen through the artifact ---------------------------------------
		console.log("\n5. what recompiles, and what deliberately does not");
		const baseline = await clientA("POST", "/api/v1/routing/compile", {});
		check("compile -> 200", baseline.status === 200, `status ${baseline.status}`);
		const hashAfterUploads = String(data(baseline).snapshotHash ?? "");
		check(
			"the compile reports a snapshot hash",
			hashAfterUploads.length > 0,
			hashAfterUploads.slice(0, 16),
		);

		const anotherPrompt = await uploadA(
			"/api/v1/prompts",
			{ bytes: goodWav, name: "second.wav", type: "audio/wav" },
			{ name: `second-${RUN_ID}` },
		);
		const afterPromptUpload = await clientA("POST", "/api/v1/routing/compile", {});
		check(
			"uploading a prompt does NOT move the snapshot hash — `prompt` is not a routing table",
			String(data(afterPromptUpload).snapshotHash ?? "") === hashAfterUploads,
			`${hashAfterUploads.slice(0, 12)} -> ${String(data(afterPromptUpload).snapshotHash).slice(0, 12)}`,
		);
		await clientA("DELETE", `/api/v1/prompts/${id(anotherPrompt)}`);

		const extension = await clientA("POST", "/api/v1/extensions", {
			number: `9${(Date.now() % 1000).toString().padStart(3, "0")}`,
			label: "Verify media",
			sipSecretRef: `secret://verify-media/${RUN_ID}`,
			mohClassId,
			// The mailbox below is linked to this extension, which is what makes the compiler emit a
			// `voicemail` plan node at all: a box nothing can reach is a box with no node, and the
			// greeting embedding would have nowhere to appear.
			voicemailEnabled: true,
		});
		check(
			"an extension can name the MOH class",
			extension.status === 201,
			`status ${extension.status}`,
		);

		const beforeRename = String(
			data(await clientA("POST", "/api/v1/routing/compile", {})).snapshotHash,
		);
		const renamed = await clientA("PATCH", `/api/v1/moh-classes/${mohClassId}`, {
			name: `hold-renamed-${RUN_ID}`,
		});
		check("renaming the MOH class -> 200", renamed.status === 200, `status ${renamed.status}`);
		const afterRename = String(
			data(await clientA("POST", "/api/v1/routing/compile", {})).snapshotHash,
		);
		check(
			"renaming an MOH class DOES move the snapshot hash — five node kinds carry the name",
			afterRename !== beforeRename,
			`${beforeRename.slice(0, 12)} -> ${afterRename.slice(0, 12)}`,
		);

		// --- 6. voicemail greetings ---------------------------------------------------------------
		console.log("\n6. voicemail greetings");
		const mailbox = await clientA("POST", "/api/v1/voicemail-boxes", {
			mailboxNumber: MAILBOX_NUMBER,
			label: "Verify media mailbox",
			extensionId: id(extension),
		});
		check("create a mailbox -> 201", mailbox.status === 201, `status ${mailbox.status}`);
		const mailboxId = id(mailbox);

		const greeting = await uploadA(
			`/api/v1/voicemail-boxes/${mailboxId}/greetings`,
			{ bytes: goodWav, name: "unavailable.wav", type: "audio/wav" },
			{ kind: "unavailable", label: "Main greeting" },
		);
		check("uploading a greeting -> 201", greeting.status === 201, `status ${greeting.status}`);
		const greetingId = id(greeting);
		const greetingKey = String(data(greeting).objectKey ?? "");
		check(
			"it is active by default and lands under greetings/<org>/<box>/",
			data(greeting).active === true &&
				greetingKey.startsWith(`greetings/${organizationA}/${mailboxId}/`),
			`${String(data(greeting).active)} ${greetingKey}`,
		);

		const temporary = await uploadA(
			`/api/v1/voicemail-boxes/${mailboxId}/greetings`,
			{ bytes: goodWav, name: "holiday.wav", type: "audio/wav" },
			{ kind: "temporary", active: "false" },
		);
		check(
			"a second greeting can be uploaded WITHOUT activating it",
			temporary.status === 201 && data(temporary).active === false,
			`status ${temporary.status} active=${String(data(temporary).active)}`,
		);
		const temporaryId = id(temporary);

		const listedGreetings = await clientA("GET", `/api/v1/voicemail-boxes/${mailboxId}/greetings`);
		check(
			"both greetings are listed",
			rows(listedGreetings).length === 2,
			`${String(rows(listedGreetings).length)} greeting(s)`,
		);

		// A second ACTIVE greeting of the same kind is the case the partial unique index exists for:
		// the upload has to deactivate the incumbent in the same transaction or the insert fails.
		const replacement = await uploadA(
			`/api/v1/voicemail-boxes/${mailboxId}/greetings`,
			{ bytes: goodWav, name: "unavailable-v2.wav", type: "audio/wav" },
			{ kind: "unavailable" },
		);
		check(
			"uploading a second ACTIVE greeting of the same kind succeeds (the incumbent is stood down)",
			replacement.status === 201 && data(replacement).active === true,
			`status ${replacement.status}`,
		);
		const replacementKey = String(data(replacement).objectKey ?? "");
		const afterReplacement = await clientA("GET", `/api/v1/voicemail-boxes/${mailboxId}/greetings`);
		check(
			"and exactly one `unavailable` greeting is active afterwards",
			afterReplacement2Active(rows(afterReplacement)) === 1,
			`${String(afterReplacement2Active(rows(afterReplacement)))} active`,
		);

		const activateTemporary = await clientA(
			"POST",
			`/api/v1/voicemail-boxes/${mailboxId}/greetings/${temporaryId}/activate`,
		);
		check(
			"activating the temporary greeting -> 200",
			activateTemporary.status === 200 && data(activateTemporary).active === true,
			`status ${activateTemporary.status}`,
		);

		const crossBox = await clientA(
			"POST",
			`/api/v1/voicemail-boxes/${mailboxId}/greetings/${greetingId}/activate`,
		);
		check(
			"a greeting is addressed through its own box (the pairing holds)",
			crossBox.status === 200,
			`status ${crossBox.status}`,
		);

		// --- 7. the compiled artifact ---------------------------------------------------------------
		console.log("\n7. the artifact carries the active greeting");
		// Put the box back in the state the artifact check expects: the replacement `unavailable`
		// greeting active, the temporary one stood down (it would otherwise WIN by precedence).
		await clientA(
			"POST",
			`/api/v1/voicemail-boxes/${mailboxId}/greetings/${temporaryId}/deactivate`,
		);
		const replacementId = id(replacement);
		await clientA(
			"POST",
			`/api/v1/voicemail-boxes/${mailboxId}/greetings/${replacementId}/activate`,
		);

		// --- 8. conference PINs ---------------------------------------------------------------------
		console.log("\n8. conference PINs");
		const conference = await clientA("POST", "/api/v1/conferences", {
			name: `Verify media room ${RUN_ID}`,
			roomNumber: ROOM_NUMBER,
			mohClassId,
		});
		check("create a conference -> 201", conference.status === 201, `status ${conference.status}`);
		const conferenceId = id(conference);
		check(
			"a conference response carries NEITHER digest",
			!Object.hasOwn(data(conference), "pinHash") &&
				!Object.hasOwn(data(conference), "moderatorPinHash"),
			Object.keys(data(conference)).join(","),
		);

		for (const [pin, why] of [
			["12ab", "letters"],
			["123", "too short"],
			["0000", "one repeated digit"],
			["1234", "a straight run"],
		] as const) {
			const refused = await clientA("POST", `/api/v1/conferences/${conferenceId}/pin`, { pin });
			check(
				`a room PIN of ${why} is refused with a field-addressable 400`,
				refused.status === 400 && refused.body.code === "PBX_INVALID_BODY",
				`status ${refused.status}`,
			);
		}

		const hashBeforePin = String(
			data(await clientA("POST", "/api/v1/routing/compile", {})).snapshotHash,
		);
		const setRoomPin = await clientA("POST", `/api/v1/conferences/${conferenceId}/pin`, {
			pin: GOOD_PIN,
		});
		check("setting a room PIN -> 201", setRoomPin.status === 201, `status ${setRoomPin.status}`);
		check(
			"the reply says a PIN is set and carries no digest",
			data(setRoomPin).pinSet === true && !Object.hasOwn(data(setRoomPin), "pinHash"),
			JSON.stringify(data(setRoomPin)),
		);

		const roomDigest = await readColumn(
			pbx,
			pbxSql,
			organizationA,
			"conference",
			"pin_hash",
			conferenceId,
		);
		check(
			"the stored digest is in the format packages/routing owns",
			parseVoicemailPinHash(roomDigest ?? "") !== undefined,
			String(roomDigest).slice(0, 32),
		);
		check(
			"it verifies against the PIN it was made from, via the engine's code path",
			await verifyVoicemailPin(GOOD_PIN, roomDigest ?? ""),
		);
		check("and refuses a different PIN", !(await verifyVoicemailPin("80413", roomDigest ?? "")));

		const hashAfterPin = String(
			data(await clientA("POST", "/api/v1/routing/compile", {})).snapshotHash,
		);
		check(
			"setting a room PIN MOVES the snapshot hash — `requiresPin` reaches the artifact",
			hashAfterPin !== hashBeforePin,
			`${hashBeforePin.slice(0, 12)} -> ${hashAfterPin.slice(0, 12)}`,
		);

		const setModeratorPin = await clientA(
			"POST",
			`/api/v1/conferences/${conferenceId}/moderator-pin`,
			{ pin: MODERATOR_PIN },
		);
		check(
			"setting a moderator PIN -> 201, and the reply reports both flags",
			setModeratorPin.status === 201 &&
				data(setModeratorPin).moderatorPinSet === true &&
				data(setModeratorPin).pinSet === true,
			JSON.stringify(data(setModeratorPin)),
		);
		const moderatorDigest = await readColumn(
			pbx,
			pbxSql,
			organizationA,
			"conference",
			"moderator_pin_hash",
			conferenceId,
		);
		check(
			"the moderator digest is stored in the same format and verifies",
			parseVoicemailPinHash(moderatorDigest ?? "") !== undefined &&
				(await verifyVoicemailPin(MODERATOR_PIN, moderatorDigest ?? "")),
			String(moderatorDigest).slice(0, 24),
		);
		const hashAfterModerator = String(
			data(await clientA("POST", "/api/v1/routing/compile", {})).snapshotHash,
		);
		// GAP CLOSED: the loader now projects `moderator_pin_hash` and `requiresModeratorPin`, so
		// setting one is a routing change rather than a column write nothing downstream reads.
		check(
			"setting a moderator PIN MOVES the hash — it used to recompile to an identical artifact",
			hashAfterModerator !== hashAfterPin,
			`${hashAfterPin.slice(0, 12)} -> ${hashAfterModerator.slice(0, 12)}`,
		);

		const clearedRoomPin = await clientA("DELETE", `/api/v1/conferences/${conferenceId}/pin`);
		check(
			"clearing the room PIN -> 200 and reports pinSet false",
			clearedRoomPin.status === 200 && data(clearedRoomPin).pinSet === false,
			`status ${clearedRoomPin.status}`,
		);
		check(
			"the column is NULL again",
			(await readColumn(pbx, pbxSql, organizationA, "conference", "pin_hash", conferenceId)) ===
				null,
		);
		const hashAfterClear = String(
			data(await clientA("POST", "/api/v1/routing/compile", {})).snapshotHash,
		);
		check(
			"clearing it moves the hash again, but NOT back to the start — the moderator PIN is still set",
			hashAfterClear !== hashAfterModerator && hashAfterClear !== hashBeforePin,
			`${hashAfterModerator.slice(0, 12)} -> ${hashAfterClear.slice(0, 12)} (start ${hashBeforePin.slice(0, 12)})`,
		);
		await clientA("DELETE", `/api/v1/conferences/${conferenceId}/moderator-pin`);
		check(
			"clearing BOTH returns the tenant to exactly the artifact it started with",
			String(data(await clientA("POST", "/api/v1/routing/compile", {})).snapshotHash) ===
				hashBeforePin,
		);
		// Put both back for the artifact inspection below.
		await clientA("POST", `/api/v1/conferences/${conferenceId}/pin`, { pin: GOOD_PIN });
		await clientA("POST", `/api/v1/conferences/${conferenceId}/moderator-pin`, {
			pin: MODERATOR_PIN,
		});

		// --- 9. E911 ---------------------------------------------------------------------------------
		console.log("\n9. emergency addresses");
		const address = await clientA("POST", "/api/v1/emergency-addresses", {
			label: `HQ ${RUN_ID}`,
			streetLine1: "1 Telephone Road",
			locationDetail: "Floor 3, Room 314",
			locality: "Springfield",
			administrativeArea: "IL",
			postalCode: "62701",
			country: "us",
		});
		check("create an emergency address -> 201", address.status === 201, `status ${address.status}`);
		const addressId = id(address);
		check(
			"the country is stored upper-case, and it is NOT validated on our say-so",
			data(address).country === "US" && data(address).validated === false,
			`${String(data(address).country)} validated=${String(data(address).validated)}`,
		);

		const selfValidated = await clientA("POST", "/api/v1/emergency-addresses", {
			label: `Fake ${RUN_ID}`,
			streetLine1: "2 Telephone Road",
			locality: "Springfield",
			administrativeArea: "IL",
			postalCode: "62701",
			validated: true,
		});
		check(
			"a client cannot mark its own address validated",
			selfValidated.status === 400 && selfValidated.body.code === "PBX_INVALID_BODY",
			`status ${selfValidated.status}`,
		);

		const missingStreet = await clientA("POST", "/api/v1/emergency-addresses", {
			label: `Bad ${RUN_ID}`,
			streetLine1: "   ",
			locality: "Springfield",
			administrativeArea: "IL",
			postalCode: "62701",
		});
		check(
			"an empty street is refused",
			missingStreet.status === 400,
			`status ${missingStreet.status}`,
		);

		const number = await clientA("POST", "/api/v1/phone-numbers", {
			e164: `+1555${(Date.now() % 1_000_000).toString().padStart(7, "0").slice(0, 7)}`,
			label: "Verify media DID",
			destinationType: "hangup",
			emergencyAddressId: addressId,
		});
		check(
			"a DID can be created with a dispatchable location",
			number.status === 201 && data(number).emergencyAddressId === addressId,
			`status ${number.status}`,
		);
		const numberId = id(number);

		const refusedAddress = await clientA("DELETE", `/api/v1/emergency-addresses/${addressId}`);
		check(
			"deleting an address a DID still uses is a 409 naming the number",
			refusedAddress.status === 409 &&
				JSON.stringify(refusedAddress.body.references ?? []).includes(numberId),
			`status ${refusedAddress.status} ${String(refusedAddress.body.code)}`,
		);

		await clientA("PATCH", `/api/v1/phone-numbers/${numberId}`, { emergencyAddressId: null });
		const deletedAddress = await clientA("DELETE", `/api/v1/emergency-addresses/${addressId}`);
		check(
			"once no number points at it, the address deletes",
			deletedAddress.status === 200,
			`status ${deletedAddress.status}`,
		);

		// RLS: organization B must not see, read or delete organization A's rows.
		const bSees = await clientB("GET", "/api/v1/emergency-addresses");
		check(
			"organization B sees none of organization A's addresses",
			rows(bSees).every((row) => row.label !== `Fake ${RUN_ID}`),
			`${String(rows(bSees).length)} row(s)`,
		);
		const bClasses = await clientB("GET", "/api/v1/moh-classes");
		check(
			"nor its MOH classes",
			rows(bClasses).every((row) => row.id !== mohClassId),
			`${String(rows(bClasses).length)} row(s)`,
		);
		const bReadsClass = await clientB("GET", `/api/v1/moh-classes/${mohClassId}`);
		check(
			"and reading one by id is a 404 rather than a 403",
			bReadsClass.status === 404,
			`status ${bReadsClass.status}`,
		);
		const bReadsGreetings = await clientB("GET", `/api/v1/voicemail-boxes/${mailboxId}/greetings`);
		check(
			"organization B cannot list organization A's greetings",
			bReadsGreetings.status === 404,
			`status ${bReadsGreetings.status}`,
		);

		// --- 10. HTTP Range --------------------------------------------------------------------------
		console.log("\n10. HTTP Range on every media route");

		// The pure decision function first: the cases a live request cannot easily reach.
		check("decideRange: no header -> full", decideRange(undefined, 100).kind === "full");
		check(
			"decideRange: a unit we do not serve -> full",
			decideRange("seconds=0-10", 100).kind === "full",
		);
		check(
			"decideRange: a malformed spec -> full (invalid, not unsatisfiable)",
			decideRange("bytes=abc", 100).kind === "full",
		);
		check(
			"decideRange: last before first -> full",
			decideRange("bytes=50-10", 100).kind === "full",
		);
		check(
			"decideRange: multi-range -> unsatisfiable, never half-answered",
			decideRange("bytes=0-9,20-29", 100).kind === "unsatisfiable",
		);
		check(
			"decideRange: start past the end -> unsatisfiable",
			decideRange("bytes=100-", 100).kind === "unsatisfiable",
		);
		check(
			"decideRange: a zero-length object -> unsatisfiable for any range",
			decideRange("bytes=0-", 0).kind === "unsatisfiable",
		);
		check(
			"decideRange: an end past the object is clamped, not refused",
			JSON.stringify(decideRange("bytes=0-999999", 100)) ===
				JSON.stringify({ kind: "partial", start: 0, end: 99, length: 100 }),
			JSON.stringify(decideRange("bytes=0-999999", 100)),
		);
		check(
			"decideRange: the suffix form takes the LAST n bytes",
			JSON.stringify(decideRange("bytes=-10", 100)) ===
				JSON.stringify({ kind: "partial", start: 90, end: 99, length: 10 }),
			JSON.stringify(decideRange("bytes=-10", 100)),
		);
		check(
			"decideRange: a suffix longer than the object starts at zero",
			JSON.stringify(decideRange("bytes=-999", 100)) ===
				JSON.stringify({ kind: "partial", start: 0, end: 99, length: 100 }),
		);
		check(
			"decideRange: `bytes=-0` asks for nothing -> unsatisfiable",
			decideRange("bytes=-0", 100).kind === "unsatisfiable",
		);

		// Then a real object, over the wire, on all four routes.
		const mohFileList = await clientA("GET", `/api/v1/moh-classes/${mohClassId}/files`);
		const survivingMohId = String(rows(mohFileList)[0]?.id ?? "");
		const mohPlay = await clientA("POST", `/api/v1/prompts/${survivingMohId}/play-url`);
		check(
			"minting a prompt preview link -> 201",
			mohPlay.status === 201,
			`status ${mohPlay.status}`,
		);
		await assertRangeBehaviour(
			"the prompt media route",
			String(data(mohPlay).url ?? ""),
			baseUrl,
			goodWav.length,
		);

		const greetingPlay = await clientA(
			"POST",
			`/api/v1/voicemail-boxes/${mailboxId}/greetings/${replacementId}/play-url`,
		);
		check(
			"minting a greeting preview link -> 201",
			greetingPlay.status === 201,
			`status ${greetingPlay.status}`,
		);
		await assertRangeBehaviour(
			"the greeting media route",
			String(data(greetingPlay).url ?? ""),
			baseUrl,
			goodWav.length,
		);

		// The voicemail MESSAGE route: seed a row the way the consumer would have filed it, pointing
		// at a real file, and drive the same three cases through it.
		const messageBytes = makeWav(8000, 1, 4000);
		await writeFile(join(mediaRoot, "verify-media-message.wav"), messageBytes);
		const messageId = await seedMessage(
			pbx,
			pbxSql,
			organizationA,
			mailboxId,
			"verify-media-message.wav",
		);
		const messagePlay = await clientA(
			"POST",
			`/api/v1/voicemail-boxes/${mailboxId}/messages/${messageId}/play-url`,
		);
		check(
			"minting a voicemail playback link -> 201",
			messagePlay.status === 201,
			`status ${messagePlay.status}`,
		);
		await assertRangeBehaviour(
			"the voicemail message media route",
			String(data(messagePlay).url ?? ""),
			baseUrl,
			messageBytes.length,
		);

		const tampered = `${String(data(messagePlay).url ?? "")}tamper`;
		const tamperedResponse = await fetch(`${baseUrl}${tampered}`, {
			headers: { range: "bytes=0-9" },
		});
		check(
			"a tampered token is still refused, range or no range",
			tamperedResponse.status === 403,
			`status ${tamperedResponse.status}`,
		);
		void (await tamperedResponse.arrayBuffer());

		// --- 11. the artifact -------------------------------------------------------------------------
		console.log("\n11. the compiled artifact");
		await clientA("POST", "/api/v1/routing/compile", {});
		if (nats === undefined) {
			console.log("  (artifact inspection SKIPPED — no broker to read the KV bucket from)");
		} else {
			const { connect } = await import("nats");
			const inspectConnection = await connect({ servers: nats.url, name: "verify-media-kv" });
			try {
				const manager = await inspectConnection.jetstreamManager();
				const bucket = await manager.jetstream().views.kv(ROUTING_CACHE_BUCKET);
				const entry = await bucket.get(routingCacheKey(organizationA));
				const artifact =
					entry === null
						? undefined
						: (JSON.parse(new TextDecoder().decode(entry.value)) as ArtifactShape);
				check("the artifact is in the routing-cache bucket", artifact !== undefined);

				const nodes = collectNodes(artifact);

				// `mode` matters: a mailbox compiles to a `leave` node AND a `check` node, and only the
				// first carries a greeting. Matching on the box alone finds whichever the node table
				// happened to enumerate first, which is how this check passes by accident.
				const voicemailNode = nodes.find(
					(node) =>
						node.kind === "voicemail" && node.voicemailBoxId === mailboxId && node.mode === "leave",
				);
				check(
					"the mailbox's leave node carries the ACTIVE greeting as an object:// ref",
					typeof voicemailNode?.greetingMedia === "string" &&
						voicemailNode.greetingMedia === `object://${replacementKey}`,
					String(voicemailNode?.greetingMedia),
				);
				check(
					"and names the kind it came from",
					voicemailNode?.greetingKind === "unavailable",
					String(voicemailNode?.greetingKind),
				);

				const conferenceNode = nodes.find(
					(node) => node.kind === "conference" && node.conferenceId === conferenceId,
				);
				check(
					"the conference node says the room requires a PIN",
					conferenceNode?.requiresPin === true,
					String(conferenceNode?.requiresPin),
				);
				// GAP CLOSED (routing README §7 item 11). The digest now travels, so the engine can
				// verify what `requiresPin` announces — and this is asserted against the SAME digest
				// the engine's verifier accepted a few checks above, not merely against "a string".
				check(
					"the conference node carries the participant digest the engine verifies",
					typeof conferenceNode?.pinHash === "string" &&
						(await verifyVoicemailPin(GOOD_PIN, String(conferenceNode.pinHash))),
					String(conferenceNode?.pinHash).slice(0, 24),
				);
				check(
					"and the moderator digest, which used to reach nothing at all",
					typeof conferenceNode?.moderatorPinHash === "string" &&
						(await verifyVoicemailPin(MODERATOR_PIN, String(conferenceNode.moderatorPinHash))),
					String(conferenceNode?.moderatorPinHash).slice(0, 24),
				);
				check(
					"and says the room has a moderator PIN, which is what makes waitForModerator enforceable",
					conferenceNode?.requiresModeratorPin === true,
					String(conferenceNode?.requiresModeratorPin),
				);
				check(
					"the conference resolves its MOH class id to the RENAMED class name",
					conferenceNode?.mohClass === `hold-renamed-${RUN_ID}`,
					`${String(conferenceNode?.mohClassId)} -> ${String(conferenceNode?.mohClass)}`,
				);

				// GAP CLOSED (routing README §7 item 12). E911 is no longer "an address book nothing
				// on the call path reads": the emergency table is in the artifact, in both contexts,
				// and it points at a node marked `emergency`.
				const emergencyNode = nodes.find(
					(node) => node.kind === "trunk-dial" && node.emergency === true,
				);
				check(
					"the artifact carries an emergency dial node",
					emergencyNode !== undefined,
					String(emergencyNode?.id),
				);
				const internalEmergency = (
					artifact as { internal?: { emergency?: Record<string, unknown> } }
				).internal?.emergency;
				const outboundEmergency = (
					artifact as { outbound?: { emergency?: Record<string, unknown> } }
				).outbound?.emergency;
				check(
					"911 is in BOTH the internal and the outbound emergency tables",
					internalEmergency?.["911"] !== undefined && outboundEmergency?.["911"] !== undefined,
					`${Object.keys(internalEmergency ?? {}).join(",")} | ${Object.keys(outboundEmergency ?? {}).join(",")}`,
				);
				check(
					"the outside-line form 9911 dials 911 on the wire",
					(outboundEmergency?.["9911"] as { number?: string } | undefined)?.number === "911",
					JSON.stringify(outboundEmergency?.["9911"]),
				);
			} finally {
				await inspectConnection.drain();
			}
		}

		// --- 12. deleting a class takes its audio with it ---------------------------------------------
		console.log("\n12. deleting an MOH class");
		const stillReferenced = await clientA("DELETE", `/api/v1/moh-classes/${mohClassId}`);
		check(
			"a class an extension and a conference still name is a 409",
			stillReferenced.status === 409,
			`status ${stillReferenced.status} ${String(stillReferenced.body.code)}`,
		);
		check(
			"and its files survive the refused delete",
			(await countObjects(join(mediaRoot, "moh", organizationA, mohClassId))) === 2,
		);

		await clientA("PATCH", `/api/v1/extensions/${id(extension)}`, { mohClassId: null });
		await clientA("PATCH", `/api/v1/conferences/${conferenceId}`, { mohClassId: null });
		const removedClass = await clientA("DELETE", `/api/v1/moh-classes/${mohClassId}`);
		check(
			"once nothing names it, the class deletes",
			removedClass.status === 200,
			`status ${removedClass.status}`,
		);
		check(
			"and every file under it is gone from the object store",
			(await countObjects(join(mediaRoot, "moh", organizationA, mohClassId))) === 0,
		);
		const orphanRows = await clientA("GET", "/api/v1/prompts?kind=moh");
		check(
			"the cascade took the rows too",
			rows(orphanRows).every((row) => row.mohClassId !== mohClassId),
			`${String(rows(orphanRows).length)} row(s)`,
		);

		// --- 13. deleting a greeting -------------------------------------------------------------------
		console.log("\n13. deleting a greeting");
		const removedGreeting = await clientA(
			"DELETE",
			`/api/v1/voicemail-boxes/${mailboxId}/greetings/${greetingId}`,
		);
		check(
			"deleting a greeting -> 200",
			removedGreeting.status === 200,
			`status ${removedGreeting.status}`,
		);
		check(
			"its object is gone",
			(await stat(join(mediaRoot, greetingKey)).catch(() => undefined)) === undefined,
		);
		const afterGreetingDelete = await clientA(
			"GET",
			`/api/v1/voicemail-boxes/${mailboxId}/greetings`,
		);
		check(
			"and it is out of the list",
			rows(afterGreetingDelete).every((row) => row.id !== greetingId),
			`${String(rows(afterGreetingDelete).length)} greeting(s)`,
		);
	} finally {
		await app.close();
		await pbx.close();
		await sql.end({ timeout: 5 });
		await rm(mediaRoot, { recursive: true, force: true });
		if (nats !== undefined) {
			await stopNats(nats);
		}
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
	if (failed.length > 0) {
		console.error("\nFAILED:");
		for (const entry of failed) {
			console.error(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`);
		}
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------------------------
// Range, over the wire
// ---------------------------------------------------------------------------------------------

/**
 * Drives one media URL through the three outcomes and asserts the exact headers each one owes.
 *
 * The BODY is compared, not just the status. A `206` whose `content-length` says 32 and whose body
 * is the whole file is the single most common way to get partial responses wrong, and it is
 * invisible to a check that only reads headers — the player buffers forever waiting for bytes that
 * are not coming.
 */
async function assertRangeBehaviour(
	label: string,
	url: string,
	baseUrl: string,
	sizeBytes: number,
): Promise<void> {
	const full = await fetch(`${baseUrl}${url}`);
	const fullBody = new Uint8Array(await full.arrayBuffer());
	check(
		`${label}: no Range -> 200 with the whole object`,
		full.status === 200 && fullBody.length === sizeBytes,
		`status ${full.status}, ${String(fullBody.length)}/${String(sizeBytes)} bytes`,
	);
	check(
		`${label}: and advertises accept-ranges: bytes on the FIRST response`,
		full.headers.get("accept-ranges") === "bytes",
		String(full.headers.get("accept-ranges")),
	);
	check(
		`${label}: with a content-length that matches the body`,
		full.headers.get("content-length") === String(sizeBytes),
		String(full.headers.get("content-length")),
	);

	const partial = await fetch(`${baseUrl}${url}`, { headers: { range: "bytes=10-41" } });
	const partialBody = new Uint8Array(await partial.arrayBuffer());
	check(`${label}: a satisfiable Range -> 206`, partial.status === 206, `status ${partial.status}`);
	check(
		`${label}: with the right content-range`,
		partial.headers.get("content-range") === `bytes 10-41/${String(sizeBytes)}`,
		String(partial.headers.get("content-range")),
	);
	check(
		`${label}: a content-length of the RANGE, not of the object`,
		partial.headers.get("content-length") === "32",
		String(partial.headers.get("content-length")),
	);
	check(
		`${label}: and a body that is exactly those 32 bytes`,
		partialBody.length === 32 && sameBytes(partialBody, fullBody.slice(10, 42)),
		`${String(partialBody.length)} bytes`,
	);

	const suffix = await fetch(`${baseUrl}${url}`, { headers: { range: "bytes=-16" } });
	const suffixBody = new Uint8Array(await suffix.arrayBuffer());
	check(
		`${label}: the suffix form returns the last 16 bytes`,
		suffix.status === 206 &&
			suffixBody.length === 16 &&
			sameBytes(suffixBody, fullBody.slice(sizeBytes - 16)),
		`status ${suffix.status}, ${String(suffixBody.length)} bytes`,
	);

	const past = await fetch(`${baseUrl}${url}`, {
		headers: { range: `bytes=${String(sizeBytes + 10)}-` },
	});
	void (await past.arrayBuffer());
	check(`${label}: a Range past the end -> 416`, past.status === 416, `status ${past.status}`);
	check(
		`${label}: whose content-range tells the client the real size`,
		past.headers.get("content-range") === `bytes */${String(sizeBytes)}`,
		String(past.headers.get("content-range")),
	);

	const ignored = await fetch(`${baseUrl}${url}`, { headers: { range: "seconds=0-10" } });
	const ignoredBody = new Uint8Array(await ignored.arrayBuffer());
	check(
		`${label}: a unit we do not serve is ignored -> 200 with everything`,
		ignored.status === 200 && ignoredBody.length === sizeBytes,
		`status ${ignored.status}`,
	);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface ArtifactShape {
	readonly nodes?: Record<string, Record<string, unknown>>;
}

interface PlanNodeShape {
	readonly id?: string;
	readonly kind?: string;
	readonly mode?: string;
	readonly voicemailBoxId?: string;
	readonly greetingMedia?: string;
	readonly greetingKind?: string;
	readonly conferenceId?: string;
	readonly requiresPin?: boolean;
	readonly pinHash?: string;
	readonly moderatorPinHash?: string;
	readonly requiresModeratorPin?: boolean;
	readonly mohClassId?: string;
	readonly mohClass?: string;
	/** Set only on the one `trunk-dial` node that was not compiled from an `outbound_route` row. */
	readonly emergency?: boolean;
	readonly elin?: string;
	readonly emergencyAddressId?: string;
}

/**
 * Every node in the artifact, whatever shape the node table happens to have.
 *
 * The artifact is a NODE TABLE rather than a tree (`packages/routing` §2.2), so this is a values
 * walk rather than a traversal — the same helper `verify-voicemail.ts` uses, and defensive for the
 * same reason: this script asserts against the artifact's CONTENT, not its container.
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

/** How many active `unavailable` greetings a listing shows. The partial unique index's whole job. */
function afterReplacement2Active(greetings: readonly Record<string, unknown>[]): number {
	return greetings.filter((row) => row.kind === "unavailable" && row.active === true).length;
}

function unwrap(result: unknown): Record<string, unknown>[] {
	return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Record<
		string,
		unknown
	>[];
}

/** Reads a column no endpoint returns — by design, for every digest in this schema. */
async function readColumn(
	pbx: PbxDatabaseClient,
	pbxSql: PbxSql,
	organizationId: string,
	table: string,
	column: string,
	rowId: string,
): Promise<string | null> {
	return await pbx.withTenantScope(organizationId, async (transaction) => {
		const found = unwrap(
			await transaction.execute(
				pbxSql`select ${pbxSql.identifier(column)} as value from ${pbxSql.identifier(table)} where "id" = ${rowId}::uuid`,
			),
		);
		const value = found[0]?.value;
		return typeof value === "string" ? value : null;
	});
}

/** Seeds one message the way the engine's consumer would have filed it. */
async function seedMessage(
	pbx: PbxDatabaseClient,
	pbxSql: PbxSql,
	organizationId: string,
	mailboxId: string,
	objectKey: string,
): Promise<string> {
	const { createEntityId } = await import("@optimiq-voice/identifiers");
	const messageId = createEntityId();
	await pbx.withTenantScope(organizationId, async (transaction) => {
		await transaction.execute(
			pbxSql`insert into "voicemail_message"
				("id", "organization_id", "voicemail_box_id", "folder", "caller_id_number",
				 "received_at", "duration_ms", "object_key", "size_bytes")
				values (${messageId}::uuid, ${organizationId}::uuid, ${mailboxId}::uuid, 'new',
					'+15551119999', now(), 500, ${objectKey}, 0)`,
		);
	});
	return messageId;
}

/** How many regular files sit under a directory. `0` for a directory that is not there. */
async function countObjects(directory: string): Promise<number> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile()).length;
	} catch {
		return 0;
	}
}

await main();
