import { getLogger, type PinoLogger } from "@optimiq-voice/logging";
import { hangupCauseCode } from "@optimiq-voice/telephony";
import {
	MediaCommandRefusedError,
	MediaOperationNotSupportedError,
} from "./media-not-supported.error";
import type { SipdCommandPort } from "../nats/sipd-command.client";
import type {
	BridgeHandle,
	DialTarget,
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
	TapHandle,
	TapRequest,
} from "./media-port";
import type { MediadMediaPort } from "./mediad-media.port";
import type {
	EngineRenegotiateRequest,
	EngineRenegotiateResponse,
	MediaAcceptAnswerResponse,
} from "@optimiq-voice/events";
import type { BridgeMode, HangupCause } from "@optimiq-voice/telephony";

/**
 * The plane on which a call arrived, and everything the composite needs to command each of its legs.
 *
 * Held in memory, keyed by `channelId`, because that is the only place the two facts a leg is made of
 * meet: the A-leg's original SDP offer (which `apps/mediad` must answer) and the `apps/sipd` instance
 * that owns the dialog (which every signalling command must be addressed at). Both are learned at
 * admission or origination and neither is on the wire afterwards, so the composite records them the
 * moment the lead hands them over — see {@link SplitPlaneMediaPort.registerInboundLeg}.
 */
interface LegRecord {
	readonly orgId: string;
	readonly callId: string;
	/** `inbound` = a dialog `sipd` terminated and admitted; `outbound` = one the engine originates. */
	readonly role: "inbound" | "outbound";
	/** The `sipd` instance holding the dialog. Absent on an outbound leg until originate replies. */
	instanceId: string | undefined;
	/** The A-leg's offer, which `answer` hands to `mediad` to produce the 200 OK's body. */
	sdpOffer: string | undefined;
}

/**
 * Thrown when a composite operation cannot proceed because the leg's signalling state is missing —
 * the leg was never registered, or it has no offer or no owning `sipd` instance to command.
 *
 * A typed error rather than a bare throw because `answer` and `ring` have `void` returns with no room
 * for a refusal envelope: the only way to say "this leg cannot be answered" is to fail loudly and name
 * why, exactly as {@link MediaOperationNotSupportedError} does for a capability that is absent.
 */
export class SplitPlaneLegStateError extends Error {
	readonly operation: string;
	readonly channelId: string;

	constructor(operation: string, channelId: string, detail: string) {
		super(`split-plane cannot ${operation} ${channelId}: ${detail}`);
		this.name = "SplitPlaneLegStateError";
		this.operation = operation;
		this.channelId = channelId;
	}
}

/**
 * Thrown when the signalling plane REFUSED a composite command that has no other channel to report it.
 *
 * `sipd` returns refusals as data (`{ok:false, reason}`), and most of the time the lead can branch on
 * that. But `answer`, `ring` and `originate` are `MediaPort` methods whose return types cannot carry a
 * "no" — an answered call either happened or it did not — so a refusal on them becomes this, with the
 * machine-readable `reason` intact for a caller that wants to branch on it.
 */
export class SplitPlaneSignallingRefusedError extends Error {
	readonly operation: string;
	readonly channelId: string;
	readonly reason: string | undefined;

	constructor(operation: string, channelId: string, reason: string | undefined, detail: string) {
		super(
			`split-plane ${operation} ${channelId} refused by the sip edge (${reason ?? "internal"}): ${detail}`,
		);
		this.name = "SplitPlaneSignallingRefusedError";
		this.operation = operation;
		this.channelId = channelId;
		this.reason = reason;
	}
}

/** Thrown when an originate arrives with no {@link OriginateRequest.target} for the composite to dial. */
export class SplitPlaneBadRequestError extends Error {
	readonly operation: string;
	readonly channelId: string;

	constructor(operation: string, channelId: string, detail: string) {
		super(`split-plane ${operation} ${channelId}: ${detail}`);
		this.name = "SplitPlaneBadRequestError";
		this.operation = operation;
		this.channelId = channelId;
	}
}

