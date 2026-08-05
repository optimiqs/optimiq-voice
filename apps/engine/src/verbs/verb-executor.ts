import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ModuleEffectRuntime } from "@optimiq-voice/effect-runtime";
import { isTerminalVerb, verbRequiresMediaPath } from "@optimiq-voice/telephony";
import {
	MediaCommandFailure,
	UnsupportedVerbFailure,
	VerbNotPermittedFailure,
} from "./verb-errors";
import type { MediaPort } from "../ari/media-port";
import type { VerbFailure } from "./verb-errors";
import type {
	AcknowledgedResult,
	DtmfCollection,
	PlaybackResult,
	Verb,
	VerbName,
	VerbResult,
} from "@optimiq-voice/telephony";

/**
 * The session-protocol verb executor.
 *
 * ## The shape, and why
 *
 * One `Effect`-returning method per verb, plus a `dispatch` that switches EXHAUSTIVELY over the
 * 28-member union from `@optimiq-voice/telephony`. The `never` check in the default branch is
 * load-bearing: adding a verb to the protocol package becomes a compile error here, which is
 * exactly the reminder the next person needs. A registry of string-keyed handlers would have
 * compiled fine and failed at 3am on a live call.
 *
 * ## Guard, then execute
 *
 * Every verb is validated before any media command is issued (`plans/reference/oikos-conventions`
 * §4). Two invariants, both from the frozen FreeSWITCH reference §1:
 *
 * 1. A leg that is tearing down takes no verbs. There is nothing to talk to.
 * 2. A media verb needs an answered or early-media leg. The engine must NOT implicitly answer to
 *    make a `play` work — an implicit answer starts billing a caller for a call they never got.
 *
 * ## What is implemented
 *
 * `answer`, `ringing`, `play`, `gather` and `hangup` — the P2 inbound slice. The other 23 return
 * {@link UnsupportedVerbFailure}, which is an honest answer an application can act on, rather than
 * a silent no-op. Adding one is a new `case` and a new method; nothing else moves.
 */

/** What the executor needs to know about the leg it is acting on. */
export interface VerbChannelContext {
	/** The media server's channel id. */
	readonly mediaChannelId: string;
	/** The domain leg id, for events and results. */
	readonly channelId: string;
	readonly isTearingDown: boolean;
	/** Whether audio can reach the caller: answered, or early media is open. */
	readonly hasMediaPath: boolean;
}

/** Collects DTMF for a `gather`. Supplied by the orchestrator, which owns the digit queue. */
export type DtmfCollector = (
	context: VerbChannelContext,
	verb: Extract<Verb, { verb: "gather" }>,
) => Promise<DtmfCollection>;

export interface VerbExecutorInterface {
	readonly dispatch: (
		context: VerbChannelContext,
		verb: Verb,
	) => Effect.Effect<VerbResult, VerbFailure>;
}

export class VerbExecutor extends Context.Service<VerbExecutor, VerbExecutorInterface>()(
	"@optimiq-voice/engine/VerbExecutor",
) {}

/** Everything the executor depends on. Both are ports, so a spec supplies two closures. */
export interface VerbExecutorDependencies {
	readonly media: MediaPort;
	readonly collectDtmf: DtmfCollector;
	/** Injected so a spec can assert elapsed times without waiting for them. */
	readonly now?: () => number;
	/** Injected so playback references are deterministic in a spec. */
	readonly newPlaybackRef?: () => string;
}

/**
 * Builds the executor over its ports.
 *
 * Exported separately from the layer so a spec can drive it without a `ManagedRuntime`; the layer
 * below is what the Nest module provides.
 */
