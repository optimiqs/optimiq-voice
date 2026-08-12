import type {
	SessionVerbArguments,
	SessionVerbName,
	SessionVerbRequest,
} from "@optimiq-voice/events";
import type { DtmfDigit, HangupCause, Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * The wire ↔ runtime translation for the session protocol.
 *
 * ## Why a translation exists at all
 *
 * `packages/events` models a verb as `{ verb, arguments }` — a name plus one flat argument record —
 * because the contract is generated into Go and the emitter has no representation for a tagged
 * union (see `sessionVerbArgumentsSchema`). `packages/telephony` models the same thing as a
 * discriminated union of 28 members, because that is what makes the engine's `switch` exhaustive at
 * compile time. Both are right for where they are, and this file is the seam between them.
 *
 * That makes THIS the place the flat record's cost is paid, and paying it here is the point: a
 * `play` with no `media` is a required argument missing, and it is caught here, by name, with a
 * message an integrator can act on — rather than reaching the media server as `undefined`.
 *
 * ## Pure, and that is deliberate
 *
 * No ports, no state, no clock. The mapping is where a protocol change and a runtime change have to
 * agree, so it is the piece most worth pinning with a spec that needs neither a media server nor a
 * broker.
 */

/** A mapping that failed, with the reason an application will read. */
export interface VerbMappingError {
	readonly error: string;
}

export type VerbMappingResult = { readonly verb: Verb } | VerbMappingError;

export function isMappingError(result: VerbMappingResult): result is VerbMappingError {
	return "error" in result;
}

/**
 * Ring time an application did not state.
 *
 * Thirty seconds, the same figure a dial plan's default ring timeout uses, and stated here rather
 * than left to the engine because `DialVerb.timeoutMs` is REQUIRED in the runtime union — a dial
 * that carried no bound at all would ring until the caller gave up.
 */
const DEFAULT_DIAL_TIMEOUT_MS = 30_000;

/** Translates one wire verb into the runtime union, or explains why it cannot. */
export function toRuntimeVerb(request: SessionVerbRequest): VerbMappingResult {
	const args: SessionVerbArguments = request.arguments ?? {};
	const missing = (field: string): VerbMappingError => ({
		error: `the ${request.verb} verb requires ${field}`,
	});

	switch (request.verb) {
		case "answer":
			return { verb: { verb: "answer" } };
		case "ringing":
			return { verb: { verb: "ringing" } };
		case "hangup":
			return {
				verb: {
					verb: "hangup",
					...(args.cause === undefined ? {} : { cause: args.cause as HangupCause }),
				},
			};
		case "play": {
			if (args.media === undefined) {
				return missing("media");
			}
			return {
				verb: {
					verb: "play",
					media: args.media,
					...(args.loop === undefined ? {} : { loop: args.loop }),
					...(args.playbackRef === undefined ? {} : { playbackRef: args.playbackRef }),
					...(args.terminators === undefined
						? {}
						: { terminators: args.terminators as readonly DtmfDigit[] }),
				},
			};
		}
		case "stopPlay":
			// The executor refuses a `stopPlay` with no reference, with its own explanation of why the
			// engine holds no per-leg playback list. That refusal is NOT duplicated here: it is a
			// statement about what the runtime knows, and copying it would mean two places to change
			// when the runtime learns to track playbacks.
			return {
				verb: {
					verb: "stopPlay",
					...(args.playbackRef === undefined ? {} : { playbackRef: args.playbackRef }),
				},
			};
		case "gather": {
			if (args.maxDigits === undefined) {
				return missing("maxDigits");
			}
			if (args.timeoutMs === undefined || args.interDigitTimeoutMs === undefined) {
				// Both, and neither is defaulted. `GatherVerb` says why: defaulting either one is how an
				// IVR ends up hanging on a silent caller, and the engine cannot know which of the two a
				// forgetful integrator meant.
				return missing("timeoutMs and interDigitTimeoutMs");
			}
			return {
				verb: {
					verb: "gather",
					maxDigits: args.maxDigits,
					terminators: (args.terminators ?? []) as readonly DtmfDigit[],
					timeoutMs: args.timeoutMs,
					interDigitTimeoutMs: args.interDigitTimeoutMs,
					...(args.regex === undefined ? {} : { regex: args.regex }),
					...(args.media === undefined ? {} : { media: args.media }),
				},
			};
		}
		case "record":
			return {
				verb: {
					verb: "record",
					...(args.maxDurationMs === undefined ? {} : { maxDurationMs: args.maxDurationMs }),
					...(args.silenceStopMs === undefined ? {} : { silenceStopMs: args.silenceStopMs }),
					...(args.beep === undefined ? {} : { beep: args.beep }),
					...(args.format === undefined ? {} : { format: args.format }),
				},
			};
		case "dial": {
			if (args.targets === undefined || args.targets.length === 0) {
				return missing("at least one target");
			}
			return {
				verb: {
					verb: "dial",
					strategy: args.strategy ?? "sequential",
					timeoutMs: args.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS,
					targets: args.targets.map((target) => ({
						// The wire's `context` and the runtime's `kind` say the same thing from two sides.
						// `outbound` is the only context that reaches a trunk, so it is the only one that
						// maps to `external`; everything else resolves internally first, which is the walk
						// `*69` performs and the one that keeps an extension number out of the toll rules.
						kind: target.context === "outbound" ? ("external" as const) : ("extension" as const),
						destination: target.destination,
					})),
					...(args.continueOnCauses === undefined
						? {}
						: { continueOnCauses: args.continueOnCauses as readonly HangupCause[] }),
				},
			};
		}
		case "bridge": {
			if (args.peerLegId === undefined) {
				return missing("peerLegId");
			}
			return { verb: { verb: "bridge", legId: args.peerLegId } };
		}
		case "unbridge":
			return { verb: { verb: "unbridge" } };
		case "transfer": {
			if (args.destination === undefined) {
				return missing("destination");
			}
			return {
				verb: {
					verb: "transfer",
					kind: args.transferKind ?? "blind",
					destination: {
						destination: args.destination,
						...(args.destinationContext === undefined ? {} : { context: args.destinationContext }),
					},
					...(args.fallbackDestination === undefined
						? {}
						: { fallbackDestination: { destination: args.fallbackDestination } }),
					...(args.cancelKey === undefined ? {} : { cancelKey: args.cancelKey as DtmfDigit }),
				},
			};
		}
		case "hold":
			return {
				verb: {
					verb: "hold",
					...(args.musicOnHold === undefined ? {} : { musicOnHold: args.musicOnHold }),
					...(args.soft === undefined ? {} : { soft: args.soft }),
				},
			};
		case "unhold":
			return { verb: { verb: "unhold" } };
		case "park":
			return {
				verb: {
					verb: "park",
					...(args.lot === undefined ? {} : { lot: args.lot }),
					...(args.orbit === undefined ? {} : { orbit: args.orbit }),
					...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
					...(args.musicOnHold === undefined ? {} : { musicOnHold: args.musicOnHold }),
				},
			};
		case "unpark":
			return {
				verb: {
					verb: "unpark",
					...(args.lot === undefined ? {} : { lot: args.lot }),
					...(args.orbit === undefined ? {} : { orbit: args.orbit }),
				},
			};
		case "playDtmf": {
			if (args.digits === undefined || args.digits.length === 0) {
				return missing("digits");
			}
			return {
				verb: {
					verb: "playDtmf",
					digits: args.digits as readonly DtmfDigit[],
					...(args.toneDurationMs === undefined ? {} : { toneDurationMs: args.toneDurationMs }),
				},
			};
		}
		case "mute":
			return { verb: { verb: "mute", direction: args.direction ?? "both" } };
		case "unmute":
			return { verb: { verb: "unmute", direction: args.direction ?? "both" } };
		case "setVariable": {
			if (args.name === undefined || args.value === undefined) {
				return missing("name and value");
			}
			return {
				verb: {
					verb: "setVariable",
					name: args.name,
					value: args.value,
					...(args.scope === undefined ? {} : { scope: args.scope }),
				},
			};
		}
		case "sleep": {
			if (args.durationMs === undefined) {
				return missing("durationMs");
			}
			return { verb: { verb: "sleep", durationMs: args.durationMs } };
		}
		default: {
			// Exhaustive over `SESSION_VERBS`. Adding a verb to the contract breaks this line, which is
			// the reminder that the runtime has to learn it too.
			const unreachable: never = request.verb;
			return { error: `unknown verb ${String(unreachable)}` };
		}
	}
}

/**
 * Flattens a runtime result onto the wire's flat response.
 *
 * The inverse of the argument record and, for the same reason, deliberately lossy in one direction
 * only: every field a result can carry has a home here, and a result fills in the ones it has.
 */
export function toWireResult(
	verb: SessionVerbName,
	result: VerbResult,
): Omit<import("@optimiq-voice/events").SessionVerbResponse, "instanceId" | "ok"> {
	const base = { verb, endReason: result.endReason } as const;
	switch (result.verb) {
		case "gather":
			return {
				...base,
				digits: [...result.collection.digits],
				elapsedMs: result.elapsedMs,
			};
		case "record":
			return {
				...base,
				recordingId: result.recordingId,
				mediaRef: result.mediaRef,
				durationMs: result.durationMs,
				format: result.format,
			};
		case "dial":
			return {
				...base,
				...(result.answeredTargetIndex === undefined
					? {}
					: { answeredTargetIndex: result.answeredTargetIndex }),
				...(result.cause === undefined ? {} : { cause: result.cause }),
				...(result.bridgeId === undefined ? {} : { bridgeId: result.bridgeId }),
				elapsedMs: result.elapsedMs,
			};
		case "play":
		case "say":
			return {
				...base,
				...(result.playbackRef === undefined ? {} : { playbackRef: result.playbackRef }),
				elapsedMs: result.elapsedMs,
			};
		default:
			return base;
	}
}
