import {
	ariChannelSchema,
	ariLiveRecordingSchema,
	ariPlaybackSchema,
	ariVariableSchema,
} from "../models";
import type { AriHttpClient } from "../http-client";
import type { AriChannel, AriLiveRecording, AriPlayback } from "../models";

/**
 * `/ari/channels` — everything the engine does to one leg.
 *
 * Every method takes the ARI channel id as its first argument (the oikos "scope first" rule
 * applied to the protocol) and every option object mirrors ARI's own parameter names except where
 * ARI's are actively misleading — `maxDurationSeconds` stays seconds because that is the unit
 * Asterisk means, and the engine converts from its milliseconds at the call site, where the
 * conversion is visible.
 */

/** How a hangup is expressed. Exactly one of `reason` / `causeCode` may be supplied. */
export interface HangupOptions {
	/** ARI's symbolic reason: `normal`, `busy`, `congestion`, `no_answer`, `timeout`, `rejected`. */
	readonly reason?: string;
	/** Q.850 numeric cause. Preferred — it round-trips the full taxonomy, the symbols do not. */
	readonly causeCode?: number;
}

export interface PlayOptions {
	/** One or more media URIs, played back to back. `sound:`, `recording:`, `number:`, `digits:`. */
	readonly media: readonly string[];
	readonly lang?: string;
	readonly offsetMs?: number;
	readonly skipMs?: number;
	/** Client-assigned playback id, so the engine can stop exactly this playback later. */
	readonly playbackId?: string;
}

export interface RecordOptions {
	/** The recording's name; it is also how it is addressed afterwards (see `recordings.ts`). */
	readonly name: string;
	readonly format: string;
	readonly maxDurationSeconds?: number;
	readonly maxSilenceSeconds?: number;
	/** `fail` (default), `overwrite` or `append`. */
	readonly ifExists?: "fail" | "overwrite" | "append";
	readonly beep?: boolean;
	/** DTMF digits that stop the recording, or `none`. */
	readonly terminateOn?: string;
}

export interface OriginateOptions {
	/** Channel technology + resource, e.g. `PJSIP/1001` or `Local/1001@internal`. */
	readonly endpoint: string;
	/** Hand the new channel straight to a Stasis application… */
	readonly app?: string;
	readonly appArgs?: string;
	/** …or to the dialplan. Supply either `app` or the `extension`/`context` trio, never both. */
	readonly extension?: string;
	readonly context?: string;
	readonly priority?: number;
	readonly callerId?: string;
	/** Ring time in seconds. `-1` means no limit; ARI's default is 30. */
	readonly timeoutSeconds?: number;
	/** Client-assigned id, so the caller knows the channel id before the channel exists. */
	readonly channelId?: string;
	readonly otherChannelId?: string;
	/** The channel this one is being originated for; ARI copies its accountcode and linkedid. */
	readonly originator?: string;
	readonly formats?: string;
	/** Channel variables set before the channel is dialled. This is the export seam. */
	readonly variables?: Readonly<Record<string, string>>;
}

export interface DtmfOptions {
	readonly digits: string;
	/** Silence before the first digit, ms. */
	readonly beforeMs?: number;
	/** Silence between digits, ms. */
	readonly betweenMs?: number;
	/** Tone length, ms. */
	readonly durationMs?: number;
	/** Silence after the last digit, ms. */
	readonly afterMs?: number;
}

/** Which direction of the media path a mute applies to. */
export type AriMuteDirection = "in" | "out" | "both";

export interface SnoopOptions {
	/** Which direction to listen to: `none`, `both`, `out`, `in`. */
	readonly spy?: AriMuteDirection | "none";
	/** Which direction to inject audio into. */
	readonly whisper?: AriMuteDirection | "none";
	/** The Stasis application the snoop channel is handed to. */
	readonly app: string;
	readonly appArgs?: string;
	readonly snoopId?: string;
}

export class AriChannels {
	constructor(private readonly http: AriHttpClient) {}

	/** `GET /channels/{id}` — `undefined` when the channel is already gone. */
	async get(channelId: string): Promise<AriChannel | undefined> {
		return await this.http.requestParsedOptional(
			{ method: "GET", path: `/channels/${encodeURIComponent(channelId)}` },
			ariChannelSchema,
		);
	}

	/** `GET /channels` — every channel Asterisk currently has. */
	async list(): Promise<readonly AriChannel[]> {
		return await this.http.requestParsed(
			{ method: "GET", path: "/channels" },
			ariChannelSchema.array(),
		);
	}

