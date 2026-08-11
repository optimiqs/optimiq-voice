import { LocalObjectStore } from "./local-object-store";
import { MirroredObjectStore } from "./mirrored-object-store";
import { S3ObjectStore } from "./s3-object-store";
import type { ObjectStore } from "./object-store";
import type { StorageEnv } from "./storage-env";

/**
 * Driver selection, in one function, for all three object classes this API owns.
 *
 * ```text
 * STORAGE_DRIVER=local (default) -> LocalObjectStore(root)
 * STORAGE_DRIVER=s3              -> MirroredObjectStore(LocalObjectStore(root), S3ObjectStore(env))
 * ```
 *
 * There is no third branch and, in particular, **no branch that returns a bare `S3ObjectStore`**.
 * That is the Asterisk constraint expressed as the absence of a code path rather than as a warning
 * somebody has to read: `object-store.ts` sets out why every object class here is either written or
 * read by Asterisk over a shared mount, and a bare bucket store would be selectable, would pass
 * every test, and would produce prompts that play as silence on a call. When `apps/mediad` removes
 * the mount, the branch appears here and nothing else changes.
 *
 * ## The object-class map, which is the thing to read before changing any of this
 *
 * | class                       | root                       | who writes    | who reads            | S3 role                          |
 * | --------------------------- | -------------------------- | ------------- | -------------------- | -------------------------------- |
 * | media library (MOH/prompts) | `PBX_MEDIA_OBJECT_ROOT`    | this API      | **Asterisk** + API   | mirror on upload                 |
 * | voicemail greetings         | `PBX_MEDIA_OBJECT_ROOT`    | this API      | **Asterisk** + API   | mirror on upload                 |
 * | voicemail message audio     | `PBX_VOICEMAIL_MEDIA_ROOT` | **Asterisk**  | **Asterisk** + API   | archive when the row is filed    |
 * | call recordings             | `CDR_RECORDING_ROOT`       | **Asterisk**  | API only             | archive when the row is finalized|
 *
 * All four default to the same directory in every shipped configuration, which is intentional and
 * documented in `pbx-env.ts`: **there is one object store**, the media server mounts it once as
 * `ENGINE_MEDIA_OBJECT_ROOT`, and a deployment that configured a second root would produce a library
 * whose files exist, whose rows are correct, and whose audio the media server cannot find. Three
 * stores are built rather than one because the three ROOTS are separately nameable and a deployment
 * with the PBX area and no CDR area has to work.
 *
 * ## The signed-URL decision, recorded here because this is where it would be reversed
 *
 * The brief allowed either: presign S3 `GET`s and redirect, or keep streaming the bytes through the
 * API. **This implementation streams, on every driver, and the presign seam is deliberately not
 * wired to a route.** Four reasons, in the order that decided it:
 *
 * 1. **The token is not an S3 credential and does not map onto one.** `recording-token.ts` and
 *    `voicemail-media-token.ts` carry `{ recording, organization, expiry }` and are verified by
 *    *reading the row inside `withTenantScope(organizationId)`* — the RLS policy, not the signature,
 *    is the last line of defence, and the header of `recordings.service.ts` says so explicitly. A
 *    302 to a presigned URL moves the decision to the moment the link was minted and hands out a
 *    bearer credential the database can no longer revoke by deleting a row. Tombstoning a recording
 *    (`deletedAt`) would stop working, and it is checked on every open today.
 * 2. **The `Range` semantics are already correct and shared.** `src/media/http-range.ts` and
 *    `media-response.ts` decide `200`/`206`/`416` for three routes at once, and `accept-ranges:
 *    bytes` on the FIRST response is what makes a scrub bar draggable at all. Handing that to S3
 *    means two implementations of the behaviour that has already been got wrong once here.
 * 3. **A mirrored store has two possible sources per object** and only one of them can be presigned.
 *    A route that redirected when the mirror had the object and streamed when only the volume did
 *    would be two code paths for one response, differing in status code, observable by the client.
 * 4. **Streaming keeps the audit trail and the headers.** `content-disposition` with a file name a
 *    human can find again, `cache-control: private, no-store`, and one place where a media read is
 *    logged. A redirect gives all three to the bucket.
 *
 * What it costs: the API is in the byte path, so a recording download uses an API connection for its
 * duration. That is the same cost this API pays today with the filesystem driver, it is bounded by
 * the range logic already in place, and it is the trade the token semantics make worth taking. If a
 * bulk export ever needs the other answer, `ObjectStore.presign` is implemented and tested — see
 * `s3-object-store.ts`.
 */
export function createObjectStore(
	env: StorageEnv,
	options: { readonly root: string },
): ObjectStore {
	const local = new LocalObjectStore(options.root);
	if (env.driver !== "s3") {
		return local;
	}
	return new MirroredObjectStore(local, new S3ObjectStore(env));
}

/** A one-line description of a built store, for the boot log. Never includes a credential. */
export function describeObjectStore(store: ObjectStore, env: StorageEnv): string {
	if (store.driver === "local") {
		return "local filesystem";
	}
	return `local filesystem, mirrored to s3://${env.bucket ?? "?"}/${env.prefix}${
		env.endpoint === undefined ? "" : ` at ${env.endpoint}`
	}`;
}