/**
 * The composite (split-plane) {@link MediaPort} of `plans/sipd-invite-design.md` §3.2.
 *
 * ## The one implementation for which every method is servable
 *
 * `MediadMediaPort` refuses `answer`, `ring` and `originate` because they are signalling, and Asterisk
 * served them by being both planes at once. This composite is the first port that has BOTH planes to
 * reach: a {@link MediadMediaPort} for media and a {@link SipdCommandPort} for signalling. So each of
 * the three signalling verbs becomes a COMPOSITION — allocate a media session and answer the dialog
 * with the SDP it produced — and the rest of the surface either delegates to `mediad` unchanged or, in
 * the case of channel variables, is served from the engine's own per-leg store with no wire trip
 * (§3.4). Nothing above this seam learns the plane it is on.
 *
 * ## What it holds, and why it is in memory
 *
 * A dialog lives on exactly one `sipd` process and cannot be re-homed (§6.1), so a per-leg record of
 * "which instance owns this dialog" and "what offer the A-leg sent" is local state by nature. The lead
 * populates it at admission ({@link registerInboundLeg}) and origination ({@link registerOutboundLeg})
 * and clears it on teardown ({@link forget}); the durable copy lives in the `sip-dialogs` KV directory
 * the edge writes, which is not this class's concern.
 *
 * ## Every refusal names the operation
 *
 * A composite that silently no-opped a `record` would produce the worst defect a telephony system has
 * — a call that sounds perfect and recorded nothing — so `snoop` and `echo` throw
 * {@link MediaOperationNotSupportedError} naming both planes, and a leg with no signalling state throws
 * {@link SplitPlaneLegStateError} rather than answering into the void. The argument is the class doc of
 * `MediadMediaPort`, applied to a second plane.
 */
export class SplitPlaneMediaPort implements MediaPort {
	private readonly legs = new Map<string, LegRecord>();

	/**
	 * The engine-side channel-variable store, §3.4.
	 *
	 * Kept OUT of {@link LegRecord} on purpose: variables are written and read independently of a leg's
	 * signalling lifecycle — `legHooksFor(…).originated` stamps a B-leg's three before the leg is even
	 * dialled — so the store is its own map, lazily created on first write, and never needs a leg to be
	 * registered first. On this plane it is the SOURCE of truth, because there is no dialplan to hold
	 * them and no media server that would.
	 */
	private readonly variables = new Map<string, Map<string, string>>();

	/**
	 * @param media the media plane — allocation, offers, playback, bridging and release.
	 * @param signalling the dialog command surface `apps/sipd` serves.
	 * @param logger scoped so a teardown that could not reach the edge is one greppable line.
	 */
	constructor(
		private readonly media: MediadMediaPort,
		private readonly signalling: SipdCommandPort,
		private readonly logger: PinoLogger = getLogger("engine.split-plane"),
		private readonly engineInstanceId?: string,
	) {}

	// --- registration: the lead hands the composite each leg's plane state ------------------------

	/**
	 * Records an inbound leg `apps/sipd` terminated and the engine admitted.
	 *
	 * Called at admission time, once the edge has answered the arrival RPC with the instance that holds
	 * the dialog and the offer the phone sent. Everything `answer` needs is here.
	 */
	registerInboundLeg(
		channelId: string,
		context: {
			readonly orgId: string;
			readonly callId: string;
			readonly sipdInstanceId: string;
			readonly sdpOffer: string;
		},
	): void {
		this.legs.set(channelId, {
			orgId: context.orgId,
			callId: context.callId,
			role: "inbound",
			instanceId: context.sipdInstanceId,
			sdpOffer: context.sdpOffer,
		});
	}

	/**
	 * Records an outbound leg the engine is about to originate.
	 *
	 * The owning instance is not known yet — origination CREATES the dialog and the reply names the
	 * instance that took it — so {@link originate} fills it in via {@link setInstance}.
	 */
	registerOutboundLeg(
		channelId: string,
		context: { readonly orgId: string; readonly callId: string },
	): void {
		this.legs.set(channelId, {
			orgId: context.orgId,
			callId: context.callId,
			role: "outbound",
			instanceId: undefined,
			sdpOffer: undefined,
		});
	}

	/**
	 * Records the `sipd` instance that owns a leg's dialog.
	 *
	 * The reply to `rpc.sip.v1.originate` carries it, and every later command on that leg — the BYE
	 * above all — must be addressed at exactly that instance or it reaches an edge that never had the
	 * call. Called for the lead's event-path use too, when an inbound instance is re-learned.
	 */
	setInstance(channelId: string, instanceId: string): void {
		const leg = this.legs.get(channelId);
		if (leg === undefined) {
			this.logger.warn({ channelId, instanceId }, "setInstance for a leg that is not registered");
			return;
		}
		leg.instanceId = instanceId;
	}

