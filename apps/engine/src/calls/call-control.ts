import { createEntityId } from "@optimiq-voice/identifiers";
import {
	assertParkTransition,
	assertTransferTransition,
	hangupCauseForTransfer,
	INITIAL_PARK_STATE,
	INITIAL_TRANSFER_STATE,
	supportsRecording,
} from "@optimiq-voice/telephony";
import { legSignalKey, recordingSignalKey } from "../routing/call-signals";
import { parkSlotFor } from "../routing/park-registry";
import { parkHandoffRefusal } from "./park-handoff";
import type { MediaPort } from "../media/media-port";
import type { CallSignalBus, LegSignal } from "../routing/call-signals";
import type { ParkedCall, ParkRegistry, ParkResult } from "../routing/park-registry";
import type { ParkHandoffClient } from "./park-handoff";
import type {
	CallEvent,
	ParkEndReason,
	ParkHandoffRefusalReason,
	ParkHandoffRequest,
	ParkHandoffResponse,
	PickupKind,
} from "@optimiq-voice/events";
import type {
	CallState,
	ChannelFlag,
	DtmfDigit,
	ChannelState,
	HangupCause,
	MediaRef,
	ParkState,
	TransferKind,
	TransferState,
} from "@optimiq-voice/telephony";

/**
 * Call control — hold, transfer, park, pickup and on-demand recording, on a call that is already up.
 *
 * ## Why this is not in the plan walker
 *
 * Everything the walker does happens on the way to a destination: it runs once, from `StasisStart`
 * to a bridge, and its whole vocabulary is "what should this caller reach?". Every operation here
 * happens AFTER that question was answered, to a call that is already connected, and is triggered
 * by somebody other than the caller — an agent pressing hold, a colleague dialling a park slot, an
 * application sending a verb. Two of them (park, pickup) act on a leg belonging to a different
 * call entirely.
 *
 * So this class owns the operations and the walker owns the route, and the seam between them is
 * {@link CallControlHost.route}: when an operation needs a destination resolved — which is every
 * transfer and every park timeout — it asks for a walk rather than reimplementing one. That is what
 * makes a transferred call produce the same B-leg CDR, the same `channel.bridged`, and the same
 * failover branches as a call that reached the destination the ordinary way.
 *
 * ## Everything is a port
 *
 * The media server, the signal bus, the leg registry, the event publisher and the router are all
 * injected, so the whole of `call-control.spec.ts` runs in process with no Asterisk and no NATS —
 * the same standard the walker's specs hold to.
 *
 * ## Guard, then execute
 *
 * Every entry point validates before it touches media, and every one of them returns a
 * {@link CallControlResult} rather than throwing. These run on the ARI event path and on the verb
 * path; a throw from either takes down more than the operation that failed.
 *
 * ## The one thing hold, park and attended transfer all are
 *
 * The same primitive, three times: **take a leg out of its bridge and give it something to listen
 * to.** Hold keeps the bridge and puts the leg back; park moves it to an orbit somebody else can
 * dial; attended transfer holds the transferee while a consultation happens in a second bridge.
 * They are written as three methods rather than one parameterised one because their FAILURE
 * behaviour differs completely — a hold that cannot restore the bridge is a stuck call, a park that
 * cannot claim a slot must not happen at all, and a transfer that loses its consultation must put
 * the original call back.
 */

// -------------------------------------------------------------------------------------------
// The seams
// -------------------------------------------------------------------------------------------

/**
 * A leg this runtime can act on.
 *
 * Every member is LIVE: the orchestrator owns the aggregate and it moves underneath a long-running
 * operation — a call parked for four minutes must read its current state, not the state it had when
 * the slot was claimed.
 */
export interface ControlledLeg {
	readonly mediaChannelId: string;
	readonly legId: string;
	readonly callId: string;
	readonly organizationId: string;
	readonly isTearingDown: boolean;
	readonly isAnswered: boolean;
	/** The bridge this leg is currently in, when it is in one. */
	readonly bridgeId: string | undefined;
	/** The media-server id of the leg on the other side of that bridge, when the engine knows it. */
	readonly peerMediaChannelId: string | undefined;
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
	/** What this leg was dialled to reach. How a directed pickup finds a ringing phone. */
	readonly destinationNumber?: string;
	/** Guarded state move. Returns whether the machine actually moved. */
	moveTo(state: ChannelState): boolean;
	/** Guarded user-visible state move, for the value a BLF subscriber renders. */
	moveCallStateTo(state: CallState): boolean;
	setBridge(bridgeId: string | undefined): void;
	/** Records (or clears) the leg on the other side, which is what each CDR carries. */
	setBridgePeer(peerLegId: string | undefined): void;
	addFlag(flag: ChannelFlag): void;
	removeFlag(flag: ChannelFlag): void;
	/** Fixes the hangup cause BEFORE the media server is told. First-wins, as everywhere else. */
	markHangup(cause: HangupCause): void;
	/**
	 * Abandons whatever routing walk owns this leg, because a feature has taken it over.
	 *
	 * Only pickup needs it, and it needs it badly: the walk that is ringing the extension sees its
	 * B-leg die and would otherwise take the no-answer branch and send the caller — who is by then
	 * talking to somebody — to voicemail.
	 */
	detach(): void;
}

/** A ringing phone and the caller who is ringing it. What a pickup takes over. */
export interface PickupCandidate {
	/** The leg being alerted: the phone that is ringing. It is hung up with `PICKED_OFF`. */
	readonly ringingLeg: ControlledLeg;
	/** The party calling it. This is who the picker ends up talking to. */
	readonly callerLeg: ControlledLeg;
	/** When the phone started ringing, so the longest-waiting call is taken first. */
	readonly ringingSinceMs: number;
}

/** A park lot, as the compiled artifact describes it. */
export interface ParkLot {
	readonly parkLotId: string;
	readonly slotStart: number;
	readonly slotEnd: number;
	/** How long a call may sit before it is returned to the parker. `0`/absent means forever. */
	readonly timeoutSeconds?: number;
	readonly mohClass?: string;
}

/** Where a leg should be sent, in the vocabulary of the routing artifact. */
export interface RouteRequest {
	readonly destination: string;
	/** Routing namespace. Defaults to `internal`, which is the only context a transfer may use. */
	readonly context?: string;
	/** Identity to present on legs originated for this route. */
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
	/** Run just before the leg is joined to whatever the route found. Where hold music stops. */
	readonly beforeBridge?: () => Promise<void>;
}

export interface RouteOutcome {
	/** `bridged` means the leg is connected; everything else means it is not. */
	readonly status: "bridged" | "hangup" | "aborted" | "exhausted" | "unresolved";
	readonly cause?: HangupCause;
	/** The leg the route connected this one to, when it connected one. */
	readonly peerMediaChannelId?: string;
	readonly notes: readonly string[];
}

/**
 * What this runtime needs from the orchestrator.
 *
 * A host rather than a direct dependency on `ChannelOrchestrator` for the reason the signal bus
 * exists: the orchestrator builds this class, so this class cannot build the orchestrator. Every
 * member is something only the orchestrator can answer — it owns the registry, the artifact and the
 * publisher.
 */
export interface CallControlHost {
	/** The leg with this media id, or `undefined` when this process is not handling it. */
	legFor(mediaChannelId: string): ControlledLeg | undefined;
	/**
	 * Phones currently being alerted for `extension`, longest-ringing first.
	 *
	 * Asynchronous because a GROUP pickup has to know the caller's pickup group, and that lives in
	 * the compiled routing artifact — which is fetched on a cache miss. A synchronous answer would
	 * mean either a second copy of the artifact here or guessing the group, and guessing it means a
	 * receptionist answering the warehouse's call.
	 */
	ringingFor(leg: ControlledLeg, extension: string): Promise<readonly PickupCandidate[]>;
	publish(leg: ControlledLeg, type: CallEvent, data: Record<string, unknown>): Promise<void>;
	/** Resolves `destination` through the organization's artifact and walks the plan on this leg. */
	route(leg: ControlledLeg, request: RouteRequest): Promise<RouteOutcome>;
	/**
	 * The lot a park should use: the one named, or the organization's only one.
	 *
	 * Asynchronous because a lot lives in the compiled routing artifact, and the artifact is fetched
	 * on a cache miss. A park that had to be answered synchronously would either hold a second copy
	 * of the artifact here or guess a range, and guessing a range hands out orbits nobody can dial.
	 */
	parkLotFor(leg: ControlledLeg, lotRef?: string): Promise<ParkLot | undefined>;
	/** The lot whose range contains this orbit. Ranges never overlap — the compiler refuses it. */
	parkLotForSlot(leg: ControlledLeg, slot: number): Promise<ParkLot | undefined>;
}

/** Deployment knobs. All have defaults; none is a product decision. */
export interface CallControlSettings {
	/** The Stasis application a snoop channel is handed to. Must match the engine's `ARI_APP`. */
	readonly application: string;
	/** Container on-demand recordings are written in. */
	readonly recordingFormat: string;
	/** How long to wait for a snoop channel to reach the application before giving up. */
	readonly snoopTimeoutMs: number;
	/** How long to wait for `RecordingFinished` after a stop before publishing anyway. */
	readonly recordingStopTimeoutMs: number;
	/** Park timeout when the lot has none of its own. `0` means "never time out". */
	readonly defaultParkTimeoutSeconds: number;
	/** Routing namespace a transfer destination is resolved in. */
	readonly transferContext: string;
}

export const DEFAULT_CALL_CONTROL_SETTINGS: CallControlSettings = {
	application: "optimiq-engine",
	recordingFormat: "wav",
	snoopTimeoutMs: 5_000,
	recordingStopTimeoutMs: 5_000,
	// Two minutes is the vanilla park timeout every installer expects, and short enough that a
	// forgotten call rings back while the parker still remembers taking it.
	defaultParkTimeoutSeconds: 120,
	// `internal` and nothing else. A transfer destination that resolved in `outbound` would let any
	// caller who reaches a phone with a transfer key dial anywhere on the tenant's account.
	transferContext: "internal",
};

