import {
	audioStream,
	destinationAlias,
	dialByNameDirectory,
	speedDial,
} from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * The named routing building blocks: four tables under one permission family.
 *
 * The collapse is argued in `packages/auth/src/permissions.ts` beside `dial-plan.read` — none of
 * the four has a power profile of its own, and four trios would be twelve permissions expressing one
 * decision. Four RESOURCES rather than one, because the CRUD layer is per table and the shapes
 * differ; only the grants are shared.
 */

/**
 * FusionPBX's "Bridge", with the raw dial string removed.
 *
 * `destinationType: "alias"` — an alias may be pointed at from anywhere a destination is, and the
 * compiler expands it FLAT. That means deleting one still has to be a 409 rather than a silent
 * dangling reference: the artifact would not compile, so the delete would take the tenant's whole
 * routing down at the next write rather than at this one.
 */
export const DESTINATION_ALIAS_RESOURCE: PbxResource = {
	kind: "destination-alias",
	tableName: "destination_alias",
	table: destinationAlias,
	searchColumns: [destinationAlias.name, destinationAlias.description],
	orderBy: [destinationAlias.name, destinationAlias.id],
	enabledColumn: destinationAlias.enabled,
	destinations: [{ prefix: "", required: true }],
	destinationType: "alias",
};

/**
 * A remote audio source usable as a destination.
 *
 * The fallback trio is `required: true`, which is unusual for a secondary trio and is the point:
 * remote-URL playback is the one capability here whose availability depends on the media driver, so
 * a stream with nowhere to go is a call dropped in silence on any driver that cannot play it.
 */
export const AUDIO_STREAM_RESOURCE: PbxResource = {
	kind: "audio-stream",
	tableName: "audio_stream",
	table: audioStream,
	searchColumns: [audioStream.name, audioStream.url],
	orderBy: [audioStream.name, audioStream.id],
	enabledColumn: audioStream.enabled,
	destinations: [{ prefix: "fallback", required: true }],
	destinationType: "stream",
};

/** The dial-by-name directory. Its entries are DERIVED from the extensions, so there is no child. */
export const DIAL_BY_NAME_DIRECTORY_RESOURCE: PbxResource = {
	kind: "dial-by-name-directory",
	tableName: "dial_by_name_directory",
	table: dialByNameDirectory,
	searchColumns: [dialByNameDirectory.name, dialByNameDirectory.extensionNumber],
	orderBy: [dialByNameDirectory.name, dialByNameDirectory.id],
	enabledColumn: dialByNameDirectory.enabled,
	destinations: [{ prefix: "timeout", required: false }],
	destinationType: "dial-by-name",
};

/**
 * An organization-wide short code.
 *
 * `destinationType: null` — nothing points AT a speed dial; a speed dial points at other things.
 * The trio is required, because the target is the whole of what a speed dial is, and it is a trio
 * rather than a number for the reason `destination_alias` refuses a dial string: a bare number would
 * have to be dialled by something, with no route matched.
 */
export const SPEED_DIAL_RESOURCE: PbxResource = {
	kind: "speed-dial",
	tableName: "speed_dial",
	table: speedDial,
	searchColumns: [speedDial.code, speedDial.label],
	orderBy: [speedDial.code, speedDial.id],
	enabledColumn: speedDial.enabled,
	destinations: [{ prefix: "", required: true }],
	destinationType: null,
};
