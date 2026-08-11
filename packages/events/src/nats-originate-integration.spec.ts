import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { connect, type NatsConnection } from "nats";
import { createEntityId } from "@optimiq-voice/identifiers";
import { ORIGINATE_RPC, originateRequestSchema, originateResponseSchema } from "./schemas/rpc";
import { subjectFor } from "./subjects";

/**
 * `rpc.engine.v1.originate` against a real broker running the platform's REAL configuration.
 *
 * ```sh
 * RUN_NATS_INTEGRATION_TESTS=true pnpm --filter @optimiq-voice/events test:integration
 * ```
 *
 * Its sibling `nats-integration.spec.ts` proves the STREAM definitions against a broker with no
 * authentication at all. This one proves something the other cannot: that `config/nats.conf` — the
 * file with the per-service allow-lists in it — actually permits the two grants click-to-call needs
 * and refuses the ones it does not. A permission mistake in that file does not fail a build, it
 * fails a dial button in production with a timeout, so it is worth one round trip to find out here.
 *
 * The refusal path is enough, and is what is exercised: a responder that answers `unknown_extension`
 * proves the whole wire — the api user may publish, the engine user may subscribe, the queue group
 * delivers exactly once, and the bytes on the wire are the contract with no NestJS framing around
 * them. Placing a real call would need Asterisk, which `apps/engine`'s own integration suite has.
 */

const ENABLED = process.env.RUN_NATS_INTEGRATION_TESTS === "true";
const CONTAINER_PORT = 4224;
const CONTAINER_NAME = `optimiq-originate-it-${process.pid}`;
const IMAGE = "nats:2.11-alpine";
const CONFIG_DIR = resolve(import.meta.dir, "../../../config");

/** The credentials the config file reads out of the environment. Throwaway, for a throwaway broker. */
const CREDENTIALS = {
	NATS_USER: "admin",
	NATS_PASS: "admin-pass",
	NATS_API_USER: "api",
	NATS_API_PASS: "api-pass",
	NATS_ENGINE_USER: "engine",
	NATS_ENGINE_PASS: "engine-pass",
	NATS_MEDIAD_USER: "mediad",
	NATS_MEDIAD_PASS: "mediad-pass",
	NATS_SIPD_USER: "sipd",
	NATS_SIPD_PASS: "sipd-pass",
	NATS_SYS_USER: "sys",
	NATS_SYS_PASS: "sys-pass",
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function docker(...args: readonly string[]): string {
	const result = spawnSync("docker", [...args], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

function startBroker(): string {
	const env = Object.entries(CREDENTIALS).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
	return docker(
		"run",
		"-d",
		"--rm",
		"--name",
		CONTAINER_NAME,
		"-p",
		`${CONTAINER_PORT}:4222`,
		"-v",
		`${CONFIG_DIR}:/etc/nats:ro`,
		...env,
		IMAGE,
		"-c",
		"/etc/nats/nats.conf",
	);
}

async function connectAs(user: string, pass: string): Promise<NatsConnection> {
	const deadline = Date.now() + 90_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await connect({
				servers: `nats://127.0.0.1:${CONTAINER_PORT}`,
				user,
				pass,
				maxReconnectAttempts: 3,
				timeout: 2_000,
			});
		} catch (error) {
			lastError = error;
			await Bun.sleep(250);
		}
	}
	throw new Error(`NATS never became ready for ${user}: ${String(lastError)}`);
}

describe.skipIf(!ENABLED)("rpc.engine.v1.originate over the real nats.conf (integration)", () => {
	let containerId: string | undefined;
	let api: NatsConnection;
	let engine: NatsConnection;

	beforeAll(async () => {
		containerId = startBroker();
		api = await connectAs(CREDENTIALS.NATS_API_USER, CREDENTIALS.NATS_API_PASS);
		engine = await connectAs(CREDENTIALS.NATS_ENGINE_USER, CREDENTIALS.NATS_ENGINE_PASS);
	}, 180_000);

	afterAll(async () => {
		await api?.close();
		await engine?.close();
		if (containerId !== undefined) {
			spawnSync("docker", ["rm", "-f", containerId], { encoding: "utf8" });
		}
	}, 60_000);

	it("carries a refusal from the engine's queue group back to the api, payload-only", async () => {
		const subject = subjectFor.engineOriginateRpc();
		const subscription = engine.subscribe(subject, { queue: "optimiq-engine-originate" });
		void (async () => {
			for await (const message of subscription) {
				// The responder's half, in the shape `originate.service.ts` serves: parse the BARE
				// payload — no `{"pattern":…,"data":…}` wrapper — and answer the contract.
				const request = originateRequestSchema.parse(
					JSON.parse(decoder.decode(message.data)) as unknown,
				);
				message.respond(
					encoder.encode(
						JSON.stringify({
							ok: false,
							originateId: request.originateId,
							instanceId: "engine-it",
							reason: "unknown_extension",
							error: `no extension ${request.fromExtension} in this organization`,
						}),
					),
				);
			}
		})();

		const originateId = createEntityId();
		const reply = await api.request(
			subject,
			encoder.encode(
				JSON.stringify({
					orgId: createEntityId(),
					originateId,
					fromExtension: "9999",
					to: "+15551230000",
				}),
			),
			{ timeout: ORIGINATE_RPC.timeoutMs },
		);

		const response = originateResponseSchema.parse(JSON.parse(decoder.decode(reply.data)));
		expect(response.ok).toBe(false);
		expect(response.originateId).toBe(originateId);
		expect(response.reason).toBe("unknown_extension");
		subscription.unsubscribe();
	}, 30_000);

	it("refuses the same publish from a service the allow-list does not grant it to", async () => {
		const mediad = await connectAs(CREDENTIALS.NATS_MEDIAD_USER, CREDENTIALS.NATS_MEDIAD_PASS);
		// Every status, not just the ones a version of the client happens to type as errors: a
		// permissions violation is delivered on this channel and its SHAPE has moved between releases,
		// while the subject in its text has not.
		const statuses: string[] = [];
		void (async () => {
			for await (const status of mediad.status()) {
				statuses.push(JSON.stringify(status));
			}
		})();

		// The media plane is the process with RTP sockets open to the internet. It must not be able to
		// make this platform place calls.
		mediad.publish(subjectFor.engineOriginateRpc(), encoder.encode("{}"));
		await mediad.flush();
		await Bun.sleep(250);

		expect(statuses.join(" ")).toContain("rpc.engine.v1.originate");
		await mediad.close();
	}, 30_000);
});
