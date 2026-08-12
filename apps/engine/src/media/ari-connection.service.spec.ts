import { describe, expect, it } from "bun:test";
import { loadEngineEnv } from "../config/engine-env";
import { AriConnectionService } from "./ari-connection.service";

describe("AriConnectionService driver selection", () => {
	it("constructs and starts as a no-op when mediad is selected", async () => {
		const service = new AriConnectionService(loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" }));

		expect(service.isSelected).toBe(false);
		await expect(service.start()).resolves.toBeUndefined();
		expect(service.streamStatus).toBe("idle");
		expect(service.isConnected).toBe(false);
	});

	it("does not expose an ARI client under the mediad driver", () => {
		const service = new AriConnectionService(loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" }));
		expect(() => service.client).toThrow("ARI client requested");
	});
});