	/** `POST /channels/{id}/answer` — SIP 200 OK. Starts billing. */
	async answer(channelId: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/answer`,
		});
	}

	/** `POST /channels/{id}/ring` — SIP 180, alerting without media. */
	async ring(channelId: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/ring`,
		});
	}

	/** `DELETE /channels/{id}/ring` — stop alerting without answering. */
	async ringStop(channelId: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/channels/${encodeURIComponent(channelId)}/ring`,
		});
	}

	/**
	 * `DELETE /channels/{id}` — tear the leg down.
	 *
	 * A `404` is tolerated: by the time the engine decides to hang a channel up, the far end may
	 * already have done it, and that race is the normal case rather than a failure.
	 */
	async hangup(channelId: string, options: HangupOptions = {}): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/channels/${encodeURIComponent(channelId)}`,
			query: { reason: options.reason, reason_code: options.causeCode },
			tolerateNotFound: true,
		});
	}

	/** `POST /channels/{id}/continue` — hand the channel back to the dialplan. */
	async continueInDialplan(
		channelId: string,
		options: {
			readonly context?: string;
			readonly extension?: string;
			readonly priority?: number;
		} = {},
	): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/continue`,
			query: {
				context: options.context,
				extension: options.extension,
				priority: options.priority,
			},
		});
	}

	/** `POST /channels/{id}/play` — start a playback and return its handle. */
	async play(channelId: string, options: PlayOptions): Promise<AriPlayback> {
		return await this.http.requestParsed(
			{
				method: "POST",
				path: `/channels/${encodeURIComponent(channelId)}/play`,
				query: {
					media: options.media,
					lang: options.lang,
					offsetms: options.offsetMs,
					skipms: options.skipMs,
					playbackId: options.playbackId,
				},
			},
			ariPlaybackSchema,
		);
	}

	/** `POST /channels/{id}/record` — start recording this leg. */
	async record(channelId: string, options: RecordOptions): Promise<AriLiveRecording> {
		return await this.http.requestParsed(
			{
				method: "POST",
				path: `/channels/${encodeURIComponent(channelId)}/record`,
				query: {
					name: options.name,
					format: options.format,
					maxDurationSeconds: options.maxDurationSeconds,
					maxSilenceSeconds: options.maxSilenceSeconds,
					ifExists: options.ifExists,
					beep: options.beep,
					terminateOn: options.terminateOn,
				},
			},
			ariLiveRecordingSchema,
		);
	}

	/**
	 * `GET /channels/{id}/variable` — read a channel variable.
	 *
	 * Returns `undefined` when the variable is unset. ARI answers an unset variable with `404`,
	 * which is a status, not a failure: "this call has no org id yet" is a routing fact.
	 */
	async getVariable(channelId: string, variable: string): Promise<string | undefined> {
		const result = await this.http.requestParsedOptional(
			{
				method: "GET",
				path: `/channels/${encodeURIComponent(channelId)}/variable`,
				query: { variable },
			},
			ariVariableSchema,
		);
		return result?.value;
	}

	/** `POST /channels/{id}/variable` — set a channel variable. */
	async setVariable(channelId: string, variable: string, value: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/variable`,
			query: { variable, value },
		});
	}

	/** `POST /channels` — originate a new leg. */
	async originate(options: OriginateOptions): Promise<AriChannel> {
		return await this.http.requestParsed(
			{
				method: "POST",
				path: "/channels",
				query: {
					endpoint: options.endpoint,
					app: options.app,
					appArgs: options.appArgs,
					extension: options.extension,
					context: options.context,
					priority: options.priority,
					callerId: options.callerId,
					timeout: options.timeoutSeconds,
					channelId: options.channelId,
					otherChannelId: options.otherChannelId,
					originator: options.originator,
					formats: options.formats,
				},
				// ARI takes originate variables in the BODY, not the query string; a `variables`
				// query parameter is silently ignored, which is a memorable afternoon.
				body: options.variables === undefined ? undefined : { variables: options.variables },
			},
			ariChannelSchema,
		);
	}

	/**
	 * `POST /channels/{id}/dial` — start dialling a channel created with `POST /channels/create`.
	 * The two-step create-then-dial flow is what makes pre-dial variable setting possible.
	 */
	async dial(
		channelId: string,
		options: { readonly caller?: string; readonly timeoutSeconds?: number } = {},
	): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/dial`,
			query: { caller: options.caller, timeout: options.timeoutSeconds },
		});
	}

	/** `POST /channels/{id}/redirect` — move the leg to another endpoint (SIP 3xx / deflect). */
	async redirect(channelId: string, endpoint: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/redirect`,
			query: { endpoint },
		});
	}

	/** `POST /channels/{id}/dtmf` — generate digits towards the far end. */
	async sendDtmf(channelId: string, options: DtmfOptions): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/dtmf`,
			query: {
				dtmf: options.digits,
				before: options.beforeMs,
				between: options.betweenMs,
				duration: options.durationMs,
				after: options.afterMs,
			},
		});
	}

	/** `POST /channels/{id}/mute`. */
	async mute(channelId: string, direction: AriMuteDirection = "both"): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/mute`,
			query: { direction },
		});
	}

	/** `DELETE /channels/{id}/mute`. */
	async unmute(channelId: string, direction: AriMuteDirection = "both"): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/channels/${encodeURIComponent(channelId)}/mute`,
			query: { direction },
		});
	}

	/** `POST /channels/{id}/hold` — put the leg on hold. MOH is a separate call, by design. */
	async hold(channelId: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/hold`,
		});
	}

	/** `DELETE /channels/{id}/hold`. */
	async unhold(channelId: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/channels/${encodeURIComponent(channelId)}/hold`,
		});
	}

	/**
	 * `POST /channels/{id}/moh` — start music on hold from a configured class.
	 *
	 * Separate from {@link hold} because they are separate concerns: hold is a signalling state the
	 * far end sees, MOH is audio. A leg can have either without the other.
	 */
	async startMoh(channelId: string, mohClass?: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/channels/${encodeURIComponent(channelId)}/moh`,
			query: { mohClass },
		});
	}

	/** `DELETE /channels/{id}/moh`. */
	async stopMoh(channelId: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/channels/${encodeURIComponent(channelId)}/moh`,
		});
	}

	/**
	 * `POST /channels/{id}/snoop` — create a channel that taps this one. The tap primitive behind
	 * recording, eavesdrop, whisper and barge.
	 */
	async snoop(channelId: string, options: SnoopOptions): Promise<AriChannel> {
		return await this.http.requestParsed(
			{
				method: "POST",
				path: `/channels/${encodeURIComponent(channelId)}/snoop`,
				query: {
					spy: options.spy,
					whisper: options.whisper,
					app: options.app,
					appArgs: options.appArgs,
					snoopId: options.snoopId,
				},
			},
			ariChannelSchema,
		);
	}
}
