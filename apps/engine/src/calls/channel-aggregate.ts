import {
	assertCallStateTransition,
	assertChannelTransition,
	hangupCauseCode,
	INITIAL_CALL_STATE,
	INITIAL_CHANNEL_STATE,
	isTeardownChannelState,
	isValidCallStateTransition,
	isValidChannelTransition,
} from "@optimiq-voice/telephony";
import type { CallDirection, LegSide } from "@optimiq-voice/events";
import type {
	CallerProfile,
	CallState,
	ChannelFlag,
	ChannelSnapshot,
	ChannelState,
	HangupCause,
} from "@optimiq-voice/telephony";

const MEDIA_CHANNEL_ID_VARIABLE = "OPTIMIQ_MEDIA_CHANNEL_ID";
const HANGUP_INITIATED_BY_ENGINE_VARIABLE = "OPTIMIQ_HANGUP_INITIATED_BY_ENGINE";

/**
 * One call leg, as the engine holds it.
 *
 * This is a thin, mutable wrapper around `ChannelSnapshot` from `@optimiq-voice/telephony`; the
 * snapshot itself is the KV-safe value written to the `channels` bucket. The wrapper exists to do
 * exactly two things:
 *
 * 1. **Guard, then execute.** Every state move goes through `assertChannelTransition` /
 *    `assertCallStateTransition` BEFORE the field is written, per the oikos convention. An invalid
 *    transition throws and the write never happens, so the snapshot in KV is never a state the
 *    machine says is unreachable.
 * 2. **Keep the media id private.** The media server's channel id is engine-local plumbing and
 *    never reaches events or the CDR. It is mirrored as a reserved snapshot variable solely so a
 *    replacement process can rebuild this wrapper before the terminal event arrives.
 *
 * No domain LOGIC lives here: nothing decides what a call should do next. That is the
 * orchestrator's job, and keeping this a state holder is what makes the orchestrator's decisions
 * testable in isolation.
 */
export class ChannelAggregate {
	/** The media server's own id for this leg. Never published. */
	readonly ariChannelId: string;

	private snapshotValue: ChannelSnapshot;
	private hangupInitiatedByEngine = false;
	private detachedFromWalk = false;

	private constructor(ariChannelId: string, snapshot: ChannelSnapshot) {
		this.ariChannelId = ariChannelId;
		this.snapshotValue = snapshot;
		this.hangupInitiatedByEngine =
			snapshot.variables[HANGUP_INITIATED_BY_ENGINE_VARIABLE] === "true";
	}

	/** Creates a leg in the initial state of both machines (`created` / `down`). */
	static create(input: {
		readonly ariChannelId: string;
		readonly channelId: string;
		readonly callId: string;
		readonly organizationId: string;
		readonly direction: CallDirection;
		readonly leg: LegSide;
		readonly profile: CallerProfile;
		readonly variables?: Readonly<Record<string, string>>;
		readonly createdAt: number;
	}): ChannelAggregate {
		return new ChannelAggregate(input.ariChannelId, {
			channelId: input.channelId,
			callId: input.callId,
			organizationId: input.organizationId,
			// `ChannelDirection` in the domain is the SIGNALLING direction (who set the leg up);
			// `internal` is an organizational classification with no signalling meaning, so it maps
			// onto the inbound side of the wire.
			direction: input.direction === "outbound" ? "outbound" : "inbound",
			state: INITIAL_CHANNEL_STATE,
			callState: INITIAL_CALL_STATE,
			flags: input.direction === "outbound" ? ["outbound"] : [],
			profile: input.profile,
			variables: {
				...input.variables,
				[MEDIA_CHANNEL_ID_VARIABLE]: input.ariChannelId,
			},
			createdAt: input.createdAt,
		});
	}