export interface CallControlDependencies {
	readonly media: MediaPort;
	readonly signals: CallSignalBus;
	readonly parks: ParkRegistry;
	readonly host: CallControlHost;
	/**
	 * The engine-to-engine seam a cross-instance park retrieval goes through.
	 *
	 * Optional, and its absence is a supported deployment rather than a degraded one: a single
	 * engine behind a media server never sees a claim it does not own, so there is nothing to ask
	 * anybody. Absent, {@link CallControl.unpark} answers a foreign orbit with the same refusal it
	 * gave before the RPC existed.
	 */
	readonly parkHandoff?: ParkHandoffClient;
	/**
	 * Where an attended transfer's cancel key is armed and disarmed.
	 *
	 * The mid-call feature runtime, in production. Optional so a spec about transfers needs no DTMF
	 * machinery at all, which is the same rule the walker's optional ports follow.
	 */
	readonly consultationKeys?: {
		arm(mediaChannelId: string, digit: DtmfDigit): void;
		disarm(mediaChannelId: string): void;
	};
	readonly settings?: Partial<CallControlSettings>;
	/** Injected so ids are deterministic in a spec. */
	readonly newId?: () => string;
	readonly now?: () => number;
	/** Injected so a spec asserts a park timeout without waiting for it. */
	readonly setTimer?: (fn: () => void, ms: number) => { readonly cancel: () => void };
	readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

// -------------------------------------------------------------------------------------------
// Results
// -------------------------------------------------------------------------------------------

/**
 * The answer to every operation.
 *
 * A discriminated result rather than a throw, and rather than a bare boolean: the caller is either
 * the verb executor (which turns `ok: false` into a typed failure an application can act on) or the
 * ARI event path (which logs it). Both need the REASON, and neither can afford an exception.
 */
export type CallControlResult =
	| { readonly ok: true; readonly detail?: string }
	| { readonly ok: false; readonly reason: string };

const ok = (detail?: string): CallControlResult =>
	detail === undefined ? { ok: true } : { ok: true, detail };
const refuse = (reason: string): CallControlResult => ({ ok: false, reason });

export interface ParkOutcome {
	readonly result: CallControlResult;
	/** The orbit the call landed in, when it landed in one. */
	readonly slot?: number;
	readonly parkLotId?: string;
}

export interface RecordingOutcome {
	readonly result: CallControlResult;
	readonly recordingId?: string;
	/** Where the audio will be, in the object store's vocabulary. */
	readonly objectKey?: string;
}

// -------------------------------------------------------------------------------------------
// Requests
// -------------------------------------------------------------------------------------------

export interface HoldRequest {
	readonly musicOnHold?: MediaRef;
	/**
	 * Keep the media path up instead of re-INVITEing the far end.
	 *
	 * Used mid-attended-transfer: the transferee is held and unheld within a few seconds, and two
	 * renegotiations in that window is how phones end up with one-way audio.
	 */
	readonly soft?: boolean;
}

export interface ParkRequest {
	/** The lot to park in. Absent means the organization's only lot. */
	readonly lot?: string;
	/** The orbit to take. Absent auto-assigns the lowest free one. */
	readonly orbit?: string;
	/** Overrides the lot's own timeout. */
	readonly timeoutMs?: number;
	readonly musicOnHold?: MediaRef;
	/** The leg that asked for the park, for the timeout ringback. */
	readonly parkedBy?: ControlledLeg;
}

export interface UnparkRequest {
	readonly lot?: string;
	/** The orbit to collect. Required: there is no "retrieve whatever is oldest". */
	readonly orbit?: string;
}

export interface TransferRequest {
	readonly kind: TransferKind;
	readonly destination: string;
	readonly context?: string;
	/** Where to send the transferee when the transfer fails. */
	readonly fallbackDestination?: string;
	/**
	 * Attended only: the digit that abandons the consultation and returns to the original party.
	 *
	 * Armed HERE, at the moment the consultation is created, and disarmed the moment it is dropped —
	 * rather than by the verb executor around the call. A key armed by a caller that then failed to
	 * disarm it would swallow that digit for the rest of the call, and the two places a consultation
	 * ends (completion and abandonment) are inside this class, not around it.
	 */
	readonly cancelKey?: DtmfDigit;
}

export interface PickupRequest {
	readonly kind: PickupKind;
	/** The extension whose ringing call is being taken. */
	readonly extension: string;
}

export interface StartRecordingRequest {
	readonly maxDurationMs?: number;
	readonly silenceStopMs?: number;
	readonly beep?: boolean;
	readonly format?: string;
}

/** The surface the verb executor and the plan walker call. `CallControl` is its only implementation. */
export interface CallControlPort {
	hold(leg: ControlledLeg, request?: HoldRequest): Promise<CallControlResult>;
	unhold(leg: ControlledLeg): Promise<CallControlResult>;
	park(leg: ControlledLeg, request?: ParkRequest): Promise<ParkOutcome>;
	unpark(leg: ControlledLeg, request?: UnparkRequest): Promise<CallControlResult>;
	transfer(leg: ControlledLeg, request: TransferRequest): Promise<CallControlResult>;
	completeTransfer(leg: ControlledLeg): Promise<CallControlResult>;
	cancelTransfer(leg: ControlledLeg): Promise<CallControlResult>;
	pickup(leg: ControlledLeg, request: PickupRequest): Promise<CallControlResult>;
	startRecording(leg: ControlledLeg, request?: StartRecordingRequest): Promise<RecordingOutcome>;
	stopRecording(leg: ControlledLeg): Promise<CallControlResult>;
	/** Whether an attended transfer initiated by this leg is waiting to be completed. */
	hasPendingTransfer(mediaChannelId: string): boolean;
	/** Told by the orchestrator when a leg goes away, so held music, slots and taps are released. */
	onLegEnded(mediaChannelId: string): Promise<void>;
}

// -------------------------------------------------------------------------------------------
// Internal state
// -------------------------------------------------------------------------------------------

/** A leg that is out of its bridge and listening to something. */
interface HeldLeg {
	readonly mediaChannelId: string;
	/** The bridge to put it back into. Absent when it was not bridged at all. */
	readonly bridgeId: string | undefined;
	readonly peerMediaChannelId: string | undefined;
	readonly peerLegId: string | undefined;
	/** Whether the far end was told, and therefore has to be told again on release. */
	readonly signalled: boolean;
	readonly heldAtMs: number;
}

/** An attended transfer waiting for its transferor to finish consulting. */
interface Consultation {
	state: TransferState;
	readonly kind: TransferKind;
	readonly transferorMediaChannelId: string;
	readonly transfereeMediaChannelId: string;
	readonly destination: string;
	readonly context: string;
	/**
	 * Where the transferee goes when the handover fails and the transferor is no longer there to
	 * take them back (`transfer_fallback_extension`). See {@link CallControl.rescueTransferee}.
	 */
	readonly fallbackDestination?: string;
	readonly startedAtMs: number;
	/** Drops the watcher on the transferee, which aborts the transfer if they hang up. */
	readonly stopWatching: () => void;
}

/** A live tap writing one leg's conversation to the recording store. */
interface RecordingSession {
	readonly recordingId: string;
	readonly objectKey: string;
	readonly snoopChannelId: string;
	readonly format: string;
	readonly startedAtMs: number;
}

/** A parked call and the timer that will ring it back. */
interface ParkTimer {
	readonly cancel: () => void;
}

/**
 * Whether a `*8` from `callerNumber` may answer a phone ringing at another extension.
 *
 * Pure, exported, and separate from the orchestrator because this three-case rule IS the feature —
 * everything around it is registry iteration — and each case is a decision somebody will want to
 * revisit:
 *
 * 1. **Both in a group** → the groups must MATCH. The case the feature exists for. Without it a
 *    receptionist answers the warehouse's call, which reads as a phone-system bug and is not one.
 * 2. **The target is in NO group** → anybody may take it. Org-wide is the documented fallback and
 *    is what every extension had before groups were compiled; making an ungrouped extension
 *    unpickable would take a working feature away from every tenant who has not configured groups.
 * 3. **The caller is in no group, the target is** → refused. Letting a groupless caller into every
 *    group would make the restriction decorative: an admin who groups half their extensions expects
 *    the other half to be OUTSIDE those groups, not inside all of them.
 *
 * Returns `undefined` when the organization has no groups at all, so the org-wide path costs
 * nothing on a tenant that has not configured any — which is most of them.
 */
export function pickupGroupFilter(
	extensionsByNumber: Readonly<Record<string, { readonly pickupGroup?: string }>>,
	callerNumber: string | undefined,
): ((ringingNumber: string | undefined) => boolean) | undefined {
	const grouped = Object.values(extensionsByNumber).some(
		(entry) => entry.pickupGroup !== undefined,
	);
	if (!grouped) {
		return undefined;
	}
	const callerGroup = extensionsByNumber[callerNumber?.trim() ?? ""]?.pickupGroup;
	return (ringingNumber) => {
		const targetGroup =
			ringingNumber === undefined ? undefined : extensionsByNumber[ringingNumber]?.pickupGroup;
		return targetGroup === undefined ? true : targetGroup === callerGroup;
	};
}

const MILLIS_PER_SECOND = 1_000;

/**
 * Why a park was refused, in words the person who pressed the key can be told.
 *
 * `claims-unavailable` is deliberately not softened into "the lot is full": the lot may be empty,
 * and a caller told it was full would try another lot and be refused there too. The broker's own
 * reason is carried through because this is an outage, and the operator reading the log is the
 * person who can fix it.
 */
function parkRefusal(claim: Exclude<ParkResult, { kind: "parked" }>): string {
	switch (claim.kind) {
		case "lot-full":
			return `every orbit in the lot is taken (${String(claim.capacity)} in use)`;
		case "slot-unavailable":
			return `orbit ${String(claim.slot)} is already occupied`;
		case "claims-unavailable":
			return `park slots cannot be claimed right now: ${claim.reason}`;
	}
}

export class CallControl implements CallControlPort {
	private readonly settings: CallControlSettings;
	private readonly newId: () => string;
	private readonly now: () => number;
	private readonly log: (message: string, detail?: Record<string, unknown>) => void;
	private readonly setTimer: (fn: () => void, ms: number) => ParkTimer;

	private readonly holds = new Map<string, HeldLeg>();
	private readonly consultations = new Map<string, Consultation>();
	private readonly recordings = new Map<string, RecordingSession>();
	private readonly parkTimers = new Map<string, ParkTimer>();
	/** `parkStates` and `transferStates` exist to make the machines' guards real, not decorative. */
	private readonly parkStates = new Map<string, ParkState>();

