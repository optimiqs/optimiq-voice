import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { AriClient } from "./client";
import { AriEventStream } from "./event-stream";
import type { AriEvent } from "./events";

/**
 * Proves this adapter against a REAL Asterisk 22.
 *
 * ```sh
 * # from the repository root
 * pnpm --filter @optimiq-voice/media-ari test:integration
 * # or, against an Asterisk you are already running
 * RUN_ARI_INTEGRATION_TESTS=true ARI_INTEGRATION_URL=http://127.0.0.1:8088 \
 *   ARI_INTEGRATION_USERNAME=ari ARI_INTEGRATION_PASSWORD=secret \
 *   bun test src/ari-integration.spec.ts
 * ```
 *
 * By default it builds and runs `apps/asterisk` as a throwaway container, drives one call through
 * it, and removes the container afterwards. It never touches a container it did not start.
 *
 * The flow is the vertical slice the engine depends on: originate a Local channel into the Stasis
 * application, see `StasisStart` on the event socket, answer it, hang it up with an explicit
 * Q.850 cause, and see `ChannelDestroyed` carrying that cause back.
 */

const ENABLED = process.env.RUN_ARI_INTEGRATION_TESTS === "true";
const EXTERNAL_URL = process.env.ARI_INTEGRATION_URL;
const USERNAME = process.env.ARI_INTEGRATION_USERNAME ?? "ari";
const PASSWORD = process.env.ARI_INTEGRATION_PASSWORD ?? "integration-secret";
const APP = "optimiq-media-ari-it";
const CONTAINER_NAME = `optimiq-ari-it-${String(process.pid)}`;
const IMAGE_TAG = `optimiq-voice/asterisk-it:${String(process.pid)}`;
const HOST_PORT = 8188;
/** Q.850 21 — `CALL_REJECTED`. Chosen because it is unmistakably not the default. */
const HANGUP_CAUSE = 21;

function docker(...args: readonly string[]): string {
	const result = spawnSync("docker", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

function tryDocker(...args: readonly string[]): void {
	spawnSync("docker", [...args], { encoding: "utf8" });
}

/**
 * `apps/asterisk` templates its config at boot from env vars, so the container is started with the
 * credentials this spec will use. `run.sh` substitutes the `*_PLACEHOLDER` tokens.
 */
function startAsterisk(): { readonly baseUrl: string; readonly started: boolean } {
	if (EXTERNAL_URL !== undefined && EXTERNAL_URL !== "") {
		return { baseUrl: EXTERNAL_URL, started: false };
	}

	docker("build", "-t", IMAGE_TAG, `${import.meta.dir}/../../../apps/asterisk`);
	docker(
		"run",
		"-d",
		"--rm",
		"--name",
		CONTAINER_NAME,
		"-p",
		`${String(HOST_PORT)}:8088`,
		"-e",
		`ARI_USERNAME=${USERNAME}`,
		"-e",
		`ARI_SECRET=${PASSWORD}`,
		"-e",
		"ARI_PROXY_URL=http://127.0.0.1:8088",
		IMAGE_TAG,
	);
	return { baseUrl: `http://127.0.0.1:${String(HOST_PORT)}`, started: true };
}

async function waitForAri(client: AriClient, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await client.ping();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	throw new Error(`ARI never became ready: ${String(lastError)}`);
}

/** Waits for the first event matching `predicate`, or rejects on timeout. */
function waitForEvent(
	received: readonly AriEvent[],
	predicate: (event: AriEvent) => boolean,
	timeoutMs = 15_000,
): Promise<AriEvent> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = setInterval(() => {
			const match = received.find(predicate);
			if (match !== undefined) {
				clearInterval(poll);
				resolve(match);
				return;
			}
			if (Date.now() > deadline) {
				clearInterval(poll);
				reject(new Error("timed out waiting for an ARI event"));
			}
		}, 100);
	});
}

const suite = ENABLED ? describe : describe.skip;

