/**
 * The object-store seam.
 *
 * `src/storage` rather than a slice of either area, for the reason `src/media` exists: the CDR area
 * and the PBX area both store objects, and putting the seam in either one would make the other
 * import an area it has no other business with. Read `object-store.ts` first — it carries the
 * interface AND the Asterisk constraint that shapes every implementation behind it.
 */

export { resolveObjectPath } from "./object-path";
export {
	isArchivingObjectStore,
	ObjectKeyOutsideRootError,
	ObjectNotFoundError,
} from "./object-store";
export type {
	ArchivingObjectStore,
	ObjectRange,
	ObjectStat,
	ObjectStore,
	ObjectStoreDriver,
	PutObjectOptions,
} from "./object-store";
export { createObjectStore, describeObjectStore } from "./object-store.factory";
export { LocalObjectStore } from "./local-object-store";
export { MirroredObjectStore } from "./mirrored-object-store";
export { S3ObjectStore } from "./s3-object-store";
export {
	assertStoragePreflight,
	isS3Configured,
	loadStorageEnv,
	STORAGE_DRIVERS,
	StorageConfigurationFailure,
	storageEnvSchema,
} from "./storage-env";
export type { StorageDriver, StorageEnv } from "./storage-env";