	constructor(private readonly deps: CallControlDependencies) {
		this.settings = { ...DEFAULT_CALL_CONTROL_SETTINGS, ...deps.settings };
		this.newId = deps.newId ?? createEntityId;
		this.now = deps.now ?? Date.now;
		this.log = deps.log ?? (() => undefined);
		this.setTimer =
			deps.setTimer ??
			((fn, ms) => {
				const timer = setTimeout(fn, ms);
				timer.unref?.();
				return { cancel: () => clearTimeout(timer) };
			});
	}

	/** Legs this process is holding, parking, consulting on or recording. `/healthz` reads it. */
	get activeOperationCount(): number {
		return this.holds.size + this.consultations.size + this.recordings.size + this.parkTimers.size;
	}

	hasPendingTransfer(mediaChannelId: string): boolean {
		return this.consultations.has(mediaChannelId);
	}

	/** Whether this leg is currently out of its bridge listening to hold music. */
	isHeld(mediaChannelId: string): boolean {
		return this.holds.has(mediaChannelId);
	}

	/** The recording running on this leg, if any. Read by the record-toggle feature code. */
	recordingFor(mediaChannelId: string): { readonly recordingId: string } | undefined {
		const session = this.recordings.get(mediaChannelId);
		return session === undefined ? undefined : { recordingId: session.recordingId };
	}

	// -------------------------------------------------------------------------------------------
	// Hold
	// -------------------------------------------------------------------------------------------

	/**
	 * Takes the leg out of its bridge and gives it music.
	 *
	 * The order is the whole method: OUT of the bridge first, music second. Doing it the other way
	 * round plays hold music into a live conversation for however long the two calls take, which is
	 * a bug the person on the other end reports as "I could hear music over them".
	 *
	 * The far end is told by default (a SIP re-INVITE, so the phone lights its hold key) and NOT
	 * told when the caller asks for a soft hold — see {@link HoldRequest.soft}.
	 */
	async hold(leg: ControlledLeg, request: HoldRequest = {}): Promise<CallControlResult> {
		const refusal = this.refuseIfUnusable(leg, "hold");
		if (refusal !== undefined) {
			return refusal;
		}
		if (this.holds.has(leg.mediaChannelId)) {
			return refuse("the leg is already on hold");
		}

		const bridgeId = leg.bridgeId;
		const peerMediaChannelId = leg.peerMediaChannelId;
		if (bridgeId !== undefined) {
			try {
				await this.deps.media.removeFromBridge(bridgeId, [leg.mediaChannelId]);
			} catch (error) {
				return refuse(`the leg could not be taken out of its bridge: ${String(error)}`);
			}
		}

		const signalled = request.soft !== true;
		try {
			if (signalled) {
				await this.deps.media.hold(leg.mediaChannelId);
			}
			await this.deps.media.startMusicOnHold(leg.mediaChannelId, request.musicOnHold);
		} catch (error) {
			// Music that will not start is a caller listening to silence, which is worse than music
			// and much better than a dropped call. The hold still stands and says so.
			this.log("hold music could not be started", {
				mediaChannelId: leg.mediaChannelId,
				err: String(error),
			});
		}

		this.holds.set(leg.mediaChannelId, {
			mediaChannelId: leg.mediaChannelId,
			bridgeId,
			peerMediaChannelId,
			peerLegId: this.deps.host.legFor(peerMediaChannelId ?? "")?.legId,
			signalled,
			heldAtMs: this.now(),
		});

		leg.addFlag("hold");
		leg.moveCallStateTo("held");
		await this.publishQuietly(leg, "channel.held", {
			legId: leg.legId,
			...(request.musicOnHold === undefined ? {} : { mohClass: request.musicOnHold }),
		});
		return ok();
	}

	/**
	 * Puts the leg back where it was.
	 *
	 * A leg whose bridge has gone in the meantime — the other party hung up while it was held — is
	 * reported rather than silently left listening to music: there is nothing to return it to, and
	 * an application that asked for an unhold needs to know it got a call with nobody on it.
	 */
	async unhold(leg: ControlledLeg): Promise<CallControlResult> {
		const held = this.holds.get(leg.mediaChannelId);
		if (held === undefined) {
			return refuse("the leg is not on hold");
		}
		this.holds.delete(leg.mediaChannelId);

		try {
			await this.deps.media.stopMusicOnHold(leg.mediaChannelId);
		} catch {
			// Stopping music that is not playing is a no-op everywhere it matters.
		}
		if (held.signalled) {
			try {
				await this.deps.media.unhold(leg.mediaChannelId);
			} catch (error) {
				this.log("the far end could not be told the hold was released", {
					mediaChannelId: leg.mediaChannelId,
					err: String(error),
				});
			}
		}

		leg.removeFlag("hold");
		// `held → unheld → active`: the transient state exists so a watcher can tell "resumed" from
		// "was never held", and the machine refuses to skip it.
		leg.moveCallStateTo("unheld");
		await this.publishQuietly(leg, "channel.unheld", { legId: leg.legId });

		if (held.bridgeId === undefined) {
			leg.moveCallStateTo("active");
			return ok("the leg was not bridged when it was held");
		}
		try {
			await this.deps.media.addToBridge(held.bridgeId, [leg.mediaChannelId]);
		} catch (error) {
			return refuse(`the leg could not be returned to its bridge: ${String(error)}`);
		}
		leg.setBridge(held.bridgeId);
		leg.moveCallStateTo("active");
		leg.moveTo("exchanging-media");
		return ok();
	}

	// -------------------------------------------------------------------------------------------
	// Park
	// -------------------------------------------------------------------------------------------

	/**
	 * Puts the leg in an orbit slot, where anybody can collect it by dialling the slot number.
	 *
	 * ## The claim is taken before the media moves
	 *
	 * `ParkRegistry.park` is synchronous and exclusive, so by the time a single byte of media has
	 * moved the slot is either this call's or the operation has already been refused. The reverse
	 * order — move the call, then look for a slot — produces a caller sitting in silence while the
	 * engine discovers the lot is full.
	 *
	 * ## The parker is remembered, and the timeout is why
	 *
	 * A call nobody collects must come BACK to whoever put it there, and by then that person's leg
	 * is usually gone. So the parker's NUMBER is stored, not their leg, and the timeout re-routes
	 * the parked call to it through the ordinary routing path — which rings their phone exactly as
	 * a new call would, including their forwarding rules and their voicemail.
	 */
	async park(leg: ControlledLeg, request: ParkRequest = {}): Promise<ParkOutcome> {
		const refusal = this.refuseIfUnusable(leg, "park");
		if (refusal !== undefined) {
			return { result: refusal };
		}
		if (this.deps.parks.forChannel(leg.mediaChannelId) !== undefined) {
			return { result: refuse("the leg is already parked") };
		}

		const lot = await this.deps.host.parkLotFor(leg, request.lot);
		if (lot === undefined) {
			return {
				result: refuse(
					request.lot === undefined
						? "this organization has no park lot"
						: `park lot "${request.lot}" is not in this organization's routing artifact`,
				),
			};
		}

		const preferred =
			request.orbit === undefined ? undefined : parkSlotFor(lot, request.orbit.trim());
		if (request.orbit !== undefined && preferred === undefined) {
			return { result: refuse(`orbit ${request.orbit} is not a slot in this lot`) };
		}

		const parker = request.parkedBy ?? this.peerOf(leg);
		const mohClass = request.musicOnHold ?? lot.mohClass;
		let state: ParkState = INITIAL_PARK_STATE;
		const claim = await this.deps.parks.park(
			lot,
			{
				parkLotId: lot.parkLotId,
				mediaChannelId: leg.mediaChannelId,
				legId: leg.legId,
				callId: leg.callId,
				organizationId: leg.organizationId,
				...(parker?.legId === undefined ? {} : { parkedByLegId: parker.legId }),
				...(parker?.callerIdNumber === undefined ? {} : { parkedByNumber: parker.callerIdNumber }),
				parkedAtMs: this.now(),
				...(mohClass === undefined ? {} : { mohClass }),
			},
			preferred,
		);

		if (claim.kind !== "parked") {
			assertParkTransition(state, "failed");
			return { result: refuse(parkRefusal(claim)) };
		}

		// Out of the bridge, and out of the peer relationship: the parker hanging up must NOT take
		// the parked caller with them, and `endBridgePeer` reads exactly that variable to decide.
		const bridgeId = leg.bridgeId;
		try {
			if (bridgeId !== undefined) {
				await this.deps.media.removeFromBridge(bridgeId, [leg.mediaChannelId]);
			}
			await this.deps.media.startMusicOnHold(leg.mediaChannelId, claim.entry.mohClass);
		} catch (error) {
			await this.deps.parks.release(leg.mediaChannelId);
			assertParkTransition(state, "failed");
			return { result: refuse(`the call could not be moved into the lot: ${String(error)}`) };
		}

		state = "parked";
		assertParkTransition(INITIAL_PARK_STATE, state);
		this.parkStates.set(leg.mediaChannelId, state);

		leg.setBridge(undefined);
		leg.setBridgePeer(undefined);
		parker?.setBridgePeer(undefined);
		leg.addFlag("park");
		leg.moveTo("parked");
		leg.moveCallStateTo("held");

		const timeoutMs = this.parkTimeoutMs(lot, request.timeoutMs);
		if (timeoutMs > 0) {
			this.armParkTimeout(claim.entry, timeoutMs);
		}

		await this.publishQuietly(leg, "call.parked", {
			legId: leg.legId,
			parkLotId: lot.parkLotId,
			slot: String(claim.entry.slot),
			...(timeoutMs > 0 ? { timeoutMs } : {}),
			...(claim.entry.parkedByLegId === undefined
				? {}
				: { parkedByLegId: claim.entry.parkedByLegId }),
			...(claim.entry.mohClass === undefined ? {} : { mohClass: claim.entry.mohClass }),
		});

		return { result: ok(), slot: claim.entry.slot, parkLotId: lot.parkLotId };
	}