export function makeVerbExecutor(deps: VerbExecutorDependencies): VerbExecutorInterface {
	const now = deps.now ?? Date.now;
	const newPlaybackRef = deps.newPlaybackRef ?? (() => `pb-${crypto.randomUUID()}`);

	/** Turns a media-server rejection into a typed failure, never a defect. */
	const mediaCall = <A>(
		verb: VerbName,
		context: VerbChannelContext,
		run: () => Promise<A>,
	): Effect.Effect<A, MediaCommandFailure> =>
		Effect.tryPromise({
			try: run,
			catch: (cause) =>
				new MediaCommandFailure({
					verb,
					channelId: context.channelId,
					detail: cause instanceof Error ? cause.message : String(cause),
				}),
		});

	/**
	 * The guard every verb passes through. Ordered existence → state → capability, per the oikos
	 * guard-then-execute rule.
	 */
	const guard = (
		context: VerbChannelContext,
		verb: VerbName,
	): Effect.Effect<void, VerbNotPermittedFailure> => {
		if (context.isTearingDown) {
			return Effect.fail(
				new VerbNotPermittedFailure({
					verb,
					channelId: context.channelId,
					reason: "the channel is tearing down",
				}),
			);
		}
		// `hangup` is exempt: tearing a leg down is always allowed, and it is the one verb whose
		// whole purpose is to work on a leg in trouble.
		if (verb !== "hangup" && verbRequiresMediaPath(verb) && !context.hasMediaPath) {
			return Effect.fail(
				new VerbNotPermittedFailure({
					verb,
					channelId: context.channelId,
					reason: "the leg has neither answered nor opened early media",
				}),
			);
		}
		return Effect.void;
	};

	const acknowledged = (verb: AcknowledgedResult["verb"]): AcknowledgedResult => ({
		verb,
		endReason: "completed",
	});

	const answer = (context: VerbChannelContext): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.map(
			mediaCall("answer", context, () => deps.media.answer(context.mediaChannelId)),
			() => acknowledged("answer"),
		);

	const ringing = (context: VerbChannelContext): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.map(
			mediaCall("ringing", context, () => deps.media.ring(context.mediaChannelId)),
			() => acknowledged("ringing"),
		);

	const play = (
		context: VerbChannelContext,
		verb: Extract<Verb, { verb: "play" }>,
	): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.gen(function* () {
			const startedAt = now();
			const playbackRef = verb.playbackRef ?? newPlaybackRef();
			const handle = yield* mediaCall("play", context, () =>
				deps.media.play(context.mediaChannelId, {
					media: [verb.media],
					playbackRef,
				}),
			);
			// `play` returns as soon as playback has STARTED. Waiting for `PlaybackFinished` is the
			// orchestrator's business, because only it sees the event stream — and because a caller
			// that barges in must be able to interrupt without this effect holding a fiber.
			const result: PlaybackResult = {
				verb: "play",
				endReason: "completed",
				playbackRef: handle.playbackRef,
				elapsedMs: now() - startedAt,
			};
			return result;
		});

	const gather = (
		context: VerbChannelContext,
		verb: Extract<Verb, { verb: "gather" }>,
	): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.gen(function* () {
			const startedAt = now();
			const playbackRef = verb.media === undefined ? undefined : newPlaybackRef();

			if (verb.media !== undefined && playbackRef !== undefined) {
				yield* mediaCall("gather", context, () =>
					deps.media.play(context.mediaChannelId, { media: [verb.media as string], playbackRef }),
				);
			}

			const collection = yield* mediaCall("gather", context, () => deps.collectDtmf(context, verb));

			// Barge-in: the prompt is stopped the moment collection ends, whatever ended it. Leaving
			// it playing over the caller's next interaction is the single most-reported IVR defect.
			if (playbackRef !== undefined) {
				yield* Effect.orElseSucceed(
					mediaCall("gather", context, () => deps.media.stopPlayback(playbackRef)),
					() => undefined,
				);
			}

			return {
				verb: "gather",
				endReason: endReasonForCollection(collection),
				collection,
				elapsedMs: now() - startedAt,
			};
		});

	const hangup = (
		context: VerbChannelContext,
		verb: Extract<Verb, { verb: "hangup" }>,
	): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.map(
			mediaCall("hangup", context, () =>
				deps.media.hangup(context.mediaChannelId, verb.cause ?? "NORMAL_CLEARING"),
			),
			() => acknowledged("hangup"),
		);

	const unsupported = (
		context: VerbChannelContext,
		verb: VerbName,
	): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.fail(new UnsupportedVerbFailure({ verb, channelId: context.channelId }));

	const dispatch = Effect.fn("VerbExecutor.dispatch")(function* (
		context: VerbChannelContext,
		verb: Verb,
	) {
		yield* guard(context, verb.verb);

		switch (verb.verb) {
			case "answer":
				return yield* answer(context);
			case "ringing":
				return yield* ringing(context);
			case "play":
				return yield* play(context, verb);
			case "gather":
				return yield* gather(context, verb);
			case "hangup":
				return yield* hangup(context, verb);

			// --- not implemented in the P2 slice ---------------------------------------------
			case "earlyMedia":
			case "stopPlay":
			case "playbackControl":
			case "say":
			case "stopSay":
			case "record":
			case "dial":
			case "bridge":
			case "unbridge":
			case "transfer":
			case "hold":
			case "unhold":
			case "park":
			case "unpark":
			case "playDtmf":
			case "mute":
			case "unmute":
			case "stream":
			case "stopStream":
			case "streamGather":
			case "stopStreamGather":
			case "setVariable":
			case "sleep":
				return yield* unsupported(context, verb.verb);
			default:
				// Exhaustiveness: adding a verb to `@optimiq-voice/telephony` breaks this line, which
				// is the entire reason it is here.
				return yield* assertNever(verb, context);
		}
	});

	return { dispatch };
}

/** The Nest-facing layer. Depends on nothing Effect-shaped, so it is built once at module init. */
export function verbExecutorLayer(deps: VerbExecutorDependencies): Layer.Layer<VerbExecutor> {
	return Layer.effect(VerbExecutor)(Effect.sync(() => VerbExecutor.of(makeVerbExecutor(deps))));
}

/**
 * The engine's Effect runtime for verb execution, as the calls module provides it under a Symbol
 * token. Named so consumers do not have to spell the three type parameters out.
 */
export type VerbExecutorRuntime = ModuleEffectRuntime<VerbExecutor, VerbExecutorInterface, never>;

/** Builds the runtime Nest disposes on shutdown. */
export function makeVerbExecutorRuntime(deps: VerbExecutorDependencies): VerbExecutorRuntime {
	return new ModuleEffectRuntime(VerbExecutor, verbExecutorLayer(deps));
}

/** Whether a verb ends the application's control of the leg. Re-exported for the orchestrator. */
export { isTerminalVerb };

function endReasonForCollection(collection: DtmfCollection): VerbResult["endReason"] {
	switch (collection.endReason) {
		case "max-digits":
		case "pattern":
			return "completed";
		case "terminator":
			return "terminator";
		case "timeout":
		case "inter-digit-timeout":
			return "timeout";
		case "cancelled":
			return "cancelled";
		case "hangup":
			return "hangup";
		default:
			return "failed";
	}
}

function assertNever(
	verb: never,
	context: VerbChannelContext,
): Effect.Effect<VerbResult, VerbFailure> {
	return Effect.fail(
		new UnsupportedVerbFailure({
			verb: (verb as { verb?: string }).verb ?? "unknown",
			channelId: context.channelId,
		}),
	);
}