	/** Drops all per-leg state. Idempotent; called on teardown after the dialog and media are gone. */
	forget(channelId: string): void {
		this.legs.delete(channelId);
		this.variables.delete(channelId);
	}

	// --- MediaPort: bridge mode and the three signalling compositions -----------------------------

	/** Delegated: bridging is `mediad`'s, so the mode is whatever the relay declares (`proxy-media`). */
	get bridgeMode(): BridgeMode {
		return this.media.bridgeMode;
	}

	get supportsSupervision(): boolean {
		return this.media.supportsSupervision;
	}

	async resolveTargets(
		orgId: string,
		target: DialTarget,
	): Promise<readonly (readonly DialTarget[])[]> {
		if (
			target.kind !== "aor" ||
			target.contactUri !== undefined ||
			this.signalling.resolveTarget === undefined
		)
			return [[target]];
		const reply = await this.signalling.resolveTarget({ orgId, legId: "resolve-contacts", target });
		if (!reply.ok)
			throw new SplitPlaneSignallingRefusedError(
				"originate",
				"resolve-contacts",
				reply.reason,
				reply.error ?? "destination resolution failed",
			);
		if (reply.contacts === undefined || reply.contacts.length === 0) {
			return [
				[reply.requestUri === undefined ? target : { ...target, contactUri: reply.requestUri }],
			];
		}
		const groups = new Map<number, DialTarget[]>();
		for (const contact of [...reply.contacts].sort((a, b) => b.q - a.q)) {
			const group = groups.get(contact.q) ?? [];
			group.push({ ...target, contactUri: contact.requestUri });
			groups.set(contact.q, group);
		}
		return [...groups.values()];
	}

	async recordConversation(channelId: string, request: RecordRequest): Promise<RecordingHandle> {
		return await this.media.recordConversation(channelId, request);
	}

	/**
	 * `200 OK` with the media plane's answer, §3.2.
	 *
	 * Allocate a `mediad` session for the A-leg's stored offer, take the answer it produces, and hand
	 * that to `sipd` as the 200's body. Media before signalling here — the opposite of {@link hangup} —
	 * because the answer does not exist until `mediad` writes it. A leg with no offer or no owning
	 * instance cannot be answered, and saying so loudly is the whole contract.
	 */
	async renegotiate(request: EngineRenegotiateRequest): Promise<EngineRenegotiateResponse> {
		const leg = this.legs.get(request.legId);
		if (
			!leg ||
			leg.orgId !== request.orgId ||
			leg.callId !== request.callId ||
			leg.instanceId !== request.sipdInstanceId
		)
			return { ok: false, legId: request.legId, reason: "unknown_leg" };
		let reply;
		try {
			reply = await this.media.allocateSession({
				sessionId: request.legId,
				legId: request.legId,
				orgId: leg.orgId,
				callId: leg.callId,
				sdpOffer: request.sdpOffer,
			});
		} catch (error) {
			if (error instanceof MediaCommandRefusedError && error.reason === "not_supported")
				return { ok: false, legId: request.legId, reason: "not_supported" };
			throw error;
		}
		if (!reply.ok || !reply.sdpAnswer)
			return { ok: false, legId: request.legId, reason: "not_supported" };
		if (this.legs.get(request.legId) !== leg) {
			await this.media.hangup(request.legId, "NORMAL_CLEARING");
			return { ok: false, legId: request.legId, reason: "unknown_leg" };
		}
		leg.sdpOffer = request.sdpOffer;
		return { ok: true, legId: request.legId, sdpAnswer: reply.sdpAnswer };
	}