	/**
	 * Collects a parked call onto this leg.
	 *
	 * The claim is exclusive (see `ParkRegistry.claim`), so two extensions dialling one orbit
	 * produce one connection and one honest "that call is no longer parked" — never two legs
	 * bridged to one caller.
	 *
	 * ## Three ways this ends, and only the first is local
	 *
	 * A park lot is addressed by number from every phone in the building, and the phone that dials
	 * 401 lands on whichever engine instance is handling ITS call — which is very often not the one
	 * holding the caller. So:
	 *
	 * - the orbit is held HERE → the bridge is built here, below. Untouched, and the fast path.
	 * - the orbit is held by a LIVE instance → {@link CallControl.unparkFromOwner} asks that
	 *   instance to hand the call over.
	 * - the orbit is held by an instance that stopped heartbeating →
	 *   {@link CallControl.unparkFromDeadOwner} takes the claim and tries to collect the channel it
	 *   left behind.
	 */
	async unpark(leg: ControlledLeg, request: UnparkRequest = {}): Promise<CallControlResult> {
		const refusal = this.refuseIfUnusable(leg, "unpark");
		if (refusal !== undefined) {
			return refusal;
		}
		if (request.orbit === undefined || request.orbit.trim() === "") {
			return refuse("an orbit is required: there is no retrieve-whatever-is-oldest");
		}

		const slot = Number.parseInt(request.orbit.trim(), 10);
		const lot =
			request.lot === undefined
				? await this.deps.host.parkLotForSlot(leg, slot)
				: await this.deps.host.parkLotFor(leg, request.lot);
		if (lot === undefined || parkSlotFor(lot, request.orbit.trim()) === undefined) {
			return refuse(`orbit ${request.orbit} is not a slot in any of this organization's lots`);
		}

		const claimed = await this.deps.parks.claim(lot.parkLotId, slot, leg.organizationId);
		if (claimed.kind === "elsewhere") {
			return await this.unparkFromOwner(leg, slot, claimed.instanceId, claimed.entry);
		}
		if (claimed.kind === "stale") {
			return await this.unparkFromDeadOwner(leg, slot, claimed.instanceId, claimed.entry);
		}
		if (claimed.kind !== "claimed") {
			return refuse(`nothing is parked on orbit ${String(slot)}`);
		}
		const parked = claimed.entry;
		this.transitionPark(parked.mediaChannelId, "retrieving");
		this.cancelParkTimeout(parked.mediaChannelId);

		const parkedLeg = this.deps.host.legFor(parked.mediaChannelId);
		if (parkedLeg === undefined || parkedLeg.isTearingDown) {
			// The caller went away between the claim and this lookup. Nothing to put back.
			this.transitionPark(parked.mediaChannelId, "abandoned");
			this.parkStates.delete(parked.mediaChannelId);
			return refuse(`the call on orbit ${String(slot)} has already gone`);
		}

		const bridgeId = this.newId();
		try {
			await this.deps.media.stopMusicOnHold(parked.mediaChannelId);
			await this.deps.media.createBridge({ bridgeId, name: `unpark-${parked.callId}` });
			await this.deps.media.addToBridge(bridgeId, [leg.mediaChannelId, parked.mediaChannelId]);
		} catch (error) {
			// Put the caller back in their own slot rather than stranding them: the park machine's
			// `retrieving → parked` edge exists for exactly this.
			if (await this.deps.parks.restore(parked)) {
				this.transitionPark(parked.mediaChannelId, "parked");
				await this.deps.media
					.startMusicOnHold(parked.mediaChannelId, parked.mohClass)
					.catch(() => undefined);
			}
			return refuse(`the parked call could not be connected: ${String(error)}`);
		}

		this.transitionPark(parked.mediaChannelId, "retrieved");
		this.parkStates.delete(parked.mediaChannelId);

		parkedLeg.removeFlag("park");
		parkedLeg.setBridge(bridgeId);
		parkedLeg.moveTo("exchanging-media");
		parkedLeg.moveCallStateTo("unheld");
		parkedLeg.moveCallStateTo("active");
		leg.setBridge(bridgeId);
		leg.moveTo("exchanging-media");
		// Both directions, while both legs are up: each CDR carries the other's id whichever dies
		// first. The same rule the plan walker's bridge follows.
		leg.setBridgePeer(parkedLeg.legId);
		parkedLeg.setBridgePeer(leg.legId);

		await this.publishQuietly(parkedLeg, "call.unparked", {
			legId: parkedLeg.legId,
			parkLotId: parked.parkLotId,
			slot: String(parked.slot),
			reason: "retrieved" satisfies ParkEndReason,
			retrievedByLegId: leg.legId,
			durationMs: Math.max(0, this.now() - parked.parkedAtMs),
		});
		await this.publishQuietly(leg, "channel.bridged", {
			legId: leg.legId,
			peerLegId: parkedLeg.legId,
			bridgeId,
			mode: "full",
		});
		return ok(`retrieved orbit ${String(parked.slot)}`);
	}

	/**
	 * Collects a call parked on ANOTHER live engine instance.
	 *
	 * ## The owner does the media, and this side only bookkeeps
	 *
	 * The request carries this leg's channel and a bridge id, and the owning instance builds the
	 * whole bridge — stops the hold music, creates the bridge, puts both channels in it. See the
	 * note on `parkHandoffRequestSchema` for why the work is not split across the two instances: a
	 * split needs a second round trip to undo the first, and until it lands the caller is out of the
	 * lot and in a bridge with nobody in it.
	 *
	 * What is left here is exactly what only this process can do — move its own leg's state machine
	 * and record who it ended up talking to.
	 *
	 * ## Every failure is the retriever's to report
	 *
	 * The owner answers every request it dislikes, including the ones that mean "you were too late".
	 * A SILENCE is different in kind: it means the owner died between the claim read and now, and
	 * this leg is told the call could not be reached rather than that it is gone — because it may
	 * well not be, and the next attempt takes the stale-owner path instead.
	 */
	private async unparkFromOwner(
		leg: ControlledLeg,
		slot: number,
		ownerInstanceId: string,
		parked: ParkedCall,
	): Promise<CallControlResult> {
		const client = this.deps.parkHandoff;
		if (client === undefined) {
			// No handoff transport wired: a single-instance deployment, or a spec. The honest answer
			// is the one this method replaced, and it is still the honest answer.
			return refuse(
				`the call on orbit ${String(slot)} is parked on another engine instance (${ownerInstanceId}) and cannot be retrieved from here`,
			);
		}

		const bridgeId = this.newId();
		let response: ParkHandoffResponse;
		try {
			response = await client.handoff(ownerInstanceId, {
				orgId: leg.organizationId,
				parkLotId: parked.parkLotId,
				slot,
				mediaChannelId: parked.mediaChannelId,
				retrieverInstanceId: this.deps.parks.instanceId,
				retrieverMediaChannelId: leg.mediaChannelId,
				retrieverLegId: leg.legId,
				bridgeId,
			});
		} catch (error) {
			this.log("a park handoff got no answer", {
				parkLotId: parked.parkLotId,
				slot,
				ownerInstanceId,
				err: String(error),
			});
			return refuse(
				`the engine holding orbit ${String(slot)} (${ownerInstanceId}) did not answer; the call could not be retrieved`,
			);
		}

		if (!response.ok) {
			this.log("a park handoff was refused", {
				parkLotId: parked.parkLotId,
				slot,
				ownerInstanceId,
				reason: response.reason,
			});
			return refuse(parkHandoffRefusal(slot, response.reason, response.error));
		}

		this.adoptHandedOffCall(leg, response.bridgeId ?? bridgeId, response.legId);
		await this.publishQuietly(leg, "channel.bridged", {
			legId: leg.legId,
			...(response.legId === undefined ? {} : { peerLegId: response.legId }),
			bridgeId: response.bridgeId ?? bridgeId,
			mode: "full",
		});
		return ok(`retrieved orbit ${String(slot)} from ${ownerInstanceId}`);
	}

	/**
	 * Collects a call whose owning instance stopped heartbeating.
	 *
	 * ## Why this is attempted at all, rather than reported as an empty slot
	 *
	 * Because the caller may still be there. An engine that died did not hang up the channels it was
	 * holding — under the ARI driver those channels belong to the media server, and a call parked
	 * with hold music goes on playing hold music to somebody who is still waiting to be collected.
	 * Answering "nothing is parked on 401" to the colleague who was told to pick it up abandons a
	 * live caller on the say-so of a missed heartbeat.
	 *
	 * ## What makes it safe
	 *
	 * Two things, in order. The claim is won with a compare-and-set first, so of two extensions
	 * dialling a dead instance's orbit exactly one proceeds. Then the channel is PROVED to exist on
	 * this instance's media server before anything is moved — which is also the check that keeps
	 * this honest across media servers: an engine behind a different Asterisk cannot see the channel
	 * and refuses, rather than building a bridge with one live participant.
	 *
	 * ## What is deliberately not done
	 *
	 * This instance does not adopt the orphan channel as a leg. It has no aggregate, no CDR and no
	 * state machine for it, and inventing one would file a second billing record for a call another
	 * instance already opened. The channel is bridged, the orbit is freed, and the pair is reported
	 * on the retriever's own leg — which is the leg that has a CDR to carry it.
	 */
	private async unparkFromDeadOwner(
		leg: ControlledLeg,
		slot: number,
		deadInstanceId: string,
		parked: ParkedCall,
	): Promise<CallControlResult> {
		if (!(await this.deps.parks.takeOverStale(parked))) {
			// Renewed, re-taken, or collected by whoever raced us here.
			return refuse(`nothing is parked on orbit ${String(slot)}`);
		}

		let reachable = false;
		try {
			reachable = await this.deps.media.channelExists(parked.mediaChannelId);
		} catch {
			reachable = false;
		}
		if (!reachable) {
			// The dead instance took the call with it, or it is on a media server this one cannot
			// see. Either way the orbit is holding nobody, so it is freed rather than left to expire.
			await this.deps.parks.discard(parked.organizationId, parked.parkLotId, slot);
			return refuse(
				`the call on orbit ${String(slot)} was parked by an engine that has gone (${deadInstanceId}) and is no longer reachable`,
			);
		}

		const bridgeId = this.newId();
		try {
			await this.deps.media.stopMusicOnHold(parked.mediaChannelId);
			await this.deps.media.createBridge({ bridgeId, name: `unpark-${parked.callId}` });
			await this.deps.media.addToBridge(bridgeId, [leg.mediaChannelId, parked.mediaChannelId]);
		} catch (error) {
			// No `restore` here, unlike the local path: restoring means putting the call back under a
			// claim this instance would then have to heartbeat for a leg it does not hold. The claim
			// is dropped instead, which leaves the channel exactly as the dead instance left it and
			// the orbit free for the next park.
			await this.deps.parks.discard(parked.organizationId, parked.parkLotId, slot);
			return refuse(`the parked call could not be connected: ${String(error)}`);
		}

		await this.deps.parks.discard(parked.organizationId, parked.parkLotId, slot);
		this.adoptHandedOffCall(leg, bridgeId, parked.legId);
		this.log("collected a call from an engine that stopped heartbeating", {
			parkLotId: parked.parkLotId,
			slot,
			deadInstanceId,
			mediaChannelId: parked.mediaChannelId,
		});
		await this.publishQuietly(leg, "channel.bridged", {
			legId: leg.legId,
			peerLegId: parked.legId,
			bridgeId,
			mode: "full",
		});
		return ok(`retrieved orbit ${String(slot)} from ${deadInstanceId}`);
	}

