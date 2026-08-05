import { z } from "zod";

/**
 * The ARI resource objects this adapter reads, as Zod schemas.
 *
 * ## What is validated, and what is not
 *
 * Only the fields the engine reads are pinned. Every schema is a `z.object` (unknown keys are
 * stripped, never rejected) because Asterisk adds fields across point releases and an adapter that
 * refuses an unrecognised key would break on a patch upgrade of the media server.
 *
 * The `id`/`name` fields ARE required, and that is the whole point of validating at all: a
 * `Channel` without an `id` is not a channel, and accepting one would surface three call stacks
 * later as `undefined` where a channel id belongs. Fail at the adapter edge, where the raw JSON is
 * still in hand to log.
 *
 * Reference: Asterisk 22 ARI `resources.json` (`/ari/api-docs`), models section.
 */

/**
 * Asterisk's channel state string.
 *
 * Modelled as a shape-checked string rather than an enum: `Down`, `Rsrvd`, `OffHook`, `Dialing`,
 * `Ring`, `Ringing`, `Up`, `Busy`, `Dialing Offhook`, `Pre-ring` and `Unknown` are the documented
 * values, but the mapping to the domain is the engine's job (see {@link ARI_CHANNEL_STATES}) and
 * an unrecognised state must reach it rather than being terminated here.
 */
export const ariChannelStateSchema = z.string().min(1);

/**
 * The channel states Asterisk 22 documents. Exported for the engine's exhaustive mapping and for
 * assertions; NOT used to validate, for the reason above.
 */
export const ARI_CHANNEL_STATES = [
	"Down",
	"Rsrvd",
	"OffHook",
	"Dialing",
	"Ring",
	"Ringing",
	"Up",
	"Busy",
	"Dialing Offhook",
	"Pre-ring",
	"Unknown",
] as const;

export type AriChannelState = (typeof ARI_CHANNEL_STATES)[number];

const ARI_CHANNEL_STATE_SET = new Set<string>(ARI_CHANNEL_STATES);

/** Whether a state string is one Asterisk 22 documents. */
export function isAriChannelState(value: string): value is AriChannelState {
	return ARI_CHANNEL_STATE_SET.has(value);
}

/** `CallerID` — both `name` and `number` are always present in ARI, often as empty strings. */
export const ariCallerIdSchema = z.object({
	name: z.string().default(""),
	number: z.string().default(""),
});

export type AriCallerId = z.infer<typeof ariCallerIdSchema>;

/** `DialplanCEP` — where in the dialplan the channel is. */
export const ariDialplanCepSchema = z.object({
	context: z.string().default(""),
	exten: z.string().default(""),
	priority: z.number().default(0),
	app_name: z.string().optional(),
	app_data: z.string().optional(),
});

export type AriDialplanCep = z.infer<typeof ariDialplanCepSchema>;

/**
 * `Channel`.
 *
 * `channelvars` only appears when `pjsip.conf`/`ari.conf` is configured to export variables with
 * every event; the engine must never depend on it being there, hence optional.
 */
export const ariChannelSchema = z.object({
	id: z.string().min(1),
	name: z.string().default(""),
	state: ariChannelStateSchema,
	protocol_id: z.string().optional(),
	caller: ariCallerIdSchema.optional(),
	connected: ariCallerIdSchema.optional(),
	accountcode: z.string().optional(),
	dialplan: ariDialplanCepSchema.optional(),
	creationtime: z.string().optional(),
	language: z.string().optional(),
	channelvars: z.record(z.string(), z.string()).optional(),
});

export type AriChannel = z.infer<typeof ariChannelSchema>;

/** `Bridge`. `channels` is the list of channel ids currently in it. */
export const ariBridgeSchema = z.object({
	id: z.string().min(1),
	technology: z.string().default(""),
	bridge_type: z.string().default(""),
	bridge_class: z.string().default(""),
	creator: z.string().default(""),
	name: z.string().default(""),
	channels: z.array(z.string()).default([]),
	video_mode: z.string().optional(),
	video_source_id: z.string().optional(),
	creationtime: z.string().optional(),
});

export type AriBridge = z.infer<typeof ariBridgeSchema>;

/** `Playback`. `state` is one of `queued`, `playing`, `continuing`, `done`, `failed`. */
export const ariPlaybackSchema = z.object({
	id: z.string().min(1),
	media_uri: z.string().default(""),
	next_media_uri: z.string().optional(),
	target_uri: z.string().default(""),
	language: z.string().optional(),
	state: z.string().default(""),
});

export type AriPlayback = z.infer<typeof ariPlaybackSchema>;

/**
 * `LiveRecording`. The recording is addressed by `name`, not by an id — that is an ARI quirk the
 * engine should not have to know, so the resource methods take a `name` parameter explicitly.
 */
export const ariLiveRecordingSchema = z.object({
	name: z.string().min(1),
	format: z.string().default(""),
	target_uri: z.string().default(""),
	state: z.string().default(""),
	duration: z.number().optional(),
	talking_duration: z.number().optional(),
	silence_duration: z.number().optional(),
	cause: z.string().optional(),
});

export type AriLiveRecording = z.infer<typeof ariLiveRecordingSchema>;

/** `StoredRecording` — a finished recording on disk. */
export const ariStoredRecordingSchema = z.object({
	name: z.string().min(1),
	format: z.string().default(""),
});

export type AriStoredRecording = z.infer<typeof ariStoredRecordingSchema>;

/** `Endpoint` — a peer as the channel driver sees it. `state` is `online`/`offline`/`unknown`. */
export const ariEndpointSchema = z.object({
	technology: z.string().min(1),
	resource: z.string().min(1),
	state: z.string().optional(),
	channel_ids: z.array(z.string()).default([]),
});

export type AriEndpoint = z.infer<typeof ariEndpointSchema>;

/** `DeviceState` — `NOT_INUSE`, `INUSE`, `BUSY`, `RINGING`, `UNAVAILABLE`, … */
export const ariDeviceStateSchema = z.object({
	name: z.string().min(1),
	state: z.string().min(1),
});

export type AriDeviceState = z.infer<typeof ariDeviceStateSchema>;

/** `Application` — a registered Stasis application and everything it is subscribed to. */
export const ariApplicationSchema = z.object({
	name: z.string().min(1),
	channel_ids: z.array(z.string()).default([]),
	bridge_ids: z.array(z.string()).default([]),
	endpoint_ids: z.array(z.string()).default([]),
	device_names: z.array(z.string()).default([]),
	events_allowed: z.array(z.record(z.string(), z.unknown())).optional(),
	events_disallowed: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type AriApplication = z.infer<typeof ariApplicationSchema>;

/** `Variable` — the single-field envelope `GET /channels/{id}/variable` answers with. */
export const ariVariableSchema = z.object({
	value: z.string().default(""),
});

export type AriVariable = z.infer<typeof ariVariableSchema>;

/** `AsteriskInfo`, trimmed to the build/system facts a health probe reports. */
export const ariAsteriskInfoSchema = z.object({
	system: z
		.object({
			version: z.string().optional(),
			entity_id: z.string().optional(),
		})
		.optional(),
	status: z
		.object({
			startup_time: z.string().optional(),
			last_reload_time: z.string().optional(),
		})
		.optional(),
});

export type AriAsteriskInfo = z.infer<typeof ariAsteriskInfoSchema>;