	/** Rebuilds the mutable wrapper around a snapshot read from the `channels` KV bucket. */
	static hydrate(snapshot: ChannelSnapshot): ChannelAggregate {
		const mediaChannelId = snapshot.variables[MEDIA_CHANNEL_ID_VARIABLE];
		if (mediaChannelId === undefined || mediaChannelId.trim() === "") {
			throw new TypeError("channel recovery snapshot has no media channel id");
		}
		return new ChannelAggregate(mediaChannelId, snapshot);
	}

	/** The KV-safe value. Frozen at the boundary so a caller cannot mutate engine state. */
	get snapshot(): ChannelSnapshot {
		return this.snapshotValue;
	}

	get channelId(): string {
		return this.snapshotValue.channelId;
	}

	get callId(): string {
		return this.snapshotValue.callId;
	}

	get organizationId(): string {
		return this.snapshotValue.organizationId;
	}

	get state(): ChannelState {
		return this.snapshotValue.state;
	}

	get callState(): CallState {
		return this.snapshotValue.callState;
	}

	get hangupCause(): HangupCause | undefined {
		return this.snapshotValue.hangupCause;
	}

	/** Whether teardown has begun; the leg can no longer be routed or take a verb. */
	get isTearingDown(): boolean {
		return isTeardownChannelState(this.snapshotValue.state);
	}

	get isAnswered(): boolean {
		return this.snapshotValue.answeredAt !== undefined;
	}

	/** Whether the ENGINE decided to hang this leg up, rather than the far end. */
	get wasHungUpByEngine(): boolean {
		return this.hangupInitiatedByEngine;
	}

	/**
	 * Whether a call-control feature has taken this leg away from its routing walk.
	 *
	 * NOT a teardown: the leg is alive, answered and talking to somebody. It is the walk that is
	 * over. Kept separate from `isTearingDown` because everything the walk would do next to a
	 * detached leg still SUCCEEDS at the media server — and every bit of it is wrong.
	 */
	get isDetached(): boolean {
		return this.detachedFromWalk;
	}

	/**
	 * Takes the leg away from its routing walk. One-way, and idempotent.
	 *
	 * Set by a pickup, which hangs up the phone the walk was ringing. Without this the walk reads
	 * that as a failed dial, takes the no-answer branch, and sends a caller who is already talking to
	 * somebody to voicemail.
	 */
	detach(): void {
		this.detachedFromWalk = true;
	}

	/**
	 * Moves the engine-internal state machine.
	 *
	 * @throws {import("@optimiq-voice/telephony").InvalidChannelTransitionError} on a
	 * non-existent edge. That is always an engine bug or an event applied out of order, never
	 * caller input — it must surface, not be swallowed.
	 */
	transitionTo(next: ChannelState): void {
		assertChannelTransition(this.snapshotValue.state, next);
		this.snapshotValue = { ...this.snapshotValue, state: next };
	}

	/**
	 * Moves the state machine only if the edge exists, reporting whether it moved.
	 *
	 * For the events the media server delivers redundantly (a `ChannelStateChange` to `Up`
	 * followed by a `StasisStart` on an already-answered channel). A duplicate is not a bug and
	 * must not throw; a genuinely impossible edge still does, via {@link transitionTo}.
	 */
	tryTransitionTo(next: ChannelState): boolean {
		if (this.snapshotValue.state === next) {
			return false;
		}
		if (!isValidChannelTransition(this.snapshotValue.state, next)) {
			return false;
		}
		this.transitionTo(next);
		return true;
	}

	/**
	 * Moves the user-visible call state, reporting whether it moved.
	 *
	 * @throws {import("@optimiq-voice/telephony").InvalidCallStateTransitionError} never from
	 * here — an impossible edge from a media-server state change is dropped rather than thrown,
	 * because ARI legitimately reports states out of order across a masquerade. Use
	 * {@link forceCallState} where the engine itself is the author of the move.
	 */
	tryCallStateTo(next: CallState): boolean {
		if (this.snapshotValue.callState === next) {
			return false;
		}
		if (!isValidCallStateTransition(this.snapshotValue.callState, next)) {
			return false;
		}
		this.snapshotValue = { ...this.snapshotValue, callState: next };
		return true;
	}