	/**
	 * Answers `rpc.engine.v1.park-handoff`: hands a call THIS instance has parked to another one.
	 *
	 * ## Guard first, then claim, then move — and never the other way round
	 *
	 * Every check that can be made without disturbing anything is made before the park is taken out
	 * of the registry: the orbit is held here, it is held by the channel the requester named, it
	 * belongs to the requester's tenant, its leg is alive, and the requester's own channel is
	 * visible to this media server. A refusal at any of those leaves the caller exactly where they
	 * were, still collectable by the next person to dial the orbit.
	 *
	 * The claim is only released once all of that holds, and the release is what settles the race
	 * against a LOCAL retrieval happening at the same instant — `ParkRegistry.claim` removes before
	 * it returns, so one of the two gets the entry and the other gets `not_parked`.
	 *
	 * ## Never throws
	 *
	 * The caller is a NATS subscription handler. An unhandled rejection there ends the subscription
	 * and this instance stops answering handoffs for every parked call it holds, silently, until
	 * somebody notices calls stuck in lots.
	 */
	async acceptParkHandoff(request: ParkHandoffRequest): Promise<ParkHandoffResponse> {
		const base = {
			parkLotId: request.parkLotId,
			slot: request.slot,
			instanceId: this.deps.parks.instanceId,
		} as const;
		const deny = (reason: ParkHandoffRefusalReason, error?: string): ParkHandoffResponse => ({
			...base,
			ok: false,
			reason,
			...(error === undefined ? {} : { error }),
		});

		try {
			const occupant = this.deps.parks.at(request.parkLotId, request.slot);
			if (occupant === undefined) {
				return deny("not_parked", "this instance holds no park on that orbit");
			}
			if (occupant.organizationId !== request.orgId) {
				// A cross-tenant request. Answered as though the orbit were empty on purpose: the
				// requester learns nothing about another organization's lot, and there is no honest
				// sense in which the call it asked for is there.
				return deny("not_parked", "this instance holds no park on that orbit");
			}
			if (occupant.mediaChannelId !== request.mediaChannelId) {
				return deny(
					"claim_superseded",
					"the orbit holds a different call than the one the request named",
				);
			}

			const parkedLeg = this.deps.host.legFor(occupant.mediaChannelId);
			if (parkedLeg === undefined || parkedLeg.isTearingDown) {
				return deny("channel_gone", "the parked leg has gone");
			}

			let reachable = false;
			try {
				reachable = await this.deps.media.channelExists(request.retrieverMediaChannelId);
			} catch (error) {
				return deny("internal", `the retriever's channel could not be checked: ${String(error)}`);
			}
			if (!reachable) {
				return deny(
					"unreachable_channel",
					"this instance's media server does not know the retriever's channel",
				);
			}

			const claimed = await this.deps.parks.claim(request.parkLotId, request.slot, request.orgId);
			if (claimed.kind !== "claimed") {
				return deny("not_parked", "the call was collected while the handoff was in flight");
			}
			const parked = claimed.entry;

			this.transitionPark(parked.mediaChannelId, "retrieving");
			this.cancelParkTimeout(parked.mediaChannelId);

			try {
				await this.deps.media.stopMusicOnHold(parked.mediaChannelId);
				await this.deps.media.createBridge({
					bridgeId: request.bridgeId,
					name: `unpark-${parked.callId}`,
				});
				await this.deps.media.addToBridge(request.bridgeId, [
					parked.mediaChannelId,
					request.retrieverMediaChannelId,
				]);
			} catch (error) {
				// Same recovery as a local retrieval: back in the orbit, music on, still collectable.
				if (await this.deps.parks.restore(parked)) {
					this.transitionPark(parked.mediaChannelId, "parked");
					await this.deps.media
						.startMusicOnHold(parked.mediaChannelId, parked.mohClass)
						.catch(() => undefined);
				}
				return deny("media_failed", String(error));
			}

			this.transitionPark(parked.mediaChannelId, "retrieved");
			this.parkStates.delete(parked.mediaChannelId);

			parkedLeg.removeFlag("park");
			parkedLeg.setBridge(request.bridgeId);
			parkedLeg.moveTo("exchanging-media");
			parkedLeg.moveCallStateTo("unheld");
			parkedLeg.moveCallStateTo("active");
			parkedLeg.setBridgePeer(request.retrieverLegId);

			await this.publishQuietly(parkedLeg, "call.unparked", {
				legId: parkedLeg.legId,
				parkLotId: parked.parkLotId,
				slot: String(parked.slot),
				reason: "retrieved" satisfies ParkEndReason,
				retrievedByLegId: request.retrieverLegId,
				durationMs: Math.max(0, this.now() - parked.parkedAtMs),
			});
			this.log("handed a parked call to another engine instance", {
				parkLotId: parked.parkLotId,
				slot: parked.slot,
				retrieverInstanceId: request.retrieverInstanceId,
			});

			return {
				...base,
				ok: true,
				bridgeId: request.bridgeId,
				legId: parkedLeg.legId,
				callId: parked.callId,
				parkedAtMs: parked.parkedAtMs,
			};
		} catch (error) {
			return deny("internal", String(error));
		}
	}

	/**
	 * Puts this leg into a bridge somebody else built.
	 *
	 * Both cross-instance paths end here, and neither of them touches the parked leg's state —
	 * that leg belongs to another process (or, for a dead owner, to no process at all). The peer
	 * link is therefore recorded in ONE direction, which is the honest half: this leg's CDR names
	 * who it was connected to, and the other leg's CDR is the owning instance's to write.
	 */
	private adoptHandedOffCall(
		leg: ControlledLeg,
		bridgeId: string,
		peerLegId: string | undefined,
	): void {
		leg.setBridge(bridgeId);
		leg.moveTo("exchanging-media");
		if (peerLegId !== undefined) {
			leg.setBridgePeer(peerLegId);
		}
	}

	// -------------------------------------------------------------------------------------------
	// Transfer
	// -------------------------------------------------------------------------------------------

	/**
	 * Hands the call to a new party.
	 *
	 * ## Blind
	 *
	 * The TRANSFEREE — the party on the other side of the transferor's bridge — is the one that
	 * moves. They are taken out of the bridge, given hold music, and re-routed through the ordinary
	 * routing path, which is what makes the resulting call produce a proper B-leg with its own CDR,
	 * honour the destination's forwarding rules, and fall through to its voicemail like any other
	 * call. The transferor is hung up with `BLIND_TRANSFER` (800) so a report can tell a handover
	 * from an abandoned call.
	 *
	 * The music stops at the moment of bridging rather than before the walk starts
	 * ({@link RouteRequest.beforeBridge}), so a transferee hears music for the whole time the target
	 * is ringing instead of silence.
	 *
	 * ## Attended
	 *
	 * This method performs the CONSULTATION half only: the transferee is held, and the transferor is
	 * routed to the destination so the two of them can talk. The transfer then waits — in
	 * `consulting` — for {@link completeTransfer} or {@link cancelTransfer}, and the orchestrator
	 * calls the first of those when the transferor hangs up, which is the classic semantics.
	 */
	async transfer(leg: ControlledLeg, request: TransferRequest): Promise<CallControlResult> {
		const refusal = this.refuseIfUnusable(leg, "transfer");
		if (refusal !== undefined) {
			return refusal;
		}
		const destination = request.destination.trim();
		if (destination === "") {
			return refuse("a transfer needs a destination");
		}
		if (this.consultations.has(leg.mediaChannelId)) {
			return refuse("this leg already has a transfer in progress");
		}

		const transferee = this.peerOf(leg);
		if (transferee === undefined) {
			return refuse("the leg is not bridged to anybody, so there is nobody to transfer");
		}

		let state: TransferState = INITIAL_TRANSFER_STATE;
		const context = request.context ?? this.settings.transferContext;

		if (request.kind === "blind") {
			state = "completing";
			assertTransferTransition(INITIAL_TRANSFER_STATE, state);
			return await this.completeBlindTransfer(leg, transferee, destination, context, request);
		}

		state = "held";
		assertTransferTransition(INITIAL_TRANSFER_STATE, state);
		const held = await this.hold(transferee, { soft: true });
		if (!held.ok) {
			return refuse(`the transferee could not be held: ${held.reason}`);
		}
		transferee.moveTo("hibernating");

		const consultation: Consultation = {
			state,
			kind: "attended",
			transferorMediaChannelId: leg.mediaChannelId,
			transfereeMediaChannelId: transferee.mediaChannelId,
			destination,
			context,
			...(request.fallbackDestination === undefined
				? {}
				: { fallbackDestination: request.fallbackDestination }),
			startedAtMs: this.now(),
			// A transferee who hangs up while on hold ends the transfer: there is nobody left to hand
			// over, and a consultation that continued would connect the transferor to a target for a
			// call that no longer exists.
			stopWatching: this.deps.signals.watch(legSignalKey(transferee.mediaChannelId), (signal) => {
				if ((signal as LegSignal).kind === "ended") {
					void this.abandonConsultation(leg.mediaChannelId, "the transferee hung up");
				}
			}),
		};
		this.consultations.set(leg.mediaChannelId, consultation);
		leg.addFlag("attended-transfer");
		if (request.cancelKey !== undefined) {
			this.deps.consultationKeys?.arm(leg.mediaChannelId, request.cancelKey);
		}

		const route = await this.deps.host.route(leg, {
			destination,
			context,
			...(leg.callerIdNumber === undefined ? {} : { callerIdNumber: leg.callerIdNumber }),
			...(leg.callerIdName === undefined ? {} : { callerIdName: leg.callerIdName }),
		});

		const pending = this.consultations.get(leg.mediaChannelId);
		if (pending === undefined) {
			// The transferee hung up while the target was ringing; the consultation is already gone.
			return refuse("the transfer was abandoned while the consultation was being set up");
		}
		if (route.status !== "bridged") {
			pending.state = "failed";
			assertTransferTransition("held", "failed");
			await this.dropConsultation(leg.mediaChannelId);
			const returned = await this.unhold(transferee);
			return refuse(
				`the consultation to ${destination} did not connect (${route.status}); the transferee was ${
					returned.ok ? "returned to the transferor" : `left on hold: ${returned.reason}`
				}`,
			);
		}

		pending.state = "consulting";
		assertTransferTransition("held", "consulting");
		return ok(`consulting ${destination}`);
	}

