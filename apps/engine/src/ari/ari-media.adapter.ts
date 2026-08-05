import { AriHttpError } from "@optimiq-voice/media-ari";
import { ariReasonCodeFor } from "../calls/ari-mapping";
import type { MediaPort, PlaybackHandle, PlayRequest } from "./media-port";
import type { AriClient } from "@optimiq-voice/media-ari";
import type { HangupCause } from "@optimiq-voice/telephony";

/**
 * {@link MediaPort} over Asterisk ARI.
 *
 * The only file in the engine that is allowed to know ARI's shape, and it is deliberately dull:
 * translate the domain vocabulary, call the adapter, translate the failure back.
 *
 * ## The 404 policy
 *
 * A `404` from a hangup, a playback stop or a variable read is NOT a failure. By the time the
 * engine acts on a channel the far end may already have hung up, and that race is the normal case
 * on every call that ends while a prompt is playing. `packages/media-ari` already resolves the
 * tolerated ones to `undefined`; this class turns the remaining "does it exist" question into a
 * boolean rather than an exception, so the orchestrator never has to catch to ask.
 */
export class AriMediaAdapter implements MediaPort {
	constructor(private readonly client: AriClient) {}

	async answer(channelId: string): Promise<void> {
		await this.client.channels.answer(channelId);
	}

	async ring(channelId: string): Promise<void> {
		await this.client.channels.ring(channelId);
	}

	async play(channelId: string, request: PlayRequest): Promise<PlaybackHandle> {
		const playback = await this.client.channels.play(channelId, {
			media: request.media,
			playbackId: request.playbackRef,
			lang: request.language,
		});
		return { playbackRef: playback.id };
	}

	async stopPlayback(playbackRef: string): Promise<void> {
		await this.client.playbacks.stop(playbackRef);
	}

	async hangup(channelId: string, cause: HangupCause): Promise<void> {
		await this.client.channels.hangup(channelId, { causeCode: ariReasonCodeFor(cause) });
	}

	async getVariable(channelId: string, name: string): Promise<string | undefined> {
		try {
			return await this.client.channels.getVariable(channelId, name);
		} catch (error) {
			// A variable read on a channel that vanished mid-read is the same answer as a variable
			// that was never set: there is nothing to read.
			if (error instanceof AriHttpError && (error.isNotFound || error.isConflict)) {
				return undefined;
			}
			throw error;
		}
	}

	async setVariable(channelId: string, name: string, value: string): Promise<void> {
		await this.client.channels.setVariable(channelId, name, value);
	}

	async channelExists(channelId: string): Promise<boolean> {
		return (await this.client.channels.get(channelId)) !== undefined;
	}
}
