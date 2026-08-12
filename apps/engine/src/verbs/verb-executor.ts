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
import type { CallControlPort, ControlledLeg } from "../calls/call-control";
import type { CallControlRegistry } from "../calls/call-control-registry";
import type { MediaPort } from "../media/media-port";
import type { VerbFailure } from "./verb-errors";
import type {
	AcknowledgedResult,
	DtmfCollection,
	DialResult,
	PlaybackResult,
	RecordResult,
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
 * The P2 inbound slice — `answer`, `ringing`, `play`, `gather`, `hangup` — plus the call-control
 * wave: `hold`, `unhold`, `park`, `unpark`, `transfer`, `record`, `mute`, `unmute`, `playDtmf`,
 * `stopPlay`, `setVariable` and `sleep` — plus `dial`, `bridge` and `unbridge`, which the session
 * protocol needed and which the domain-leg lookup on {@link CallControlHost} finally made
 * addressable.
 *
 * The remaining eight are still {@link UnsupportedVerbFailure}, which is an honest answer an
 * application can act on rather than a silent no-op, and each one is unimplemented for a stated
 * reason rather than by omission — see the `default` group in {@link makeVerbExecutor}'s switch.
 *
 * ## `dial`, `bridge` and `unbridge` go to call control, and the reason is a security one
 *
 * All three could have been media commands. `dial` in particular is `MediaPort.originate` plus a
 * bridge, and writing it that way here would have been shorter. It re-enters ROUTING instead — see
 * {@link CallControlPort.dial} — because the caller of these verbs is an external application over
 * a WebSocket, which is the least trusted principal on this platform, and an origination path that
 * skipped the tenant's outbound rules would be the cheapest way to bill somebody else's account.
 * `bridge` goes the same way for the sibling reason: its target is a leg id the APPLICATION chose,
 * so the cross-tenant check has to run somewhere that can see both legs.
 *
 * ## Two kinds of verb, and why they take different routes
 *
 * A verb that is one media command (`answer`, `mute`, `playDtmf`) goes straight to {@link MediaPort}.
 * A verb that is a call-control OPERATION (`hold`, `park`, `transfer`) goes to
 * {@link CallControlPort}, because each of them is several media commands plus routing plus state
 * that outlives the verb — an orbit slot, a consultation, a hold that has to remember which bridge
 * to return to. Putting that here would make the executor own call state; putting the media
 * commands there would make call control own the protocol.
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

/** Everything the executor depends on. All ports, so a spec supplies closures and a fake. */
export interface VerbExecutorDependencies {
	readonly media: MediaPort;
	readonly collectDtmf: DtmfCollector;
	/**
	 * The call-control seam, read LAZILY.
	 *
	 * A registry rather than the port itself because the port is the orchestrator, and the
	 * orchestrator is built from this executor — see `call-control-registry.ts` for the cycle this
	 * breaks. Absent, or bound to nothing, means the call-control verbs report themselves
	 * unimplemented, which is what an engine with routing switched off honestly is.
	 */
	readonly callControl?: CallControlRegistry;
	/** Injected so a spec can assert elapsed times without waiting for them. */
	readonly now?: () => number;
	/** Injected so playback references are deterministic in a spec. */
	readonly newPlaybackRef?: () => string;
	/** Injected so a spec asserts a `sleep` without waiting for it. */
	readonly delay?: (ms: number) => Promise<void>;
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
	const delay =
		deps.delay ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, ms);
				timer.unref?.();
			}));

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

	// --- call control --------------------------------------------------------------------------

	/**
	 * Resolves the call-control seam for one leg.
	 *
	 * Two ways it can be absent and both are honest failures rather than defects: nothing has
	 * registered a binding (routing is off, or a spec built the executor bare), or the binding does
	 * not know this leg (it belongs to another engine instance, or it has already been reaped).
	 * Neither is a state to throw on — an application asked for something this engine cannot do to
	 * this leg, and that is exactly what {@link UnsupportedVerbFailure} means.
	 */
	const controlFor = (
		context: VerbChannelContext,
		verb: VerbName,
	): Effect.Effect<{ port: CallControlPort; leg: ControlledLeg }, VerbFailure> => {
		const binding = deps.callControl?.current;
		if (binding === undefined) {
			return Effect.fail(new UnsupportedVerbFailure({ verb, channelId: context.channelId }));
		}
		const leg = binding.legFor(context.mediaChannelId);
		if (leg === undefined) {
			return Effect.fail(
				new VerbNotPermittedFailure({
					verb,
					channelId: context.channelId,
					reason: "this engine is not handling the leg",
				}),
			);
		}
		return Effect.succeed({ port: binding.port, leg });
	};

	/** Turns a call-control refusal into the same typed failure a media rejection produces. */
	const controlled = (
		verb: AcknowledgedResult["verb"],
		context: VerbChannelContext,
		run: (input: { port: CallControlPort; leg: ControlledLeg }) => Promise<{
			readonly ok: boolean;
			readonly reason?: string;
		}>,
	): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.gen(function* () {
			const binding = yield* controlFor(context, verb);
			const outcome = yield* mediaCall(verb, context, () => run(binding));
			if (!outcome.ok) {
				return yield* Effect.fail(
					new VerbNotPermittedFailure({
						verb,
						channelId: context.channelId,
						reason: outcome.reason ?? "the operation was refused",
					}),
				);
			}
			return acknowledged(verb);
		});

	/**
	 * Starts an on-demand recording, and returns as soon as it is RUNNING.
	 *
	 * The same contract `play` holds to, and for the same reason: the caller needs the handle now,
	 * and the recording ends when the call does or when something stops it — neither of which this
	 * effect can wait for without holding a fiber for the length of a phone call. `durationMs` is
	 * therefore `0` here and the real figure rides `channel.record.stopped`, which is the event the
	 * uploader and the CDR's `recordingKey` both read anyway.
	 */
	const record = (
		context: VerbChannelContext,
		verb: Extract<Verb, { verb: "record" }>,
	): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.gen(function* () {
			const binding = yield* controlFor(context, "record");
			const outcome = yield* mediaCall("record", context, () =>
				binding.port.startRecording(binding.leg, {
					...(verb.maxDurationMs === undefined ? {} : { maxDurationMs: verb.maxDurationMs }),
					...(verb.silenceStopMs === undefined ? {} : { silenceStopMs: verb.silenceStopMs }),
					...(verb.beep === undefined ? {} : { beep: verb.beep }),
					...(verb.format === undefined ? {} : { format: verb.format }),
				}),
			);
			if (!outcome.result.ok || outcome.recordingId === undefined) {
				return yield* Effect.fail(
					new VerbNotPermittedFailure({
						verb: "record",
						channelId: context.channelId,
						reason: outcome.result.ok ? "the recording produced no handle" : outcome.result.reason,
					}),
				);
			}
			const result: RecordResult = {
				verb: "record",
				endReason: "completed",
				recordingId: outcome.recordingId,
				mediaRef: `object://${outcome.objectKey ?? ""}`,
				durationMs: 0,
				format: verb.format ?? "wav",
			};
			return result;
		});

	/**
	 * Stops one playback by reference.
	 *
	 * Omitting the reference is documented as "stop all of them" and is REFUSED rather than
	 * approximated: the engine does not hold a per-leg playback list, and a `stopPlay` that silently
	 * stopped nothing is worse than one that says it needs a handle.
	 */
	const stopPlay = (
		context: VerbChannelContext,
		verb: Extract<Verb, { verb: "stopPlay" }>,
	): Effect.Effect<VerbResult, VerbFailure> => {
		if (verb.playbackRef === undefined) {
			return Effect.fail(
				new VerbNotPermittedFailure({
					verb: "stopPlay",
					channelId: context.channelId,
					reason: "a playback reference is required; the engine holds no per-leg playback list",
				}),
			);
		}
		return Effect.map(
			mediaCall("stopPlay", context, () => deps.media.stopPlayback(verb.playbackRef as string)),
			() => acknowledged("stopPlay"),
		);
	};

	/**
	 * Sets a channel variable.
	 *
	 * `channel` scope only. `export` copies a value onto every leg this channel originates and
	 * `global` is process-wide; neither is a variable write, both are policy the routing compiler
	 * allow-lists, and implementing them as a plain write here would be the tenant-data leak that
	 * allow-list exists to prevent.
	 */
	const setVariable = (
		context: VerbChannelContext,
		verb: Extract<Verb, { verb: "setVariable" }>,
	): Effect.Effect<VerbResult, VerbFailure> => {
		const scope = verb.scope ?? "channel";
		if (scope !== "channel") {
			return Effect.fail(
				new VerbNotPermittedFailure({
					verb: "setVariable",
					channelId: context.channelId,
					reason: `the "${scope}" scope is not a plain variable write and is not implemented`,
				}),
			);
		}
		return Effect.map(
			mediaCall("setVariable", context, () =>
				deps.media.setVariable(context.mediaChannelId, verb.name, verb.value),
			),
			() => acknowledged("setVariable"),
		);
	};

	/**
	 * Originates towards the verb's targets and connects the first that answers.
	 *
	 * Sequential, always. `simultaneous` is REFUSED by name rather than quietly downgraded, because
	 * an application that asked for ring-all and got sequential would watch a list of phones ring one
	 * after another with no way to tell that from the feature working slowly. Ring-all with
	 * lose-race semantics and CDR-correct losers belongs to the plan walker, which owns origination
	 * — see {@link CallControlPort.dial}.
	 *
	 * Every target goes through routing, so the tenant's outbound rules and toll gates apply. That
	 * is the `*69` precedent, and it is the reason this verb was worth enabling at all: an
	 * origination path an integration could reach that skipped those would be the cheapest way to
	 * defraud a customer on this platform.
	 */
	const dial = (
		context: VerbChannelContext,
		verb: Extract<Verb, { verb: "dial" }>,
	): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.gen(function* () {
			if (verb.strategy === "simultaneous") {
				return yield* Effect.fail(
					new VerbNotPermittedFailure({
						verb: "dial",
						channelId: context.channelId,
						reason:
							"the session protocol dials targets sequentially; ring-all belongs to a ring " +
							"group in the dial plan, which owns lose-race semantics and the losers' CDRs",
					}),
				);
			}
			const startedAt = now();
			const binding = yield* controlFor(context, "dial");
			const outcome = yield* mediaCall("dial", context, () =>
				binding.port.dial(binding.leg, {
					targets: verb.targets.map((target) => ({
						destination: target.destination,
						// `external` and `trunk` resolve in the tenant's OUTBOUND rules; everything else
						// resolves internally first. The verb's richer target model — per-target trunk
						// refs, per-target caller ids, answer confirmation — is deliberately not
						// forwarded: an application that could name a trunk could dial past the toll
						// gate this routing hop exists to enforce.
						...(target.kind === "external" || target.kind === "trunk"
							? { context: "outbound" as const }
							: {}),
					})),
					...(verb.continueOnCauses === undefined
						? {}
						: { continueOnCauses: verb.continueOnCauses }),
				}),
			);
			// A dial that connected nobody is a RESULT, not a failure: the application asked whether
			// anyone would answer and the answer is no, with the cause attached. That is exactly the
			// distinction `VerbEndReason` exists to carry, and turning it into a typed failure would
			// throw the cause away at the one point an application most needs it.
			const result: DialResult = {
				verb: "dial",
				endReason: outcome.result.ok ? "completed" : "failed",
				...(outcome.answeredTargetIndex === undefined
					? {}
					: { answeredTargetIndex: outcome.answeredTargetIndex }),
				...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
				elapsedMs: now() - startedAt,
			};
			return result;
		});

	/** Joins this leg to another, by domain leg id. The tenancy check lives in call control. */
	const bridge = (
		context: VerbChannelContext,
		verb: Extract<Verb, { verb: "bridge" }>,
	): Effect.Effect<VerbResult, VerbFailure> =>
		Effect.gen(function* () {
			const binding = yield* controlFor(context, "bridge");
			const outcome = yield* mediaCall("bridge", context, () =>
				binding.port.bridge(binding.leg, { peerLegId: verb.legId }),
			);
			if (!outcome.result.ok) {
				return yield* Effect.fail(
					new VerbNotPermittedFailure({
						verb: "bridge",
						channelId: context.channelId,
						reason: outcome.result.reason,
					}),
				);
			}
			return acknowledged("bridge");
		});

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
			case "stopPlay":
				return yield* stopPlay(context, verb);
			case "setVariable":
				return yield* setVariable(context, verb);
			case "record":
				return yield* record(context, verb);
			case "dial":
				return yield* dial(context, verb);
			case "bridge":
				return yield* bridge(context, verb);
			case "unbridge":
				return yield* controlled("unbridge", context, ({ port, leg }) => port.unbridge(leg));

			case "hold":
				return yield* controlled("hold", context, ({ port, leg }) =>
					port.hold(leg, {
						...(verb.musicOnHold === undefined ? {} : { musicOnHold: verb.musicOnHold }),
						...(verb.soft === undefined ? {} : { soft: verb.soft }),
					}),
				);
			case "unhold":
				return yield* controlled("unhold", context, ({ port, leg }) => port.unhold(leg));
			case "park":
				return yield* controlled("park", context, async ({ port, leg }) => {
					const outcome = await port.park(leg, {
						...(verb.lot === undefined ? {} : { lot: verb.lot }),
						...(verb.orbit === undefined ? {} : { orbit: verb.orbit }),
						...(verb.timeoutMs === undefined ? {} : { timeoutMs: verb.timeoutMs }),
						...(verb.musicOnHold === undefined ? {} : { musicOnHold: verb.musicOnHold }),
					});
					return outcome.result;
				});
			case "unpark":
				return yield* controlled("unpark", context, ({ port, leg }) =>
					port.unpark(leg, {
						...(verb.lot === undefined ? {} : { lot: verb.lot }),
						...(verb.orbit === undefined ? {} : { orbit: verb.orbit }),
					}),
				);
			case "transfer":
				return yield* controlled("transfer", context, ({ port, leg }) =>
					port.transfer(leg, {
						kind: verb.kind,
						destination: verb.destination.destination,
						...(verb.destination.context === undefined
							? {}
							: { context: verb.destination.context }),
						...(verb.fallbackDestination === undefined
							? {}
							: { fallbackDestination: verb.fallbackDestination.destination }),
						// Armed and disarmed inside the consultation's own lifetime — see
						// `TransferRequest.cancelKey`.
						...(verb.cancelKey === undefined ? {} : { cancelKey: verb.cancelKey }),
					}),
				);

			case "playDtmf":
				return yield* Effect.map(
					mediaCall("playDtmf", context, () =>
						deps.media.sendDtmf(context.mediaChannelId, {
							digits: verb.digits.join(""),
							...(verb.toneDurationMs === undefined ? {} : { toneDurationMs: verb.toneDurationMs }),
						}),
					),
					() => acknowledged("playDtmf"),
				);
			case "mute":
				return yield* Effect.map(
					mediaCall("mute", context, () => deps.media.mute(context.mediaChannelId, verb.direction)),
					() => acknowledged("mute"),
				);
			case "unmute":
				return yield* Effect.map(
					mediaCall("unmute", context, () =>
						deps.media.unmute(context.mediaChannelId, verb.direction),
					),
					() => acknowledged("unmute"),
				);
			case "sleep":
				return yield* Effect.map(
					mediaCall("sleep", context, () => delay(Math.max(0, verb.durationMs))),
					() => acknowledged("sleep"),
				);

			// --- still unimplemented, each for a stated reason --------------------------------
			// `earlyMedia`: ARI exposes 180 (`ring`) and 200 (`answer`) and nothing for 183 + SDP.
			// `playbackControl`: needs `POST /playbacks/{id}/control`, which the ARI client does not
			//   surface yet; a pause that silently did nothing is worse than an honest refusal.
			// `say` / `stopSay`: no TTS renderer is wired. Faking it with `sound:` files would play
			//   the wrong words.
			// `stream` / `stopStream` / `streamGather` / `stopStreamGather`: the AudioSocket seam.
			case "earlyMedia":
			case "playbackControl":
			case "say":
			case "stopSay":
			case "stream":
			case "stopStream":
			case "streamGather":
			case "stopStreamGather":
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
