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
import type { HangupCause } from "@optimiq-voice/telephony";

/**
 * A complete {@link MediaPort} that records what it was asked to do.
 *
 * Test scaffolding, not product code: excluded from `tsconfig.build.json` by the `*.fake.ts`
 * pattern, exactly as `packages/routing`'s `fixtures.ts` is excluded from its build.
 *
 * It exists because the port is the engine's whole media surface, so every spec that touches the
 * orchestrator or the plan walker needs ALL of it. Fifteen inline object literals would mean
 * fifteen places to edit when the port grows a method, and fourteen of them would be edited by
 * whoever hits the compile error rather than by whoever added the method.
 *
 * Every call is appended to {@link FakeMediaPort.calls} in order, which is the assertion most specs
 * actually want: not "was `originate` called" but "was it called BEFORE the bridge".
 */

export interface MediaCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

export interface FakeMediaPortOptions {
	/** Seeds `getVariable`. Mutated in place by `setVariable`. */
	readonly variables?: Record<string, string>;
	/** Lets a spec make one endpoint unreachable, which is how "not registered" is exercised. */
	readonly originateFails?: (request: OriginateRequest) => Error | undefined;
	/**
	 * Called after a successful originate, so a spec can answer (or kill) the new leg.
	 *
	 * Synchronous on purpose: the walker subscribes to the leg's signals BEFORE it originates, so
	 * emitting from here reproduces the real race in which `StasisStart` beats the HTTP response.
	 */
	readonly onOriginate?: (request: OriginateRequest) => void;
	/**
	 * Called after a successful `record`, so a spec can finish or fail the recording.
	 *
	 * Synchronous for the same reason as {@link onOriginate}: the walker subscribes before it
	 * records, because a zero-length recording can finish before the HTTP response arrives.
	 */
	readonly onRecord?: (channelId: string, request: RecordRequest) => void;
	/**
	 * Called after a successful `snoop`, so a spec can deliver the tap's `StasisStart`.
	 *
	 * Synchronous for the same reason as {@link onOriginate}: a tap on a local channel reaches the
	 * application before the HTTP response does, and the recording runtime subscribes first.
	 */
	readonly onSnoop?: (request: SnoopRequest) => void;
	readonly snoopFails?: boolean;
	/**
	 * Called after `answer`, so a spec can deliver the `Up` state change a real media server sends.
	 *
	 * `answer` is a REQUEST: the leg only gains a media path when the far end's `200 OK` has been
	 * exchanged, which arrives later as an event. A fake that answered synchronously would hide the
	 * exact race the engine exists to handle.
	 */
	readonly onAnswer?: (channelId: string) => void;
	readonly bridgeFails?: boolean;
	readonly recordFails?: boolean;
	/** Makes the music class unavailable, which every hold path has to survive. */
	readonly musicOnHoldFails?: boolean;
}

export interface FakeMediaPort extends MediaPort {
	readonly calls: MediaCall[];
	readonly variables: Record<string, string>;
	/** Method names in call order — the shape most assertions read. */
	readonly methods: () => string[];
	readonly originated: () => OriginateRequest[];
	readonly hungUp: () => { channelId: string; cause: HangupCause }[];
}