	/** Moves the user-visible call state, throwing on an impossible edge. */
	forceCallState(next: CallState): void {
		assertCallStateTransition(this.snapshotValue.callState, next);
		this.snapshotValue = { ...this.snapshotValue, callState: next };
	}

	/** Adds a flag. Idempotent — flags are a set, not a log. */
	addFlag(flag: ChannelFlag): void {
		if (this.snapshotValue.flags.includes(flag)) {
			return;
		}
		this.snapshotValue = { ...this.snapshotValue, flags: [...this.snapshotValue.flags, flag] };
	}

	/** Removes a flag. Idempotent. */
	removeFlag(flag: ChannelFlag): void {
		if (!this.snapshotValue.flags.includes(flag)) {
			return;
		}
		this.snapshotValue = {
			...this.snapshotValue,
			flags: this.snapshotValue.flags.filter((existing) => existing !== flag),
		};
	}

	/** Records the answer instant and the `answered` flag. Idempotent. */
	markAnswered(at: number): boolean {
		if (this.snapshotValue.answeredAt !== undefined) {
			return false;
		}
		this.snapshotValue = { ...this.snapshotValue, answeredAt: at };
		this.addFlag("answered");
		return true;
	}

	/** Records the early-media flag. */
	markEarlyMedia(): void {
		this.addFlag("early-media");
	}

	/**
	 * Fixes the hangup cause and instant.
	 *
	 * The cause is immutable once set — that is what makes the per-leg CDR reproducible from the
	 * event stream, and it is why a later `ChannelDestroyed` carrying a different code cannot
	 * overwrite the cause the engine already published on `channel.hangup`.
	 */
	markHangup(input: {
		readonly cause: HangupCause;
		readonly at: number;
		readonly initiatedByEngine: boolean;
	}): boolean {
		if (this.snapshotValue.hangupCause !== undefined) {
			return false;
		}
		this.hangupInitiatedByEngine = input.initiatedByEngine;
		this.snapshotValue = {
			...this.snapshotValue,
			hangupCause: input.cause,
			hangupAt: input.at,
			variables: {
				...this.snapshotValue.variables,
				[HANGUP_INITIATED_BY_ENGINE_VARIABLE]: String(input.initiatedByEngine),
			},
		};
		return true;
	}

	/** The numeric code of the fixed cause, or `0` when no cause has been recorded. */
	get hangupCauseCode(): number {
		const cause = this.snapshotValue.hangupCause;
		return cause === undefined ? 0 : hangupCauseCode(cause);
	}

	/** Replaces the caller profile — a new routing hop (transfer, forward, `execute_extension`). */
	pushProfile(profile: CallerProfile): void {
		this.snapshotValue = { ...this.snapshotValue, profile };
	}

	/** Records a channel-scoped variable the engine read or set. */
	setVariable(name: string, value: string): void {
		this.snapshotValue = {
			...this.snapshotValue,
			variables: { ...this.snapshotValue.variables, [name]: value },
		};
	}

	/**
	 * Forgets a variable.
	 *
	 * Exists for one variable and one reason: a transfer, a park and a pickup all break a bridge
	 * pairing that the teardown path reads to decide whether to hang the other side up. Setting the
	 * variable to an empty string would be read as a leg id; it has to be gone.
	 */
	clearVariable(name: string): void {
		if (!(name in this.snapshotValue.variables)) {
			return;
		}
		const variables = Object.fromEntries(
			Object.entries(this.snapshotValue.variables).filter(([key]) => key !== name),
		);
		this.snapshotValue = { ...this.snapshotValue, variables };
	}

	/** Associates the leg with a bridge, or clears the association when `undefined`. */
	setBridge(bridgeId: string | undefined): void {
		this.snapshotValue = { ...this.snapshotValue, bridgeId };
	}
}
