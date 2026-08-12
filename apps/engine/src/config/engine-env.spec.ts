import { describe, expect, it } from "bun:test";
import { loadEngineEnv } from "./engine-env";

describe("engine env", () => {
	it("does not require ARI credentials when mediad is selected", () => {
		const env = loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" });
		expect(env.ENGINE_MEDIA_DRIVER).toBe("mediad");
		expect(env.ARI_PASSWORD).toBeUndefined();
	});

	it("still requires ARI credentials when ARI is selected", () => {
		expect(() => loadEngineEnv({ ENGINE_MEDIA_DRIVER: "ari" })).toThrow(
			"ARI_PASSWORD: is required when ENGINE_MEDIA_DRIVER=ari",
		);
	});

	it("treats an empty ENGINE_DEFAULT_ORGANIZATION_ID as unset", () => {
		const env = loadEngineEnv({ ARI_PASSWORD: "x", ENGINE_DEFAULT_ORGANIZATION_ID: "" });
		expect(env.ENGINE_DEFAULT_ORGANIZATION_ID).toBeUndefined();
	});

	it("still rejects a value that is present and not a uuid", () => {
		expect(() =>
			loadEngineEnv({ ARI_PASSWORD: "x", ENGINE_DEFAULT_ORGANIZATION_ID: "nope" }),
		).toThrow();
	});

	it("accepts a real organization id", () => {
		const id = "0195c0f0-1c2f-7000-8000-0000000000aa";
		expect(
			loadEngineEnv({ ARI_PASSWORD: "x", ENGINE_DEFAULT_ORGANIZATION_ID: id })
				.ENGINE_DEFAULT_ORGANIZATION_ID,
		).toBe(id);
	});

	it("defaults the routing knobs so a bare deployment still routes", () => {
		const env = loadEngineEnv({ ARI_PASSWORD: "x" });
		expect(env.ENGINE_ROUTING_ENABLED).toBe(true);
		expect(env.ENGINE_EXTENSION_DIAL_TEMPLATE).toBe("PJSIP/{number}");
		expect(env.ENGINE_TRUNK_DIAL_TEMPLATE).toBe("PJSIP/{number}@{trunk}");
		expect(env.ENGINE_ROUTING_RPC_TIMEOUT_MS).toBe(2000);
	});

	it("gives a bare deployment a working claim identity and heartbeat", () => {
		const env = loadEngineEnv({ ARI_PASSWORD: "x" });
		expect(env.ENGINE_INSTANCE_ID).toBe("engine");
		// Just under a third of the lease, so the third opportunity precedes expiry.
		expect(env.ENGINE_CLAIM_HEARTBEAT_MS).toBe(29_999);
	});

	it("takes the instance id an orchestrator supplies", () => {
		expect(
			loadEngineEnv({ ARI_PASSWORD: "x", ENGINE_INSTANCE_ID: "engine-7f3a" }).ENGINE_INSTANCE_ID,
		).toBe("engine-7f3a");
	});

	it("accepts the largest heartbeat interval whose third tick is before lease expiry", () => {
		expect(
			loadEngineEnv({ ARI_PASSWORD: "x", ENGINE_CLAIM_HEARTBEAT_MS: "29999" })
				.ENGINE_CLAIM_HEARTBEAT_MS,
		).toBe(29_999);
	});

	it.each(["30000", "90000"])(
		"refuses heartbeat interval %s because the third tick must be strictly before expiry",
		(value) => {
			expect(() => loadEngineEnv({ ARI_PASSWORD: "x", ENGINE_CLAIM_HEARTBEAT_MS: value })).toThrow(
				/ENGINE_CLAIM_HEARTBEAT_MS/u,
			);
		},
	);
});