	/**
	 * Finishes an attended transfer: the transferee is joined to the consultation target.
	 *
	 * The transferee is added to the bridge the CONSULTATION is already in rather than a new one,
	 * which means the target's media never stops — the person who agreed to take the call does not
	 * hear a gap while the switch rearranges things.
	 *
	 * The transferor's bridge-peer link is cleared first. Without that, the orchestrator's
	 * `endBridgePeer` would follow the transferor's hangup straight to the target and hang up the
	 * very leg the transfer just handed the call to.
	 */
	async completeTransfer(leg: ControlledLeg): Promise<CallControlResult> {
		const consultation = this.consultations.get(leg.mediaChannelId);
		if (consultation === undefined) {
			return refuse("this leg has no transfer in progress");
		}
		if (consultation.state !== "consulting" && consultation.state !== "held") {
			return refuse(`the transfer is ${consultation.state}, not waiting to be completed`);
		}

		const transferee = this.deps.host.legFor(consultation.transfereeMediaChannelId);
		const target = this.peerOf(leg);
		const bridgeId = leg.bridgeId;

		if (transferee === undefined || transferee.isTearingDown) {
			consultation.state = "failed";
			await this.dropConsultation(leg.mediaChannelId);
			return refuse("the transferee is gone; there is nobody left to hand over");
		}
		if (target === undefined || bridgeId === undefined) {
			consultation.state = "failed";
			assertTransferTransition("consulting", "failed");
			await this.dropConsultation(leg.mediaChannelId);
			const rescued = await this.rescueTransferee(leg, transferee, consultation);
			if (rescued !== undefined) {
				return rescued;
			}
			const returned = await this.unhold(transferee);
			return refuse(
				`the consultation leg is gone; the transferee was ${
					returned.ok ? "returned to the transferor" : `left on hold: ${returned.reason}`
				}`,
			);
		}

		consultation.state = "completing";
		assertTransferTransition("consulting", "completing");

		// The transferee stops hearing music and joins the consultation's own bridge.
		this.holds.delete(transferee.mediaChannelId);
		try {
			await this.deps.media.stopMusicOnHold(transferee.mediaChannelId);
			await this.deps.media.addToBridge(bridgeId, [transferee.mediaChannelId]);
		} catch (error) {
			consultation.state = "failed";
			assertTransferTransition("completing", "failed");
			await this.dropConsultation(leg.mediaChannelId);
			const rescued = await this.rescueTransferee(leg, transferee, consultation);
			if (rescued !== undefined) {
				return rescued;
			}
			return refuse(`the transferee could not be joined to the target: ${String(error)}`);
		}

		transferee.removeFlag("hold");
		transferee.setBridge(bridgeId);
		transferee.moveTo("exchanging-media");
		transferee.moveCallStateTo("unheld");
		transferee.moveCallStateTo("active");
		transferee.setBridgePeer(target.legId);
		target.setBridgePeer(transferee.legId);
		// Cleared LAST, and this is the load-bearing line: the transferor is about to die and must
		// not take the target with it.
		leg.setBridgePeer(undefined);
		leg.setBridge(undefined);
		leg.markHangup(hangupCauseForTransfer(consultation.kind));

		consultation.state = "completed";
		assertTransferTransition("completing", "completed");
		await this.dropConsultation(leg.mediaChannelId);

		await this.publishQuietly(transferee, "call.transferred", {
			legId: transferee.legId,
			kind: consultation.kind satisfies TransferKind,
			destination: consultation.destination,
			routingContext: consultation.context,
			transferorLegId: leg.legId,
			targetLegId: target.legId,
		});
		return ok(`transferred to ${consultation.destination}`);
	}

	/** Abandons an attended transfer and puts the transferee back with the transferor. */
	async cancelTransfer(leg: ControlledLeg): Promise<CallControlResult> {
		const consultation = this.consultations.get(leg.mediaChannelId);
		if (consultation === undefined) {
			return refuse("this leg has no transfer in progress");
		}
		const from = consultation.state;
		consultation.state = "cancelled";
		assertTransferTransition(from, "cancelled");
		await this.dropConsultation(leg.mediaChannelId);

		// The consultation leg goes first, so the target's phone stops before the original party is
		// put back and hears them being hung up on.
		const target = this.peerOf(leg);
		if (target !== undefined) {
			target.markHangup("ORIGINATOR_CANCEL");
			await this.hangupQuietly(target.mediaChannelId, "ORIGINATOR_CANCEL");
		}

		const transferee = this.deps.host.legFor(consultation.transfereeMediaChannelId);
		if (transferee === undefined) {
			return ok("the transfer was cancelled; the transferee had already gone");
		}
		const returned = await this.unhold(transferee);
		return returned.ok
			? ok("the transfer was cancelled and the original call restored")
			: refuse(
					`the transfer was cancelled but the original call could not be restored: ${returned.reason}`,
				);
	}

	private async completeBlindTransfer(
		transferor: ControlledLeg,
		transferee: ControlledLeg,
		destination: string,
		context: string,
		request: TransferRequest,
	): Promise<CallControlResult> {
		const held = await this.hold(transferee, { soft: true });
		if (!held.ok) {
			return refuse(`the transferee could not be held for the transfer: ${held.reason}`);
		}
		// Cleared BEFORE the transferor is hung up: `endBridgePeer` would otherwise follow the
		// transferor's teardown straight into the call it just handed over.
		transferee.setBridgePeer(undefined);
		transferor.setBridgePeer(undefined);
		transferee.addFlag("transfer");
		transferee.moveTo("routing");

		transferor.markHangup(hangupCauseForTransfer("blind"));
		await this.hangupQuietly(transferor.mediaChannelId, hangupCauseForTransfer("blind"));

		const outcome = await this.routeTransferee(transferee, destination, context);
		if (outcome.status === "bridged") {
			await this.publishQuietly(transferee, "call.transferred", {
				legId: transferee.legId,
				kind: "blind" satisfies TransferKind,
				destination,
				routingContext: context,
				transferorLegId: transferor.legId,
			});
			return ok(`transferred to ${destination}`);
		}

		const fallback = request.fallbackDestination?.trim();
		if (fallback !== undefined && fallback !== "" && !transferee.isTearingDown) {
			const second = await this.routeTransferee(transferee, fallback, context);
			if (second.status === "bridged") {
				await this.publishQuietly(transferee, "call.transferred", {
					legId: transferee.legId,
					kind: "blind" satisfies TransferKind,
					destination: fallback,
					routingContext: context,
					transferorLegId: transferor.legId,
				});
				return ok(`transferred to the fallback destination ${fallback}`);
			}
		}
		return refuse(
			`the transferee could not be routed to ${destination} (${outcome.status}); the routing walk ended the call`,
		);
	}

	/**
	 * The transferee's last resort when an ATTENDED transfer falls apart at completion.
	 *
	 * `completeTransfer` has exactly one production caller — {@link CallControl.onLegEnded}, the
	 * transferor hanging up, which is the classic completion signal. So every failure inside it is
	 * a failure with **nobody left to hand the caller back to**: the "the transferee was returned
	 * to the transferor" repair below unholds them onto a leg that is at that moment being
	 * destroyed, and what the caller hears is silence and then a dropped call.
	 *
	 * That is precisely the case `transfer_fallback_extension` names, and it is the only place an
	 * attended transfer has one. A CONSULTATION that never connects is not this case — there the
	 * transferor is still on the line and is the best possible fallback, so `transfer()` keeps
	 * returning the transferee to them and does not come through here.
	 *
	 * `undefined` means "no rescue was attempted"; the caller then falls through to its own repair.
	 */
	private async rescueTransferee(
		transferor: ControlledLeg,
		transferee: ControlledLeg,
		consultation: Consultation,
	): Promise<CallControlResult | undefined> {
		const fallback = consultation.fallbackDestination?.trim();
		if (fallback === undefined || fallback === "") {
			return undefined;
		}
		if (transferee.isTearingDown) {
			return undefined;
		}

		transferee.setBridgePeer(undefined);
		transferee.addFlag("transfer");
		transferee.moveTo("routing");

		const outcome = await this.routeTransferee(transferee, fallback, consultation.context);
		if (outcome.status !== "bridged") {
			return refuse(
				`the transfer failed and the fallback destination ${fallback} could not be reached (${outcome.status})`,
			);
		}
		await this.publishQuietly(transferee, "call.transferred", {
			legId: transferee.legId,
			kind: consultation.kind satisfies TransferKind,
			destination: fallback,
			routingContext: consultation.context,
			transferorLegId: transferor.legId,
		});
		return ok(
			`the transfer failed; the transferee was sent to the fallback destination ${fallback}`,
		);
	}