	async answer(channelId: string): Promise<void> {
		const leg = this.require("answer", channelId);
		if (leg.sdpOffer === undefined) {
			throw new SplitPlaneLegStateError("answer", channelId, "no A-leg SDP offer was registered");
		}
		if (leg.instanceId === undefined) {
			throw new SplitPlaneLegStateError("answer", channelId, "no owning sipd instance is known");
		}

		const allocation = await this.media.allocateSession({
			sessionId: channelId,
			orgId: leg.orgId,
			callId: leg.callId,
			legId: channelId,
			sdpOffer: leg.sdpOffer,
			direction: "sendrecv",
		});
		if (allocation.sdpAnswer === undefined) {
			throw new SplitPlaneLegStateError(
				"answer",
				channelId,
				"mediad allocated the session but produced no SDP answer",
			);
		}

		const reply = await this.signalling.answer(leg.instanceId, {
			legId: channelId,
			sdpAnswer: allocation.sdpAnswer,
		});
		if (!reply.ok) {
			throw new SplitPlaneSignallingRefusedError(
				"answer",
				channelId,
				reply.reason,
				reply.error ?? "no detail",
			);
		}
	}

	/** `180 Ringing`, no SDP at slice 1 (§4.3). Throws on refusal — `ring` has no envelope to carry one. */
	async ring(channelId: string): Promise<void> {
		const leg = this.require("ring", channelId);
		if (leg.instanceId === undefined) {
			throw new SplitPlaneLegStateError("ring", channelId, "no owning sipd instance is known");
		}
		const reply = await this.signalling.ring(leg.instanceId, { legId: channelId, status: 180 });
		if (!reply.ok) {
			throw new SplitPlaneSignallingRefusedError(
				"ring",
				channelId,
				reply.reason,
				reply.error ?? "no detail",
			);
		}
	}

	/**
	 * Place a call — a UAC INVITE composed of a `mediad` offer and a `sipd` originate (§5).
	 *
	 * Ask `mediad` to WRITE an offer for the B-leg (it has none — we are the caller), hand that offer to
	 * `sipd` with the dial target, and record the instance the reply names so the leg is commandable
	 * afterwards. Throws on refusal, per the {@link MediaPort.originate} contract: the walker reads a
	 * throw as "not registered", which is the only thing an originate failure can honestly mean.
	 *
	 * The callee's answer arrives LATER, as a `dialog.answered` event carrying its SDP; the lead feeds
	 * it back through {@link settleOutboundAnswer}. It is deliberately not awaited here.
	 */
	async originate(request: OriginateRequest): Promise<OriginatedChannel> {
		if (request.target === undefined) {
			throw new SplitPlaneBadRequestError(
				"originate",
				request.channelId,
				"no dial target — the sipd composite needs OriginateRequest.target",
			);
		}
		const leg = this.require("originate", request.channelId);
		const resolved = await this.signalling.resolveTarget?.({
			legId: request.channelId,
			orgId: leg.orgId,
			target: request.target,
		});
		if (resolved !== undefined && !resolved.ok) {
			throw new SplitPlaneSignallingRefusedError(
				"originate",
				request.channelId,
				resolved.reason,
				resolved.error ?? "destination resolution failed",
			);
		}

		if (resolved?.instanceId !== undefined)
			this.setInstance(request.channelId, resolved.instanceId);
		try {
			const offer = await this.media.createOffer({
				...(resolved?.transport === "ws" || resolved?.transport === "wss"
					? { transport: "webrtc" as const }
					: {}),
				sessionId: request.channelId,
				orgId: leg.orgId,
				callId: leg.callId,
				legId: request.channelId,
				direction: "sendrecv",
			});
			if (!offer.ok || offer.sdpOffer === undefined) {
				throw new SplitPlaneSignallingRefusedError(
					"originate",
					request.channelId,
					offer.reason,
					offer.error ?? "mediad wrote no offer for the B-leg",
				);
			}

			const reply = await this.signalling.originate(
				{
					legId: request.channelId,
					engineInstanceId: this.engineInstanceId,
					orgId: leg.orgId,
					callId: leg.callId,
					target:
						request.target.kind === "aor" && resolved?.requestUri !== undefined
							? { ...request.target, contactUri: resolved.requestUri }
							: request.target,
					...splitCallerId(request.callerId),
					sdpOffer: offer.sdpOffer,
					headers: Object.fromEntries(
						["Alert-Info", "Call-Info"].flatMap((name) => {
							const value = request.variables?.[`PJSIP_HEADER(add,${name})`];
							return value === undefined ? [] : [[name, value]];
						}),
					),
					...(request.timeoutSeconds === undefined || request.timeoutSeconds <= 0
						? {}
						: { ringTimeoutMs: request.timeoutSeconds * MILLIS_PER_SECOND }),
				},
				resolved?.instanceId,
			);
			if (!reply.ok) {
				throw new SplitPlaneSignallingRefusedError(
					"originate",
					request.channelId,
					reply.reason,
					reply.error ?? "no detail",
				);
			}
			if (reply.instanceId !== undefined) {
				this.setInstance(request.channelId, reply.instanceId);
			}
			return { channelId: request.channelId };
		} catch (error) {
			// An RPC timeout can leave a sent INVITE or allocated media behind. The resolved edge
			// is already recorded, so cleanup also reaches a call whose originate reply was lost.
			try {
				await this.hangup(request.channelId, "NORMAL_TEMPORARY_FAILURE");
			} catch (cleanupError) {
				this.logger.error(
					{ channelId: request.channelId, err: cleanupError },
					"failed to clean up refused origination",
				);
			}
			throw error;
		}
	}