suite("media-ari against a live Asterisk 22", () => {
	let client: AriClient;
	let stream: AriEventStream;
	let startedContainer = false;
	const received: AriEvent[] = [];
	const errors: unknown[] = [];

	beforeAll(async () => {
		const asterisk = startAsterisk();
		startedContainer = asterisk.started;

		client = new AriClient({
			baseUrl: asterisk.baseUrl,
			username: USERNAME,
			password: PASSWORD,
			app: APP,
		});

		await waitForAri(client, 120_000);

		stream = client.createEventStream({
			onEvent: (event) => received.push(event),
			onError: (error) => errors.push(error),
		});
		await stream.start();
	}, 180_000);

	afterAll(() => {
		stream?.close();
		if (startedContainer) {
			tryDocker("rm", "-f", CONTAINER_NAME);
			tryDocker("rmi", "-f", IMAGE_TAG);
		}
	});

	it("reads /asterisk/info and reports a 22.x version", async () => {
		const info = await client.ping();
		expect(info.version).toBeDefined();
		expect(info.version?.startsWith("22.")).toBe(true);
	});

	it("registers the Stasis application once the event socket is open", async () => {
		expect(stream.isOpen).toBe(true);
		const application = await client.applications.get(APP);
		expect(application?.name).toBe(APP);
	});

	it("maps an unknown resource to AriHttpError(404)", async () => {
		await expect(client.channels.get("does-not-exist")).resolves.toBeUndefined();
		await expect(client.bridges.get("does-not-exist")).resolves.toBeUndefined();
	});

	it("drives a call: originate into Stasis, answer, hang up with an explicit cause", async () => {
		const channelId = `it-${String(Date.now())}`;

		// `Local/…@…` with no matching extension would fail; the Stasis app itself is the
		// destination, which is exactly how the engine originates a leg it wants to control.
		const channel = await client.channels.originate({
			endpoint: `Local/${channelId}@local-ctx`,
			app: APP,
			appArgs: "integration",
			channelId,
			timeoutSeconds: 10,
			variables: { OPTIMIQ_INTEGRATION: "1" },
		});
		expect(channel.id).toBe(channelId);

		const start = await waitForEvent(
			received,
			(event) => event.type === "StasisStart" && event.channel.id === channelId,
		);
		expect(start.type).toBe("StasisStart");

		await client.channels.setVariable(channelId, "OPTIMIQ_ORG_ID", "org-under-test");
		await expect(client.channels.getVariable(channelId, "OPTIMIQ_ORG_ID")).resolves.toBe(
			"org-under-test",
		);
		await expect(
			client.channels.getVariable(channelId, "OPTIMIQ_NEVER_SET"),
		).resolves.toBeUndefined();

		await client.channels.answer(channelId);
		await waitForEvent(
			received,
			(event) =>
				event.type === "ChannelStateChange" &&
				event.channel.id === channelId &&
				event.channel.state === "Up",
		);

		await client.channels.hangup(channelId, { causeCode: HANGUP_CAUSE });

		const destroyed = await waitForEvent(
			received,
			(event) => event.type === "ChannelDestroyed" && event.channel.id === channelId,
		);
		if (destroyed.type !== "ChannelDestroyed") {
			throw new Error("narrowing failed");
		}
		expect(destroyed.cause).toBe(HANGUP_CAUSE);

		expect(errors).toEqual([]);
	}, 60_000);

	it("creates, populates and destroys a bridge", async () => {
		const bridgeId = `it-bridge-${String(Date.now())}`;
		const bridge = await client.bridges.create({ types: ["mixing"], bridgeId, name: bridgeId });
		expect(bridge.id).toBe(bridgeId);

		await expect(client.bridges.get(bridgeId)).resolves.toMatchObject({ id: bridgeId });
		await client.bridges.destroy(bridgeId);
		await expect(client.bridges.get(bridgeId)).resolves.toBeUndefined();

		// Destroying it twice must be a no-op, not a failure — the engine races Asterisk's own
		// teardown of an emptied bridge on every hangup.
		await expect(client.bridges.destroy(bridgeId)).resolves.toBeUndefined();
	}, 30_000);
});
