import { ariPlaybackSchema } from "../models";
import type { AriHttpClient } from "../http-client";
import type { AriPlayback } from "../models";

/** In-flight playback controls (`pause`/`unpause`/`reverse`/`forward`/`restart`). */
export const ARI_PLAYBACK_OPERATIONS = [
	"restart",
	"pause",
	"unpause",
	"reverse",
	"forward",
] as const;

export type AriPlaybackOperation = (typeof ARI_PLAYBACK_OPERATIONS)[number];

/**
 * `/ari/playbacks` — controlling audio already in flight.
 *
 * The playback id is client-assigned at `channels.play` time, so the engine never has to hold a
 * server-generated handle across a restart to be able to stop a prompt.
 */
export class AriPlaybacks {
	constructor(private readonly http: AriHttpClient) {}

	/** `GET /playbacks/{id}` — `undefined` once the playback has finished. */
	async get(playbackId: string): Promise<AriPlayback | undefined> {
		return await this.http.requestParsedOptional(
			{ method: "GET", path: `/playbacks/${encodeURIComponent(playbackId)}` },
			ariPlaybackSchema,
		);
	}

	/**
	 * `DELETE /playbacks/{id}` — stop the playback.
	 *
	 * A `404` is tolerated: barge-in means the engine and the media server frequently decide to
	 * end the same prompt within a few milliseconds of each other.
	 */
	async stop(playbackId: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/playbacks/${encodeURIComponent(playbackId)}`,
			tolerateNotFound: true,
		});
	}

	/** `POST /playbacks/{id}/control` — pause, resume, restart or seek. */
	async control(playbackId: string, operation: AriPlaybackOperation): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/playbacks/${encodeURIComponent(playbackId)}/control`,
			query: { operation },
			tolerateNotFound: true,
		});
	}
}