	/**
	 * Settle a B-leg's codec once the callee's answer has arrived on the `dialog.answered` event path.
	 *
	 * NOT a `MediaPort` method: it exists for the LEAD to call from the event handler, because the
	 * answer is not known when {@link originate} returns. It returns the raw `mediad` result so the lead
	 * can branch — an `ok` reply settles the codec, and a `not_supported` refusal is the callee choosing
	 * a codec `mediad` cannot serve, which the lead turns into an `INCOMPATIBLE_DESTINATION` hangup.
	 */
	async settleOutboundAnswer(
		channelId: string,
		sdpAnswer: string,
	): Promise<MediaAcceptAnswerResponse> {
		return await this.media.acceptAnswer({ sessionId: channelId, sdpAnswer });
	}

	/**
	 * Tear the leg down — BYE the dialog, THEN release the media (§3.2).
	 *
	 * Signalling first, deliberately: releasing the port pair before the BYE goes out would drop the
	 * audio mid-goodbye. A missing instance is tolerated — an outbound leg that never got an originate
	 * reply still has media to free — and a signalling refusal is logged rather than thrown, because a
	 * hangup is idempotent teardown the engine retries and a `dialog_gone` is a normal race outcome.
	 */
	async hangup(channelId: string, cause: HangupCause): Promise<void> {
		const instanceId = this.legs.get(channelId)?.instanceId;
		try {
			if (instanceId !== undefined) {
				const reply = await this.signalling.hangup(instanceId, {
					legId: channelId,
					cause: hangupCauseCode(cause),
				});
				if (!reply.ok) {
					this.logger.warn(
						{ channelId, instanceId, reason: reply.reason },
						"the sip edge refused a hangup; releasing media anyway",
					);
				}
			}
		} finally {
			await this.media.releaseSession(channelId);
			this.forget(channelId);
		}
	}

	/** A remote BYE has already ended signalling; release its media without sending another BYE. */
	async releaseEndedLeg(channelId: string): Promise<void> {
		await this.media.releaseSession(channelId);
		this.forget(channelId);
	}

	// --- MediaPort: channel variables, served from the engine's own store (§3.4) -------------------

	/** Read a per-leg variable from the local store. No wire trip — these were never media state. */
	async getVariable(channelId: string, name: string): Promise<string | undefined> {
		await Promise.resolve();
		return this.variables.get(channelId)?.get(name);
	}

	/** Write a per-leg variable to the local store, creating the leg's map on first write. */
	async setVariable(channelId: string, name: string, value: string): Promise<void> {
		await Promise.resolve();
		let store = this.variables.get(channelId);
		if (store === undefined) {
			store = new Map<string, string>();
			this.variables.set(channelId, store);
		}
		store.set(name, value);
	}

	// --- MediaPort: delegated to the media plane unchanged ----------------------------------------

	async play(channelId: string, request: PlayRequest): Promise<PlaybackHandle> {
		return await this.media.play(channelId, request);
	}

	async stopPlayback(playbackRef: string): Promise<void> {
		await this.media.stopPlayback(playbackRef);
	}

	async record(channelId: string, request: RecordRequest): Promise<RecordingHandle> {
		return await this.media.record(channelId, request);
	}

	async stopRecording(name: string): Promise<void> {
		await this.media.stopRecording(name);
	}

	async sendDtmf(channelId: string, request: SendDtmfRequest): Promise<void> {
		await this.media.sendDtmf(channelId, request);
	}

	async createBridge(request: CreateBridgeRequest): Promise<BridgeHandle> {
		return await this.media.createBridge(request);
	}

