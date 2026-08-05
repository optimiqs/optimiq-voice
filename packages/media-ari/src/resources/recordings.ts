import { ariLiveRecordingSchema, ariStoredRecordingSchema } from "../models";
import type { AriHttpClient } from "../http-client";
import type { AriLiveRecording, AriStoredRecording } from "../models";

/**
 * `/ari/recordings` — live and stored recordings.
 *
 * A live recording is addressed by its NAME, not by an id, and the name is chosen by the caller at
 * `channels.record` time. That is an ARI quirk rather than a design choice, and it is quarantined
 * here: the engine passes the name it already generated and never has to learn why.
 *
 * `stop` finalises the file; `cancel` discards it. The distinction matters for compliance — a
 * cancelled recording of a PCI-masked segment must leave nothing behind.
 */
export class AriRecordings {
	constructor(private readonly http: AriHttpClient) {}

	/** `GET /recordings/live/{name}` — `undefined` once the recording has finished. */
	async getLive(name: string): Promise<AriLiveRecording | undefined> {
		return await this.http.requestParsedOptional(
			{ method: "GET", path: `/recordings/live/${encodeURIComponent(name)}` },
			ariLiveRecordingSchema,
		);
	}

	/** `POST /recordings/live/{name}/stop` — finalise the file. */
	async stop(name: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/recordings/live/${encodeURIComponent(name)}/stop`,
			tolerateNotFound: true,
		});
	}

	/** `DELETE /recordings/live/{name}` — abandon the recording and discard the file. */
	async cancel(name: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/recordings/live/${encodeURIComponent(name)}`,
			tolerateNotFound: true,
		});
	}

	/** `POST /recordings/live/{name}/pause` — the PCI "mask this segment" primitive. */
	async pause(name: string): Promise<void> {
		await this.http.requestVoid({
			method: "POST",
			path: `/recordings/live/${encodeURIComponent(name)}/pause`,
		});
	}

	/** `DELETE /recordings/live/{name}/pause` — resume after a pause. */
	async unpause(name: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/recordings/live/${encodeURIComponent(name)}/pause`,
		});
	}

	/** `GET /recordings/stored/{name}` — a finished recording on the media server's disk. */
	async getStored(name: string): Promise<AriStoredRecording | undefined> {
		return await this.http.requestParsedOptional(
			{ method: "GET", path: `/recordings/stored/${encodeURIComponent(name)}` },
			ariStoredRecordingSchema,
		);
	}

	/** `DELETE /recordings/stored/{name}` — delete after the object store has the file. */
	async deleteStored(name: string): Promise<void> {
		await this.http.requestVoid({
			method: "DELETE",
			path: `/recordings/stored/${encodeURIComponent(name)}`,
			tolerateNotFound: true,
		});
	}
}
