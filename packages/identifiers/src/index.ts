import { version as uuidVersion, v3 as uuidv3, v7 as uuidv7, validate as validateUuid } from "uuid";

/**
 * Stable namespace for deterministic UUIDs used when provisioning idempotent managed
 * resources (extensions, trunks, dialplan contexts) and during legacy identifier cutovers.
 * Never rotate this value after identifiers ship — rotating it re-keys every derived entity.
 */
export const DETERMINISTIC_ENTITY_ID_NAMESPACE = "9a4f2b31-6c7e-4d18-b0a5-27fe6c9d8e40";

/** Creates the canonical UUID v7 identifier for a newly persisted internal entity. */
export function createEntityId(): string {
	return uuidv7();
}

/** Creates a stable RFC 9562 UUID v3 from a canonical application key. */
export function createDeterministicEntityId(canonicalKey: string): string {
	return uuidv3(canonicalKey, DETERMINISTIC_ENTITY_ID_NAMESPACE);
}

/** Returns whether the value is any valid UUID version accepted for an internal entity. */
export function isEntityId(value: string): boolean {
	return validateUuid(value);
}

/** Returns whether the value follows the UUID v7 policy used for newly created entities. */
export function isUuidV7EntityId(value: string): boolean {
	return validateUuid(value) && uuidVersion(value) === 7;
}