	async addToBridge(bridgeId: string, channelIds: readonly string[]): Promise<void> {
		await this.media.addToBridge(bridgeId, channelIds);
	}

	async removeFromBridge(bridgeId: string, channelIds: readonly string[]): Promise<void> {
		await this.media.removeFromBridge(bridgeId, channelIds);
	}

	async destroyBridge(bridgeId: string): Promise<void> {
		await this.media.destroyBridge(bridgeId);
	}

	async hold(channelId: string): Promise<void> {
		await this.media.hold(channelId);
	}

	async unhold(channelId: string): Promise<void> {
		await this.media.unhold(channelId);
	}

	async mute(channelId: string, direction: MediaDirection): Promise<void> {
		await this.media.mute(channelId, direction);
	}

	async unmute(channelId: string, direction: MediaDirection): Promise<void> {
		await this.media.unmute(channelId, direction);
	}

	async startMusicOnHold(channelId: string, mohClass?: string): Promise<void> {
		await this.media.startMusicOnHold(channelId, mohClass);
	}

	async stopMusicOnHold(channelId: string): Promise<void> {
		await this.media.stopMusicOnHold(channelId);
	}

	async tap(request: TapRequest): Promise<TapHandle> {
		return await this.media.tap(request);
	}

	async stopTap(tap: TapHandle): Promise<void> {
		await this.media.stopTap(tap);
	}

	/** Delegated: whether the media plane still holds a session for the leg. */
	async channelExists(channelId: string): Promise<boolean> {
		return await this.media.channelExists(channelId);
	}

	/** Delegated: satisfied by construction on `mediad` (org-wide events), so a no-op here too. */
	async watchChannel(channelId: string): Promise<void> {
		await this.media.watchChannel(channelId);
	}

	// --- MediaPort: refused, naming both planes ---------------------------------------------------

	/**
	 * REFUSED. A snoop channel is an Asterisk-ism neither plane provides: `sipd` speaks only SIP, and
	 * `mediad` refuses it permanently because a relay has no samples to tap (`plans/mediad-design.md`
	 * §10 q4). Named rather than silently dropped, per the class doc.
	 */
	async snoop(request: SnoopRequest): Promise<OriginatedChannel> {
		void request;
		throw new MediaOperationNotSupportedError(
			"snoop",
			"a snoop tap, which neither the sipd signalling plane nor the mediad relay provides",
			"split-plane",
		);
	}

	/**
	 * REFUSED. `echo` is an Asterisk `Echo()` application: `sipd` has no dialplan and `mediad` refuses
	 * it as not a media capability. There is no plane on this composite that can serve it.
	 */
	async echo(channelId: string): Promise<void> {
		void channelId;
		throw new MediaOperationNotSupportedError(
			"echo",
			"Asterisk's Echo() application, which neither the sipd signalling plane nor the mediad relay provides",
			"split-plane",
		);
	}

	// --- internals --------------------------------------------------------------------------------

	private require(operation: string, channelId: string): LegRecord {
		const leg = this.legs.get(channelId);
		if (leg === undefined) {
			throw new SplitPlaneLegStateError(operation, channelId, "the leg is not registered");
		}
		return leg;
	}
}

/** `RecordRequest`/`OriginateRequest` speak seconds; the `sip.v1` wire speaks milliseconds. */
const MILLIS_PER_SECOND = 1_000;

/**
 * Splits a `MediaPort` caller-id string (`"Name" <number>`) into the two fields `sipd` wants.
 *
 * `OriginateRequest.callerId` is one presentation string because that is what ARI took; `sipd` carries
 * name and number separately. Anything the pattern does not recognise is passed as the number, which
 * is the common bare-`1001` case, and an absent caller-id yields no fields at all.
 */
function splitCallerId(callerId: string | undefined): {
	callerIdName?: string;
	callerIdNumber?: string;
} {
	if (callerId === undefined) {
		return {};
	}
	const match = /^\s*(?:"([^"]*)"\s*)?(?:<([^>]+)>|(\S+))\s*$/.exec(callerId);
	if (match === null) {
		return {};
	}
	const name = match[1];
	const number = match[2] ?? match[3];
	return {
		...(name === undefined || name === "" ? {} : { callerIdName: name }),
		...(number === undefined ? {} : { callerIdNumber: number }),
	};
}
