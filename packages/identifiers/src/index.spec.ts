import { describe, expect, it } from "bun:test";
import {
	createDeterministicEntityId,
	createEntityId,
	DETERMINISTIC_ENTITY_ID_NAMESPACE,
	isEntityId,
	isUuidV7EntityId,
} from "./index";

describe("entity identifiers", () => {
	it("creates UUID v7 identifiers for new durable entities", () => {
		const id = createEntityId();

		expect(isEntityId(id)).toBe(true);
		expect(isUuidV7EntityId(id)).toBe(true);
	});

	it("creates monotonically sortable identifiers", () => {
		const first = createEntityId();
		const second = createEntityId();

		expect(second >= first).toBe(true);
	});

	it("creates stable namespace-based UUIDs for deterministic provisioning", () => {
		const first = createDeterministicEntityId("extension:workspace-1:1001");
		const second = createDeterministicEntityId("extension:workspace-1:1001");

		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
		expect(createDeterministicEntityId("extension:workspace-2:1001")).not.toBe(first);
	});

	it("keeps the deterministic namespace frozen", () => {
		expect(DETERMINISTIC_ENTITY_ID_NAMESPACE).toBe("9a4f2b31-6c7e-4d18-b0a5-27fe6c9d8e40");
		expect(isEntityId(DETERMINISTIC_ENTITY_ID_NAMESPACE)).toBe(true);
	});

	it("does not accept NanoIDs or arbitrary external IDs as entity IDs", () => {
		expect(isEntityId("V1StGXR8_Z5jdHi6B-myT")).toBe(false);
		expect(isEntityId("call_123")).toBe(false);
		expect(isEntityId("")).toBe(false);
	});

	it("rejects non-v7 UUIDs for the new-entity policy", () => {
		const deterministic = createDeterministicEntityId("extension:workspace-1:1001");

		expect(isEntityId(deterministic)).toBe(true);
		expect(isUuidV7EntityId(deterministic)).toBe(false);
	});
});