	/** Routes a held transferee, stopping their hold music at the exact moment they are bridged. */
	private async routeTransferee(
		transferee: ControlledLeg,
		destination: string,
		context: string,
	): Promise<RouteOutcome> {
		return await this.deps.host.route(transferee, {
			destination,
			context,
			...(transferee.callerIdNumber === undefined
				? {}
				: { callerIdNumber: transferee.callerIdNumber }),
			...(transferee.callerIdName === undefined ? {} : { callerIdName: transferee.callerIdName }),
			beforeBridge: async () => {
				this.holds.delete(transferee.mediaChannelId);
				transferee.removeFlag("hold");
				transferee.moveCallStateTo("unheld");
				transferee.moveCallStateTo("active");
				try {
					await this.deps.media.stopMusicOnHold(transferee.mediaChannelId);
				} catch {
					// Stopping music that is not playing is a no-op.
				}
			},
		});
	}

	private async abandonConsultation(
		transferorMediaChannelId: string,
		reason: string,
	): Promise<void> {
		const consultation = this.consultations.get(transferorMediaChannelId);
		if (consultation === undefined) {
			return;
		}
		consultation.state = "failed";
		await this.dropConsultation(transferorMediaChannelId);
		this.holds.delete(consultation.transfereeMediaChannelId);
		this.log("an attended transfer was abandoned", { transferorMediaChannelId, reason });
	}

	private async dropConsultation(transferorMediaChannelId: string): Promise<void> {
		const consultation = this.consultations.get(transferorMediaChannelId);
		if (consultation === undefined) {
			return;
		}
		consultation.stopWatching();
		this.consultations.delete(transferorMediaChannelId);
		// Always, whichever way the consultation ended. A key left armed swallows that digit for the
		// rest of the call, and the party has no way to recover short of hanging up.
		this.deps.consultationKeys?.disarm(transferorMediaChannelId);
		await Promise.resolve();
	}

	// -------------------------------------------------------------------------------------------
	// Pickup
	// -------------------------------------------------------------------------------------------

	/**
	 * Answers a call that is ringing somewhere else.
	 *
	 * ## Three legs, and the one that matters is not the ringing one
	 *
	 * The ringing phone is a B-leg the switch dialled; the person on the line is its A-leg. A pickup
	 * therefore connects the picker to the A-LEG and hangs the B-leg up with `PICKED_OFF` (805) —
	 * not with `NO_ANSWER`, which would put the picked-up call in the missed-call report of the
	 * person whose phone was ringing.
	 *
	 * ## The original walk has to be told
	 *
	 * The A-leg is in the middle of a routing walk that is waiting for exactly the B-leg this method
	 * is about to kill. Without {@link ControlledLeg.detach} that walk sees a failed dial, takes the
	 * no-answer branch, and sends a caller who is already talking to somebody to voicemail. Detaching
	 * first is what makes a pickup a pickup rather than a race.
	 */
	async pickup(leg: ControlledLeg, request: PickupRequest): Promise<CallControlResult> {
		if (leg.isTearingDown) {
			return refuse("the leg is tearing down");
		}
		const extension = request.extension.trim();
		if (request.kind === "directed" && extension === "") {
			return refuse("a directed pickup needs the extension whose call is being taken");
		}

		const candidates = await this.deps.host.ringingFor(leg, extension);
		const candidate = candidates.find(
			(entry) => !entry.ringingLeg.isTearingDown && !entry.callerLeg.isTearingDown,
		);
		if (candidate === undefined) {
			return refuse(
				request.kind === "group"
					? "nothing is ringing in this pickup group"
					: `nothing is ringing at extension ${extension}`,
			);
		}

		// FIRST. See the method note.
		candidate.callerLeg.detach();
		candidate.ringingLeg.markHangup("PICKED_OFF");
		await this.hangupQuietly(candidate.ringingLeg.mediaChannelId, "PICKED_OFF");

		const bridgeId = this.newId();
		try {
			await this.deps.media.answer(leg.mediaChannelId);
			await this.deps.media.createBridge({
				bridgeId,
				name: `pickup-${candidate.callerLeg.callId}`,
			});
			await this.deps.media.addToBridge(bridgeId, [
				leg.mediaChannelId,
				candidate.callerLeg.mediaChannelId,
			]);
		} catch (error) {
			return refuse(`the picked-up call could not be connected: ${String(error)}`);
		}

		leg.setBridge(bridgeId);
		leg.moveTo("exchanging-media");
		candidate.callerLeg.setBridge(bridgeId);
		candidate.callerLeg.moveTo("exchanging-media");
		leg.setBridgePeer(candidate.callerLeg.legId);
		candidate.callerLeg.setBridgePeer(leg.legId);

		await this.publishQuietly(leg, "call.picked-up", {
			legId: leg.legId,
			pickedUpLegId: candidate.callerLeg.legId,
			kind: request.kind,
			extension: extension === "" ? (candidate.ringingLeg.destinationNumber ?? "") : extension,
			abandonedLegId: candidate.ringingLeg.legId,
		});
		await this.publishQuietly(leg, "channel.bridged", {
			legId: leg.legId,
			peerLegId: candidate.callerLeg.legId,
			bridgeId,
			mode: "full",
		});
		return ok(`picked up the call ringing at ${extension}`);
	}

	// -------------------------------------------------------------------------------------------
	// On-demand recording
	// -------------------------------------------------------------------------------------------

	/**
	 * Starts recording the conversation this leg is in.
	 *
	 * ## Why a tap and not `record` on the leg itself
	 *
	 * Recording a bridged channel directly captures one direction reliably and the other one
	 * depending on how the bridge is technologied — which is a coin flip you discover months later,
	 * from a compliance recording with only the customer audible. A snoop channel spying on `both`
	 * hears the mix, so the object always has two sides in it.
	 *
	 * ## The tap is subscribed to before it exists
	 *
	 * A snoop on a local channel reaches the application before the HTTP response returns, and a
	 * tap the orchestrator has never heard of is filed as a new inbound call. So the signal key is
	 * watched first — the same rule, and the same mechanism, that makes an originated B-leg safe.
	 *
	 * ## It files exactly the way voicemail does
	 *
	 * `channel.record.started` / `channel.record.stopped` carrying the same `objectKey` shape the
	 * voicemail path publishes, so the object-store uploader, the CDR's `recordingKey` and the
	 * signed-URL endpoint all work with no change. `kind` is `call` rather than `voicemail`, which
	 * is the only difference and is what the retention policy keys off.
	 *
	 * ## The media plane has to be holding samples
	 *
	 * A tap reads DECODED audio, so it is only possible on a bridge whose mode decodes — which is
	 * `media` and nothing else ({@link import("@optimiq-voice/telephony").supportsRecording}). The
	 * check is made here, against the driver's declared {@link MediaPort.bridgeMode}, rather than
	 * being discovered from whatever error a relay-only plane returns when asked to snoop: the two
	 * failures need different answers from an operator ("this media plane cannot record" is a
	 * deployment fact, "the media server refused a tap" is an incident) and only one of them is
	 * worth paging about.
	 */
	async startRecording(
		leg: ControlledLeg,
		request: StartRecordingRequest = {},
	): Promise<RecordingOutcome> {
		const refusal = this.refuseIfUnusable(leg, "record");
		if (refusal !== undefined) {
			return { result: refusal };
		}
		if (!supportsRecording(this.deps.media.bridgeMode)) {
			return {
				result: refuse(
					`this media plane bridges in ${this.deps.media.bridgeMode} mode, which never decodes the audio, so a call on it cannot be recorded`,
				),
			};
		}
		if (this.recordings.has(leg.mediaChannelId)) {
			return { result: refuse("this leg is already being recorded") };
		}

		const recordingId = this.newId();
		const format = request.format ?? this.settings.recordingFormat;
		const objectKey = `${leg.organizationId}/${leg.callId}/${recordingId}.${format}`;
		const snoopChannelId = this.newId();

		const entered = this.awaitLegEntered(snoopChannelId, this.settings.snoopTimeoutMs);
		try {
			await this.deps.media.snoop({
				channelId: leg.mediaChannelId,
				snoopChannelId,
				application: this.settings.application,
				spy: "both",
			});
		} catch (error) {
			entered.cancel();
			return { result: refuse(`the media server refused a tap on this leg: ${String(error)}`) };
		}

		if (!(await entered.promise)) {
			await this.hangupQuietly(snoopChannelId, "NORMAL_TEMPORARY_FAILURE");
			return { result: refuse("the tap never reached the engine's application") };
		}

		try {
			await this.deps.media.record(snoopChannelId, {
				name: recordingId,
				format,
				...(request.maxDurationMs === undefined
					? {}
					: { maxDurationSeconds: Math.ceil(request.maxDurationMs / MILLIS_PER_SECOND) }),
				...(request.silenceStopMs === undefined
					? {}
					: { maxSilenceSeconds: Math.ceil(request.silenceStopMs / MILLIS_PER_SECOND) }),
				...(request.beep === undefined ? {} : { beep: request.beep }),
				terminateOn: "none",
			});
		} catch (error) {
			await this.hangupQuietly(snoopChannelId, "NORMAL_TEMPORARY_FAILURE");
			return { result: refuse(`the recording could not be started: ${String(error)}`) };
		}

		this.recordings.set(leg.mediaChannelId, {
			recordingId,
			objectKey,
			snoopChannelId,
			format,
			startedAtMs: this.now(),
		});

		await this.publishQuietly(leg, "channel.record.started", {
			legId: leg.legId,
			recordingId,
			objectKey,
			kind: "call",
			stereo: false,
		});
		return { result: ok(), recordingId, objectKey };
	}

	/**
	 * Finalises the recording running on this leg.
	 *
	 * Waits for the media server's own "the object is closed" signal before publishing
	 * `channel.record.stopped`, with a backstop: the uploader is triggered by that event, and an
	 * event published before the file is flushed is a truncated recording nobody notices until it is
	 * played back.
	 */
	async stopRecording(leg: ControlledLeg): Promise<CallControlResult> {
		const session = this.recordings.get(leg.mediaChannelId);
		if (session === undefined) {
			return refuse("this leg is not being recorded");
		}
		this.recordings.delete(leg.mediaChannelId);

		const finished = this.awaitRecordingFinished(
			session.recordingId,
			this.settings.recordingStopTimeoutMs,
		);
		try {
			await this.deps.media.stopRecording(session.recordingId);
		} catch (error) {
			finished.cancel();
			this.log("the media server refused to stop a recording", {
				recordingId: session.recordingId,
				err: String(error),
			});
		}
		const outcome = await finished.promise;
		await this.hangupQuietly(session.snoopChannelId, "NORMAL_CLEARING");

		await this.publishQuietly(leg, "channel.record.stopped", {
			legId: leg.legId,
			recordingId: session.recordingId,
			objectKey: session.objectKey,
			durationMs:
				outcome.durationMs > 0 ? outcome.durationMs : Math.max(0, this.now() - session.startedAtMs),
			reason: outcome.reason,
		});
		return ok(session.recordingId);
	}