export function makeFakeMediaPort(options: FakeMediaPortOptions = {}): FakeMediaPort {
	const calls: MediaCall[] = [];
	const variables: Record<string, string> = { ...options.variables };
	const record = (method: string, ...args: unknown[]): void => {
		calls.push({ method, args });
	};

	const port: FakeMediaPort = {
		calls,
		variables,
		methods: () => calls.map((call) => call.method),
		originated: () =>
			calls
				.filter((call) => call.method === "originate")
				.map((call) => call.args[0] as OriginateRequest),
		hungUp: () =>
			calls
				.filter((call) => call.method === "hangup")
				.map((call) => ({
					channelId: call.args[0] as string,
					cause: call.args[1] as HangupCause,
				})),

		answer: async (channelId: string): Promise<void> => {
			record("answer", channelId);
			options.onAnswer?.(channelId);
		},
		ring: async (channelId: string): Promise<void> => {
			record("ring", channelId);
		},
		play: async (channelId: string, request: PlayRequest): Promise<PlaybackHandle> => {
			// The WHOLE request, not just the media list: `playbackRef` is what barge-in stops, and a
			// spec that cannot see it cannot prove the prompt was stopped rather than left playing.
			record("play", channelId, request);
			return { playbackRef: request.playbackRef };
		},
		stopPlayback: async (playbackRef: string): Promise<void> => {
			record("stopPlayback", playbackRef);
		},
		hangup: async (channelId: string, cause: HangupCause): Promise<void> => {
			record("hangup", channelId, cause);
		},
		getVariable: async (_channelId: string, name: string): Promise<string | undefined> =>
			variables[name],
		setVariable: async (_channelId: string, name: string, value: string): Promise<void> => {
			variables[name] = value;
		},
		channelExists: async (): Promise<boolean> => true,
		watchChannel: async (channelId: string): Promise<void> => {
			record("watchChannel", channelId);
		},

		originate: async (request: OriginateRequest): Promise<OriginatedChannel> => {
			record("originate", request);
			const failure = options.originateFails?.(request);
			if (failure !== undefined) {
				throw failure;
			}
			options.onOriginate?.(request);
			return { channelId: request.channelId, name: request.endpoint };
		},
		createBridge: async (request: CreateBridgeRequest): Promise<BridgeHandle> => {
			record("createBridge", request);
			if (options.bridgeFails === true) {
				throw new Error("bridge creation refused");
			}
			return { bridgeId: request.bridgeId };
		},
		addToBridge: async (bridgeId: string, channelIds: readonly string[]): Promise<void> => {
			record("addToBridge", bridgeId, [...channelIds]);
		},
		removeFromBridge: async (bridgeId: string, channelIds: readonly string[]): Promise<void> => {
			record("removeFromBridge", bridgeId, [...channelIds]);
		},
		destroyBridge: async (bridgeId: string): Promise<void> => {
			record("destroyBridge", bridgeId);
		},
		record: async (channelId: string, request: RecordRequest): Promise<RecordingHandle> => {
			record("record", channelId, request);
			if (options.recordFails === true) {
				throw new Error("recording refused");
			}
			options.onRecord?.(channelId, request);
			return { name: request.name, format: request.format };
		},
		stopRecording: async (name: string): Promise<void> => {
			record("stopRecording", name);
		},
		startMusicOnHold: async (channelId: string, mohClass?: string): Promise<void> => {
			record("startMusicOnHold", channelId, mohClass);
			if (options.musicOnHoldFails === true) {
				throw new Error("no such music class");
			}
		},
		stopMusicOnHold: async (channelId: string): Promise<void> => {
			record("stopMusicOnHold", channelId);
		},

		hold: async (channelId: string): Promise<void> => {
			record("hold", channelId);
		},
		unhold: async (channelId: string): Promise<void> => {
			record("unhold", channelId);
		},
		mute: async (channelId: string, direction: MediaDirection): Promise<void> => {
			record("mute", channelId, direction);
		},
		unmute: async (channelId: string, direction: MediaDirection): Promise<void> => {
			record("unmute", channelId, direction);
		},
		sendDtmf: async (channelId: string, request: SendDtmfRequest): Promise<void> => {
			record("sendDtmf", channelId, request);
		},
		snoop: async (request: SnoopRequest): Promise<OriginatedChannel> => {
			record("snoop", request);
			if (options.snoopFails === true) {
				throw new Error("snoop refused");
			}
			options.onSnoop?.(request);
			return { channelId: request.snoopChannelId, name: `Snoop/${request.channelId}` };
		},
	};

	return port;
}
