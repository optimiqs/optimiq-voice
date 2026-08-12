import { AriHttpError } from "@optimiq-voice/media-ari";
import { ariReasonCodeFor } from "../calls/ari-mapping";
import type {
	BridgeHandle,
	CreateBridgeRequest,
	MediaDirection,
	MediaPort,
	OriginateRequest,
	OriginatedChannel,
	PlaybackHandle,
	PlayRequest,
	RecordRequest,
	RecordingHandle,
	SendDtmfRequest,
	SnoopRequest,
} from "./media-port";
import type { AriClient } from "@optimiq-voice/media-ari";
import type { BridgeMode, HangupCause } from "@optimiq-voice/telephony";

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
	/**
	 * Asterisk's `mixing` bridge decodes the audio, which is what makes recording, `snoop` and
	 * `dtmf_events` possible on it. See {@link MediaPort.bridgeMode}.
	 */
	readonly bridgeMode = "media" satisfies BridgeMode;

	constructor(
		private readonly client: AriClient,
		/** The Stasis application name; `watchChannel` subscribes on its behalf. */
		private readonly applicationName: string,
	) {}

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

	async watchChannel(channelId: string): Promise<void> {
		await this.client.applications.subscribe(this.applicationName, [`channel:${channelId}`]);
	}

	// --- P3 ------------------------------------------------------------------------------------

	async originate(request: OriginateRequest): Promise<OriginatedChannel> {
		const channel = await this.client.channels.originate({
			endpoint: request.endpoint,
			app: request.application,
			appArgs: request.applicationArgs,
			channelId: request.channelId,
			callerId: request.callerId,
			timeoutSeconds: request.timeoutSeconds,
			originator: request.originatorChannelId,
			variables: request.variables,
		});
		return { channelId: channel.id, name: channel.name };
	}

	async createBridge(request: CreateBridgeRequest): Promise<BridgeHandle> {
		// `dtmf_events` alongside `mixing`: the walker's own DTMF handling (an IVR that a bridged
		// party can still drive, the attended-transfer key) needs the digits to arrive as ARI
		// events rather than only as inband audio the far end hears.
		const bridge = await this.client.bridges.create({
			types: ["mixing", "dtmf_events"],
			bridgeId: request.bridgeId,
			name: request.name,
		});
		return { bridgeId: bridge.id };
	}

	async addToBridge(bridgeId: string, channelIds: readonly string[]): Promise<void> {
		await this.client.bridges.addChannels(bridgeId, channelIds);
	}

	async removeFromBridge(bridgeId: string, channelIds: readonly string[]): Promise<void> {
		await this.client.bridges.removeChannels(bridgeId, channelIds);
	}

	async destroyBridge(bridgeId: string): Promise<void> {
		await this.client.bridges.destroy(bridgeId);
	}

	async record(channelId: string, request: RecordRequest): Promise<RecordingHandle> {
		const recording = await this.client.channels.record(channelId, {
			name: request.name,
			format: request.format,
			maxDurationSeconds: request.maxDurationSeconds,
			maxSilenceSeconds: request.maxSilenceSeconds,
			beep: request.beep,
			terminateOn: request.terminateOn,
			// A voicemail re-recorded into the same name is the caller pressing `*` to start over;
			// refusing it would fail the call over a file that is about to be replaced anyway.
			ifExists: "overwrite",
		});
		return { name: recording.name, format: recording.format };
	}

	async stopRecording(name: string): Promise<void> {
		await this.client.recordings.stop(name);
	}

	async startMusicOnHold(channelId: string, mohClass?: string): Promise<void> {
		await this.client.channels.startMoh(channelId, mohClass);
	}

	async stopMusicOnHold(channelId: string): Promise<void> {
		await this.client.channels.stopMoh(channelId);
	}

	// --- P4 ------------------------------------------------------------------------------------

	async hold(channelId: string): Promise<void> {
		await this.client.channels.hold(channelId);
	}

	async unhold(channelId: string): Promise<void> {
		await this.client.channels.unhold(channelId);
	}

	async mute(channelId: string, direction: MediaDirection): Promise<void> {
		await this.client.channels.mute(channelId, direction);
	}

	async unmute(channelId: string, direction: MediaDirection): Promise<void> {
		await this.client.channels.unmute(channelId, direction);
	}

	async sendDtmf(channelId: string, request: SendDtmfRequest): Promise<void> {
		await this.client.channels.sendDtmf(channelId, {
			digits: request.digits,
			durationMs: request.toneDurationMs,
			betweenMs: request.gapMs,
		});
	}

	async snoop(request: SnoopRequest): Promise<OriginatedChannel> {
		const channel = await this.client.channels.snoop(request.channelId, {
			snoopId: request.snoopChannelId,
			app: request.application,
			spy: request.spy,
			// ARI's `whisper` defaults to `none`, and passing `undefined` means the same thing; it is
			// spelled out so the recording path can never accidentally inject audio into a live call.
			whisper: request.whisper ?? "none",
		});
		return { channelId: channel.id, name: channel.name };
	}

	/**
	 * `*43` — hand the leg to `Echo()` in the dialplan.
	 *
	 * ARI has no "execute this application" verb, by design: the REST interface exposes the media
	 * primitives and leaves the application layer to the client. The one door back into Asterisk's
	 * own applications is `POST /channels/{id}/continue`, so the echo test is a dialplan extension
	 * ({@link ECHO_CONTEXT}, in `apps/asterisk/config/extensions.conf`) that the channel is sent to.
	 *
	 * The channel leaves Stasis when it goes, which is why {@link MediaPort.echo} says so in its own
	 * contract rather than leaving the caller to discover it: nothing the walker does afterwards
	 * would reach this leg. `watchChannel` was called when the leg was accepted, so `ChannelDestroyed`
	 * still arrives and the CDR is still written.
	 *
	 * A deployment whose dialplan does not carry the context gets a `404`/`409` from ARI, which
	 * propagates as the failure it is — the walker announces "not available" rather than dropping the
	 * caller into silence in a context that does not exist.
	 */
	async echo(channelId: string): Promise<void> {
		await this.client.channels.continueInDialplan(channelId, {
			context: ECHO_CONTEXT,
			extension: ECHO_EXTENSION,
			priority: 1,
		});
	}
}

/**
 * The dialplan the echo test is handed to.
 *
 * Constants rather than settings: this is not a deployment choice, it is the contract between the
 * engine's ARI driver and `apps/asterisk/config/extensions.conf`, which ship together. A knob here
 * would only let the two disagree.
 */
const ECHO_CONTEXT = "optimiq-echo";
const ECHO_EXTENSION = "s";