	// -------------------------------------------------------------------------------------------
	// Teardown
	// -------------------------------------------------------------------------------------------

	/**
	 * Releases everything this leg was holding.
	 *
	 * Called by the orchestrator on `ChannelDestroyed`, BEFORE the CDR is written, because two of
	 * these change what the CDR says: a completed attended transfer fixes the transferor's cause,
	 * and a stopped recording is what puts a `recordingKey` on the record.
	 */
	async onLegEnded(mediaChannelId: string): Promise<void> {
		const leg = this.deps.host.legFor(mediaChannelId);

		if (this.recordings.has(mediaChannelId) && leg !== undefined) {
			await this.stopRecording(leg);
		}

		// A transferor who hangs up mid-consultation IS the completion signal. This is the classic
		// attended-transfer semantics and the reason `completeTransfer` is reachable from here.
		if (this.consultations.has(mediaChannelId) && leg !== undefined) {
			const completed = await this.completeTransfer(leg);
			if (!completed.ok) {
				this.log("an attended transfer could not be completed on the transferor's hangup", {
					mediaChannelId,
					reason: completed.reason,
				});
				await this.dropConsultation(mediaChannelId);
			}
		}

		this.holds.delete(mediaChannelId);

		const parked = this.deps.parks.forChannel(mediaChannelId);
		if (parked !== undefined) {
			await this.deps.parks.release(mediaChannelId);
			this.cancelParkTimeout(mediaChannelId);
			this.transitionPark(mediaChannelId, "abandoned");
			this.parkStates.delete(mediaChannelId);
			if (leg !== undefined) {
				await this.publishQuietly(leg, "call.unparked", {
					legId: leg.legId,
					parkLotId: parked.parkLotId,
					slot: String(parked.slot),
					reason: "abandoned" satisfies ParkEndReason,
					durationMs: Math.max(0, this.now() - parked.parkedAtMs),
				});
			}
		}
	}

	/** Drops every operation. Used by the drain and by specs. Does not touch the media server. */
	clear(): void {
		for (const consultation of this.consultations.values()) {
			consultation.stopWatching();
		}
		for (const timer of this.parkTimers.values()) {
			timer.cancel();
		}
		this.consultations.clear();
		this.parkTimers.clear();
		this.holds.clear();
		this.recordings.clear();
		this.parkStates.clear();
	}

	// -------------------------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------------------------

	private armParkTimeout(entry: ParkedCall, timeoutMs: number): void {
		const timer = this.setTimer(() => {
			void this.returnParkedCall(entry);
		}, timeoutMs);
		this.parkTimers.set(entry.mediaChannelId, timer);
	}

	private cancelParkTimeout(mediaChannelId: string): void {
		this.parkTimers.get(mediaChannelId)?.cancel();
		this.parkTimers.delete(mediaChannelId);
	}

	/**
	 * The lot's timeout has elapsed: the call goes back to whoever parked it.
	 *
	 * Through the ordinary routing path rather than by re-bridging the parker's old leg, which is
	 * almost always gone by now. Routing the call to the parker's NUMBER rings their phone as a new
	 * call would — with their forwarding rules and their voicemail behind it — which is what a
	 * person who forgot a parked call actually needs.
	 *
	 * A lot with a timeout and no parker to return to leaves the call in its slot rather than
	 * hanging it up: the caller is still there and somebody may still collect them.
	 */
	private async returnParkedCall(entry: ParkedCall): Promise<void> {
		this.parkTimers.delete(entry.mediaChannelId);
		const claimed = await this.deps.parks.claim(entry.parkLotId, entry.slot, entry.organizationId);
		if (claimed.kind !== "claimed") {
			return;
		}
		const leg = this.deps.host.legFor(entry.mediaChannelId);
		if (leg === undefined || leg.isTearingDown) {
			this.parkStates.delete(entry.mediaChannelId);
			return;
		}
		if (entry.parkedByNumber === undefined || entry.parkedByNumber === "") {
			// Nobody to ring back. Put the caller back where somebody can still find them.
			if (await this.deps.parks.restore(claimed.entry)) {
				this.armParkTimeout(
					claimed.entry,
					this.settings.defaultParkTimeoutSeconds * MILLIS_PER_SECOND,
				);
			}
			this.log("a parked call timed out with no parker to return it to", {
				parkLotId: entry.parkLotId,
				slot: entry.slot,
			});
			return;
		}

		this.transitionPark(entry.mediaChannelId, "timed-out");
		this.parkStates.delete(entry.mediaChannelId);
		leg.removeFlag("park");
		leg.moveTo("routing");

		await this.publishQuietly(leg, "call.unparked", {
			legId: leg.legId,
			parkLotId: entry.parkLotId,
			slot: String(entry.slot),
			reason: "timeout" satisfies ParkEndReason,
			durationMs: Math.max(0, this.now() - entry.parkedAtMs),
		});

		const outcome = await this.routeTransferee(
			leg,
			entry.parkedByNumber,
			this.settings.transferContext,
		);
		if (outcome.status !== "bridged") {
			this.log("a timed-out parked call could not be returned to its parker", {
				parkLotId: entry.parkLotId,
				slot: entry.slot,
				parkedByNumber: entry.parkedByNumber,
				status: outcome.status,
			});
		}
	}

	private transitionPark(mediaChannelId: string, to: ParkState): void {
		const from = this.parkStates.get(mediaChannelId);
		if (from === undefined) {
			return;
		}
		assertParkTransition(from, to);
		this.parkStates.set(mediaChannelId, to);
	}

	private parkTimeoutMs(lot: ParkLot, override?: number): number {
		if (override !== undefined) {
			return Math.max(0, override);
		}
		// `0` on the lot means "never", and is `park_lot`'s own default for a lot with no timeout —
		// substituting the deployment default there would ring somebody back about a call they
		// deliberately left parked.
		const seconds = lot.timeoutSeconds ?? this.settings.defaultParkTimeoutSeconds;
		return Math.max(0, seconds) * MILLIS_PER_SECOND;
	}

	/** The leg on the other side of this one's bridge, when this process is handling it. */
	private peerOf(leg: ControlledLeg): ControlledLeg | undefined {
		const peerMediaChannelId = leg.peerMediaChannelId;
		return peerMediaChannelId === undefined ? undefined : this.deps.host.legFor(peerMediaChannelId);
	}

	/** The guard every operation runs first. Existence → teardown → media path, in that order. */
	private refuseIfUnusable(leg: ControlledLeg, operation: string): CallControlResult | undefined {
		if (leg.isTearingDown) {
			return refuse(`the leg is tearing down, so it cannot be used for ${operation}`);
		}
		if (!leg.isAnswered) {
			return refuse(`the leg has not answered, so it cannot be used for ${operation}`);
		}
		return undefined;
	}

	private awaitLegEntered(
		mediaChannelId: string,
		timeoutMs: number,
	): { readonly promise: Promise<boolean>; readonly cancel: () => void } {
		let unwatch = (): void => undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settle: (value: boolean) => void = () => undefined;

		const promise = new Promise<boolean>((resolve) => {
			const done = (value: boolean): void => {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				unwatch();
				resolve(value);
			};
			settle = done;
			unwatch = this.deps.signals.watch(legSignalKey(mediaChannelId), (signal) => {
				const leg = signal as LegSignal;
				if (leg.kind === "entered" || leg.kind === "answered") {
					done(true);
				} else if (leg.kind === "ended") {
					done(false);
				}
			});
			timer = setTimeout(() => {
				done(false);
			}, timeoutMs);
			timer.unref?.();
		});

		return {
			promise,
			cancel: () => {
				settle(false);
			},
		};
	}

	private awaitRecordingFinished(
		name: string,
		timeoutMs: number,
	): {
		readonly promise: Promise<{
			readonly durationMs: number;
			readonly reason: "completed" | "cancelled" | "failed";
		}>;
		readonly cancel: () => void;
	} {
		type Outcome = { durationMs: number; reason: "completed" | "cancelled" | "failed" };
		let unwatch = (): void => undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settle: (value: Outcome) => void = () => undefined;

		const promise = new Promise<Outcome>((resolve) => {
			const done = (value: Outcome): void => {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				unwatch();
				resolve(value);
			};
			settle = done;
			unwatch = this.deps.signals.watch(recordingSignalKey(name), (signal) => {
				if (signal.kind === "recording-finished") {
					done({ durationMs: signal.durationMs, reason: "completed" });
				} else if (signal.kind === "recording-failed") {
					done({ durationMs: 0, reason: "failed" });
				}
			});
			// The backstop matters: the media server drops `RecordingFinished` when the channel dies
			// mid-record, and a recording that never publishes `record.stopped` is an object nobody
			// uploads.
			timer = setTimeout(() => {
				done({ durationMs: 0, reason: "cancelled" });
			}, timeoutMs);
			timer.unref?.();
		});

		return { promise, cancel: () => settle({ durationMs: 0, reason: "cancelled" }) };
	}

	private async hangupQuietly(mediaChannelId: string, cause: HangupCause): Promise<void> {
		try {
			await this.deps.media.hangup(mediaChannelId, cause);
		} catch (error) {
			this.log("failed to hang a leg up", { mediaChannelId, cause, err: String(error) });
		}
	}

	/**
	 * Publishes a fact without letting a slow broker end a call.
	 *
	 * Every event here describes something that has ALREADY happened to the media — the leg is out
	 * of the bridge, the slot is claimed — so a publish that fails is a reporting gap, not a call
	 * that should be torn down.
	 */
	private async publishQuietly(
		leg: ControlledLeg,
		type: CallEvent,
		data: Record<string, unknown>,
	): Promise<void> {
		try {
			await this.deps.host.publish(leg, type, data);
		} catch (error) {
			this.log("failed to publish a call-control event", { type, err: String(error) });
		}
	}
}
