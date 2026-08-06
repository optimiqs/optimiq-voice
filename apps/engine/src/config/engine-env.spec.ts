import { describe, expect, it } from "bun:test";
import { loadEngineEnv } from "./engine-env";

describe("engine env", () => {
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
});
