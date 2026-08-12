import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { makeCdrLegWriteEvent, makeVoicemailEvent, validateEvent } from "@optimiq-voice/events";
import { createEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logging";
import { resolveInbound, resolveInternal, resolveOutbound } from "@optimiq-voice/routing";
import { isDtmfDigit } from "@optimiq-voice/telephony";
import { CallEventPublisher } from "../nats/call-event-publisher.service";
import {
	CHANNEL_OWNER_EXPIRES_AT_VARIABLE,
	CHANNEL_OWNER_INSTANCE_VARIABLE,
	CHANNEL_OWNERSHIP_LEASE_MS,
} from "../nats/channel-ownership";
import { JetStreamService } from "../nats/jetstream.service";
import { CALLS_EFFECT_RUNTIME, ENGINE_ENV, MEDIA_PORT } from "../nats/nats.tokens";
import { OriginateService } from "../nats/originate.service";
import { ParkHandoffService } from "../nats/park-handoff.service";
import { SipTransferService } from "../nats/sip-transfer.service";
import { AgentStateStore } from "../queue/agent-state.store";
import { QueueEventPublisher } from "../queue/queue-event-publisher.service";
import { QueueMembershipSource } from "../queue/queue-membership.source";
import { QueueCursors, QueuePositions } from "../queue/queue-registry";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "../routing/call-signals";
import { CLAIM_HEARTBEAT_INTERVAL_MS } from "../routing/claim-timing";
import { ConferenceRegistry } from "../routing/conference-registry";
import { DidIndexSource } from "../routing/did-index.source";
import { ExtensionFeatureRpcPort } from "../routing/extension-feature.source";
import { LastCallerRpcSource } from "../routing/last-caller.source";
import { ParkRegistry } from "../routing/park-registry";
import { PlanWalker } from "../routing/plan-walker";
import { RoutingArtifactSource } from "../routing/routing-artifact.source";
import { TrunkCapacityRegistry } from "../routing/trunk-capacity";
import { VoicemailMailboxRpcSource } from "../routing/voicemail-mailbox.source";
import { dtmfEventFrom } from "../verbs/dtmf-inbox";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import { callDirectionFrom, dialStringOr, hangupSideFor } from "./ari-mapping";
import { CallControl, pickupGroupFilter } from "./call-control";
import { CallControlRegistry } from "./call-control-registry";
import { buildCdrLegWrite } from "./cdr-leg";
import { ChannelAggregate } from "./channel-aggregate";
import {
	callIdForAriChannel,
	legIdForAriChannel,
	normalizeSipCallId,
	resolveOrganizationId,
	SIP_CALL_ID_CHANNEL_FUNCTION,
	SIP_CALL_ID_VARIABLE,
} from "./channel-identity";
import { ChannelRegistry } from "./channel-registry";
import { MidCallFeatureRuntime } from "./mid-call-features";
import { planOriginate } from "./originate-plan";
import type { EngineEnv } from "../config/engine-env";
import type { MediaChannelSnapshot, MediaEvent } from "../media/media-event";
import type { MediaPort } from "../media/media-port";
import type { OriginatePlacement } from "../nats/originate.service";
import type { PlanDestination } from "../routing/plan-destination";
import type {
	OriginatedLeg,
	OriginatedLegHooks,
	PlanWalkerSettings,
	VoicemailPort,
	WalkerCallControl,
	WalkerChannel,
} from "../routing/plan-walker";
import type { VerbChannelContext, VerbExecutorRuntime } from "../verbs/verb-executor";
import type {
	CallControlHost,
	ControlledLeg,
	ParkLot,
	PickupCandidate,
	RouteOutcome,
	RouteRequest,
} from "./call-control";
import type { CallDirection, CallEvent, LegSide, OriginateRequest } from "@optimiq-voice/events";
import type {
	ExecutionPlan,
	ParkPlanNode,
	ResolvedRoute,
	RoutingArtifact,
} from "@optimiq-voice/routing";
import type {
	CallerProfile,
	CallState,
	ChannelSnapshot,
	HangupCause,
	Verb,
	VerbResult,
} from "@optimiq-voice/telephony";

/** Channel variables the routing walk writes back, so the KV mirror carries the decision too. */
const DESTINATION_TYPE_VARIABLE = "OPTIMIQ_DESTINATION_TYPE";
const DESTINATION_REF_VARIABLE = "OPTIMIQ_DESTINATION_REF";
/**
 * The leg this one was bridged to.
 *
 * A variable rather than a live lookup across the registry, because the peer relationship is torn
 * down before both CDRs are written: the first leg to die releases the bridge, and a lookup would
 * find nothing for the second. Written on BOTH legs at bridge time, so each one's record carries
 * the other's id whichever dies first — and, being a channel variable, it survives into the KV
 * snapshot an instance taking over a failover reads.
 */
const BRIDGE_PEER_VARIABLE = "OPTIMIQ_BRIDGE_PEER_LEG_ID";
/** Stable terminal identities and progress persisted for an acknowledged retry after failover. */
const CDR_ID_VARIABLE = "OPTIMIQ_CDR_ID";
const CDR_HANGUP_CAUSE_CODE_VARIABLE = "OPTIMIQ_CDR_HANGUP_CAUSE_CODE";
const TERMINAL_HANGUP_EVENT_ID_VARIABLE = "OPTIMIQ_TERMINAL_HANGUP_EVENT_ID";
const TERMINAL_DESTROYED_EVENT_ID_VARIABLE = "OPTIMIQ_TERMINAL_DESTROYED_EVENT_ID";
const TERMINAL_EVENTS_PUBLISHED_VARIABLE = "OPTIMIQ_TERMINAL_EVENTS_PUBLISHED";
const CDR_RETRY_INITIAL_DELAY_MS = 100;
const CDR_RETRY_MAX_DELAY_MS = 30_000;

function cdrRetryDelay(attempt: number): number {
	const exponent = Math.min(Math.max(0, attempt), 16);
	return Math.min(CDR_RETRY_INITIAL_DELAY_MS * 2 ** exponent, CDR_RETRY_MAX_DELAY_MS);
}

/**
 * The channel orchestrator — the engine's core.
 *
 * ## What it does, in one sentence
 *
 * Turns {@link MediaEvent}s into domain state transitions, publishes the resulting facts on NATS,
 * mirrors live state into KV, and emits one CDR per finished leg.
 *
 * ## It does not know which media server it is talking to
 *
 * Commands go out through {@link MediaPort} and events come in as {@link MediaEvent}; neither
 * names Asterisk. `media/ari-connection.service.ts` translates the event direction at the socket
 * and `media/ari-media.adapter.ts` translates the command direction, both over the table in
 * `ari-mapping.ts`. Nothing in this file has an ARI concept in it, which is what makes the
 * `apps/mediad` cutover a change to two adapters rather than a rewrite of the 1,800 lines below.
 *
 * ## The invariants it exists to hold
 *
 * 1. **Every state move is guarded.** `assertChannelTransition` runs before the write, inside
 *    {@link ChannelAggregate}. An impossible transition throws rather than corrupting the
 *    snapshot other instances will read out of KV.
 * 2. **The hangup cause is fixed once.** The first cause wins; the cause the leg's end reports
 *    later cannot overwrite it. That is what makes the per-leg CDR reproducible from the events.
 * 3. **A call with no resolvable organization is REJECTED, never guessed.** Filing a call under
 *    the wrong tenant is both a billing error and an isolation breach, and both are silent.
 * 4. **Nothing here throws into the ARI socket.** A handler that throws inside a WebSocket
 *    callback is an unhandled rejection that takes the process — and therefore every live call —
 *    down. Failures are logged and, where they are the call's problem, the call is hung up.
 * 5. **One live leg has one engine owner.** Before local state is created, the replica takes the
 *    canonical `channels` KV key with compare-and-set. A loser neither admits nor hangs up the leg;
 *    broadcast media events still reach every replica, and only the winner has registry state
 *    capable of acting on them.
 *
 * ## Routing
 *
 * Since P3 there IS routing: `RoutingArtifactSource` supplies the organization's compiled artifact,
 * `packages/routing`'s resolvers turn the call's facts into an `ExecutionPlan`, and
 * {@link PlanWalker} executes it. This class stays the owner of channel STATE and of the event
 * stream; it does not know what a ring group is.
 *
 * The walk runs DETACHED (see {@link runRoutedProgram}). It has to: an IVR that waits ten seconds
 * for a digit is waiting on media events that arrive through this same handler, so awaiting the
 * walk inside the arrival handler would deadlock the call against itself.
 *
 * ## Two kinds of channel
 *
 * An arriving leg is either a NEW inbound call or a leg the plan walker originated. They are told
 * apart by {@link CallSignalBus}: the walker subscribes to a leg's key before it originates, so a
 * watched key means "this is ours, do not file it as a new call". Getting that backwards would file
 * every B-leg as an inbound call with its own CDR.
 */
@Injectable()
export class ChannelOrchestrator implements OnApplicationShutdown {
	private readonly logger = getLogger("engine.calls");
	private readonly registry = new ChannelRegistry();
	/** Detached routing walks, so the drain and the integration suite can await settlement. */
	private readonly walks = new Map<string, Promise<void>>();
	private draining = false;
	/** Hold, transfer, park, pickup and on-demand recording, over the ports below. */
	private readonly control: CallControl;
	/** `*1` / `*3` / `*5` pressed mid-conversation, and the attended-transfer cancel key. */
	private readonly midCall: MidCallFeatureRuntime;
	/**
	 * Live channel counts per trunk, so `trunk.max_channels` is a ceiling rather than a column.
	 *
	 * Held here, beside `registry`, because the two have the same lifetime and the same honest
	 * limitation: they are this instance's view. See `trunk-capacity.ts`.
	 */
	private readonly trunkCapacity = new TrunkCapacityRegistry();
	/**
	 * The max-call-duration cut-off, per answered A-leg.
	 *
	 * Keyed by media channel id and cleared the moment the leg ends, so a timer never outlives the
	 * call it was armed for. See {@link ChannelOrchestrator.armCallDurationCeiling}.
	 */
	private readonly durationCeilings = new Map<string, ReturnType<typeof setTimeout>>();
	/** One capped-backoff terminal reporting retry timer per leg. */
	private readonly cdrRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly cdrRetryAttempts = new Map<string, number>();
	/** Coalesces a timer, a redelivered terminal event and startup recovery onto one reporting attempt. */
	private readonly cdrWrites = new Map<string, Promise<void>>();
	private cdrRetriesStopped = false;
	private ownershipMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
	private ownershipMaintenance: Promise<void> | undefined;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		@Inject(MEDIA_PORT) private readonly media: MediaPort,
		@Inject(CALLS_EFFECT_RUNTIME) private readonly runtime: VerbExecutorRuntime,
		private readonly dtmf: DtmfRegistry,
		private readonly events: CallEventPublisher,
		private readonly jetstream: JetStreamService,
		private readonly routing: RoutingArtifactSource,
		private readonly mailbox: VoicemailMailboxRpcSource,
		private readonly extensionFeatures: ExtensionFeatureRpcPort,
		private readonly lastCaller: LastCallerRpcSource,
		private readonly didIndex: DidIndexSource,
		private readonly signals: CallSignalBus,
		private readonly conferences: ConferenceRegistry,
		private readonly queueMembership: QueueMembershipSource,
		private readonly agentState: AgentStateStore,
		private readonly queueEvents: QueueEventPublisher,
		private readonly queuePositions: QueuePositions,
		private readonly queueCursors: QueueCursors,
		private readonly parks: ParkRegistry,
		private readonly callControl: CallControlRegistry,
		private readonly parkHandoff: ParkHandoffService,
		private readonly sipTransfer: SipTransferService,
		private readonly originate: OriginateService,
	) {
		this.control = new CallControl({
			media: this.media,
			signals: this.signals,
			parks: this.parks,
			host: this.callControlHost(),
			parkHandoff: this.parkHandoff,
			// A getter rather than the runtime itself: `this.midCall` is built from `this.control`, so
			// it does not exist yet at this point in the constructor.
			consultationKeys: {
				arm: (mediaChannelId, digit) => {
					this.midCall.armCancelKey(mediaChannelId, digit);
				},
				disarm: (mediaChannelId) => {
					this.midCall.disarmCancelKey(mediaChannelId);
				},
			},
			settings: {
				application: this.env.ARI_APP,
				recordingFormat: this.env.ENGINE_RECORDING_FORMAT,
			},
			log: (message, detail) => {
				this.logger.info(detail ?? {}, message);
			},
		});
		this.midCall = new MidCallFeatureRuntime({
			control: this.control,
			artifactFor: async (organizationId) => await this.routing.get(organizationId),
			log: (message, detail) => {
				this.logger.info(detail ?? {}, message);
			},
		});
		// Published rather than injected, because the verb executor's runtime is built BEFORE this
		// class and reads the binding lazily. See `call-control-registry.ts` for the cycle.
		this.callControl.register({
			port: this.control,
			legFor: (mediaChannelId) => this.controlledLegFor(mediaChannelId),
		});
		// The other end of the same feature: this instance answers for the calls IT has parked. A
		// drain refuses rather than half-performing one — the retriever is told to look elsewhere,
		// and the caller rings back to whoever parked them when the lot times out.
		this.parkHandoff.setHandler(async (request) =>
			this.draining
				? {
						ok: false,
						parkLotId: request.parkLotId,
						slot: request.slot,
						instanceId: this.parks.instanceId,
						reason: "shutting_down",
						error: "this instance is draining",
					}
				: await this.control.acceptParkHandoff(request),
		);
		// A desk phone's TRANSFER key, which reaches the engine as a REFER relayed by `apps/sipd`.
		// Pushed here for the same reason the park handler is: the responder is constructed by the
		// NATS module long before this class, and pulling would be a Nest cycle.
		this.sipTransfer.attach({
			// A draining instance answers as though it holds no such call, and that is honest rather
			// than evasive: it is about to hang its remaining legs up, so a transfer accepted now would
			// start a routing walk this process abandons halfway through somebody's hold music.
			resolveDialog: async (request) =>
				this.draining ? undefined : this.resolveSipDialog(request.sipCallId),
			legFor: (mediaChannelId) => this.controlledLegFor(mediaChannelId),
			isDialableTarget: async (leg, destination) => await this.isDialableFromLeg(leg, destination),
			transfer: async (leg, request) => await this.control.transfer(leg, request),
		});
		// Click-to-call, arriving from `apps/api` on `rpc.engine.v1.originate`. Same push, same reason.
		this.originate.attach({
			place: async (request) => await this.placeOriginatedCall(request),
		});
	}

	/** Live legs this instance is handling. `/healthz` and the drain both read it. */
	get activeChannelCount(): number {
		return this.registry.size;
	}

	get isDraining(): boolean {
		return this.draining;
	}

	/** Routing walks still in flight. */
	get activeWalkCount(): number {
		return this.walks.size;
	}

	/**
	 * Settles every in-flight routing walk.
	 *
	 * Exists for the drain and for the integration suite, which needs a deterministic point at
	 * which "the call has been routed" is true. Never throws: a walk that failed has already
	 * logged, and its call has already been hung up.
	 */
	async awaitWalks(): Promise<void> {
		await Promise.allSettled(this.walks.values());
	}

	/** Rebuilds the local aggregate registry after the selected media event source starts buffering. */
	async hydrateChannels(now = Date.now()): Promise<number> {
		let hydrated = 0;
		for await (const snapshot of this.jetstream.channelSnapshots()) {
			if (await this.hydrateChannel(snapshot, now)) {
				hydrated += 1;
			}
		}

		this.startOwnershipMaintenance();
		this.logger.info({ channels: hydrated }, "hydrated channel state from KV");
		return hydrated;
	}

	/** Renews local leases and adopts snapshots whose previous owner stopped heartbeating. */
	async maintainChannelOwnership(now = Date.now()): Promise<void> {
		if (this.draining) {
			return;
		}
		const inFlight = this.ownershipMaintenance;
		if (inFlight !== undefined) {
			await inFlight;
			return;
		}

		const maintenance = this.runChannelOwnershipMaintenance(now);
		this.ownershipMaintenance = maintenance;
		try {
			await maintenance;
		} finally {
			if (this.ownershipMaintenance === maintenance) {
				this.ownershipMaintenance = undefined;
			}
		}
	}

	private async runChannelOwnershipMaintenance(now: number): Promise<void> {
		const fenced = new Set<string>();
		for (const aggregate of this.registry.all) {
			const renewed = await this.jetstream.renewChannel(aggregate.snapshot, now);
			if (renewed === "lost") {
				await this.fenceChannel(aggregate, "the channels KV revision changed");
				fenced.add(aggregate.ariChannelId);
				continue;
			}
			if (renewed === "unavailable") {
				const expiresAt = this.jetstream.ownedChannelLeaseExpiresAt(aggregate.snapshot);
				if (expiresAt === undefined || now >= expiresAt) {
					await this.fenceChannel(
						aggregate,
						expiresAt === undefined
							? "no acknowledged lease expiry is available"
							: `the last acknowledged lease expired at ${String(expiresAt)}`,
					);
					fenced.add(aggregate.ariChannelId);
				}
			}
		}

		for await (const snapshot of this.jetstream.channelSnapshots()) {
			try {
				if (fenced.has(ChannelAggregate.hydrate(snapshot).ariChannelId)) {
					continue;
				}
			} catch {
				// Let the ordinary hydration path log the malformed snapshot with its channel identity.
			}
			await this.hydrateChannel(snapshot, now);
		}
	}

	private async hydrateChannel(snapshot: ChannelSnapshot, now: number): Promise<boolean> {
		try {
			const candidate = ChannelAggregate.hydrate(snapshot);
			if (this.registry.byAriChannelId(candidate.ariChannelId) !== undefined) {
				return false;
			}
			const claim = await this.jetstream.adoptChannel(snapshot, now);
			if (claim !== "claimed") {
				return false;
			}
			const recoverable =
				(await this.jetstream.readChannel(
					snapshot.organizationId,
					snapshot.callId,
					snapshot.channelId,
				)) ?? snapshot;

			if (recoverable.state === "destroyed") {
				await this.jetstream.deleteChannel(recoverable);
				return false;
			}

			const aggregate = ChannelAggregate.hydrate(recoverable);
			this.registry.add(aggregate);
			const sipCallId = normalizeSipCallId(recoverable.variables[SIP_CALL_ID_VARIABLE]);
			if (sipCallId !== undefined) {
				this.registry.indexSipDialog(aggregate, sipCallId);
			}
			try {
				await this.media.watchChannel(aggregate.ariChannelId);
			} catch (error) {
				this.logger.warn(
					{ ariChannelId: aggregate.ariChannelId, err: String(error) },
					"could not restore the channel event subscription",
				);
			}
			if (aggregate.state === "reporting") {
				await this.finishReporting(aggregate, this.cdrCauseCodeFor(aggregate, 0));
			}
			return true;
		} catch (error) {
			this.logger.warn(
				{ channelId: snapshot.channelId, callId: snapshot.callId, err: String(error) },
				"ignored a channel snapshot that cannot be recovered",
			);
			return false;
		}
	}

	private async fenceChannel(aggregate: ChannelAggregate, reason: string): Promise<void> {
		if (this.registry.byAriChannelId(aggregate.ariChannelId) !== aggregate) {
			return;
		}
		aggregate.detach();
		this.registry.remove(aggregate);
		this.dtmf.release(aggregate.channelId);
		this.midCall.release(aggregate.ariChannelId);
		this.disarmCallDurationCeiling(aggregate.ariChannelId);
		this.clearCdrRetry(aggregate.ariChannelId);
		await this.jetstream.releaseChannelOwnership(aggregate.snapshot);
		this.logger.warn(
			{ channelId: aggregate.channelId, callId: aggregate.callId, reason },
			"stopped handling a channel after losing its ownership lease",
		);
	}

	private startOwnershipMaintenance(): void {
		if (this.draining || this.ownershipMaintenanceTimer !== undefined) {
			return;
		}
		this.ownershipMaintenanceTimer = setInterval(() => {
			void this.maintainChannelOwnership().catch((error: unknown) => {
				this.logger.error({ err: String(error) }, "channel ownership maintenance failed");
			});
		}, CLAIM_HEARTBEAT_INTERVAL_MS);
		this.ownershipMaintenanceTimer.unref?.();
	}

	private stopOwnershipMaintenance(): void {
		if (this.ownershipMaintenanceTimer !== undefined) {
			clearInterval(this.ownershipMaintenanceTimer);
			this.ownershipMaintenanceTimer = undefined;
		}
	}

	/**
	 * The single entry point for media events.
	 *
	 * Never throws: the caller is a socket message callback (see invariant 4). Returns a promise
	 * so the integration suite can await settlement; the socket itself does not await it, because
	 * blocking the event loop on one channel's work would delay every other channel's events.
	 */
	async handleEvent(event: MediaEvent): Promise<void> {
		try {
			await this.dispatch(event);
		} catch (error) {
			this.logger.error(
				{ type: event.type, err: String(error) },
				"unhandled failure while processing a media event",
			);
		}
	}

	/**
	 * One branch per member of {@link MediaEvent}, and no `default:`.
	 *
	 * Exhaustive on purpose: the media server no longer decides what the engine ignores — the
	 * mapping does, in `toMediaEvent`, where the drop can be named and tested. Adding a member to
	 * the union without handling it here is now a compile error rather than silence on a live call.
	 */
	private async dispatch(event: MediaEvent): Promise<void> {
		switch (event.type) {
			case "leg-arrived":
				await this.onLegArrived(event.channel);
				return;
			case "call-state-changed":
				await this.onCallStateChanged(event.channelId, event.callState);
				return;
			case "dtmf-received":
				await this.onDtmf(event.channelId, event.digit, event.durationMs);
				return;
			case "hangup-requested":
				this.onHangupRequested(event.channelId, event.cause);
				return;
			case "leg-left":
				this.onLegLeft(event.channelId);
				return;
			case "leg-ended":
				await this.onLegEnded(event.channelId, event.cause, event.causeCode);
				return;
			case "variable-set":
				this.onVariableSet(event.channelId, event.variable, event.value);
				return;
			case "leg-held":
				await this.onPhoneHold(event.channelId, true, event.musicClass);
				return;
			case "leg-unheld":
				await this.onPhoneHold(event.channelId, false);
				return;
			case "recording-started":
				this.signals.emit(recordingSignalKey(event.recordingName), {
					kind: "recording-started",
				});
				return;
			case "recording-finished":
				this.signals.emit(recordingSignalKey(event.recordingName), {
					kind: "recording-finished",
					durationMs: event.durationMs,
				});
				return;
			case "recording-failed":
				this.signals.emit(recordingSignalKey(event.recordingName), {
					kind: "recording-failed",
					reason: event.reason,
				});
				return;
		}
	}

	// -------------------------------------------------------------------------------------------
	// Call entry
	// -------------------------------------------------------------------------------------------

	private async onLegArrived(channel: MediaChannelSnapshot): Promise<void> {
		if (this.signals.isWatched(legSignalKey(channel.id))) {
			// A leg the plan walker originated has reached the application. It is NOT a new inbound
			// call: filing it as one would give the callee's own leg a `channel.created`, an
			// organization lookup it has no variables for, and a second CDR for one call.
			this.signals.emit(legSignalKey(channel.id), { kind: "entered" });
			// AFTER the signal and never before. The dial resolves on it, so a media-server round trip
			// inserted ahead of it would add a whole RTT to every ring-group answer — and this read is
			// only wanted so a desk phone that ANSWERED can press TRANSFER, which cannot happen for at
			// least as long as it takes somebody to pick up.
			await this.recordSipDialog(channel);
			return;
		}

		if (this.registry.byAriChannelId(channel.id) !== undefined) {
			// A masquerade (attended transfer completing, a pickup) can re-deliver an arrival for a
			// channel already being tracked. Re-creating the aggregate would reset its state
			// machine and lose the answer instant.
			//
			// The dialog IS re-read, because a masquerade is precisely the event that moves one: the
			// SIP dialog the phone is in has been swapped onto a different media channel, and an index
			// still pointing at the old one would answer a REFER with a leg that no longer has the call.
			await this.recordSipDialog(channel);
			return;
		}

		if (this.draining || !this.registry.isAccepting) {
			// Rejected at the door with a cause the carrier understands, so the call fails over to
			// another instance instead of being answered by a process that is about to exit.
			this.logger.info({ ariChannelId: channel.id }, "rejecting a new call: draining");
			await this.hangupQuietly(channel.id, "NORMAL_TEMPORARY_FAILURE");
			return;
		}

		const variables = await this.readEngineVariables(channel);

		if (variables.OPTIMIQ_LEG === "b") {
			// A leg an engine ORIGINATED, identified by the variable the walker exports onto it.
			//
			// The watched-key check above is the fast path but it is not sufficient on its own: a
			// dial resolves on the FIRST signal it gets, and when the answer beats the arrival the
			// walker has already unsubscribed by the time this lands. That window is small, real,
			// and the failure it produces is the worst kind — the callee's own leg filed as a
			// second inbound call, resolved against the DID table it was never dialled on, and
			// given a CDR of its own.
			this.logger.debug(
				{ ariChannelId: channel.id, exten: channel.dialedNumber },
				"a leg this engine originated reached the application",
			);
			this.signals.emit(legSignalKey(channel.id), { kind: "entered" });
			return;
		}

		const organizationId = await this.attributeCall(channel, variables);

		if (organizationId === undefined) {
			// Invariant 3. `INVALID_PROFILE` is the honest cause: the call reached us without the
			// routing context that says who it belongs to, and nothing on the platform could supply it.
			this.logger.error(
				{ ariChannelId: channel.id, exten: channel.dialedNumber },
				"rejecting a call with no resolvable organization (no OPTIMIQ_ORG_ID, and the dialled " +
					"number is not in the did-index bucket)",
			);
			await this.hangupQuietly(channel.id, "INVALID_PROFILE");
			return;
		}

		const direction = callDirectionFrom(variables.OPTIMIQ_CALL_DIRECTION);
		const admittedAt = Date.now();
		const aggregate = ChannelAggregate.create({
			ariChannelId: channel.id,
			channelId: legIdForAriChannel(channel.id),
			callId: callIdForAriChannel(channel.id),
			organizationId,
			direction,
			leg: "a",
			profile: profileFrom(channel, variables.OPTIMIQ_ROUTING_CONTEXT),
			variables: {
				...definedOnly(variables),
				[CHANNEL_OWNER_INSTANCE_VARIABLE]: this.env.ENGINE_INSTANCE_ID,
				[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]: String(admittedAt + CHANNEL_OWNERSHIP_LEASE_MS),
			},
			createdAt: admittedAt,
		});

		const claim = await this.jetstream.claimChannel(aggregate.snapshot, admittedAt);
		if (claim !== "claimed") {
			// Never hang up here: `owned` means the winner is actively serving this exact leg, and
			// `unavailable` cannot prove that no winner exists. Failing closed avoids split ownership.
			this.logger.info(
				{
					mediaChannelId: channel.id,
					organizationId,
					claim,
				},
				"not admitting a leg this replica does not exclusively own",
			);
			return;
		}

		this.registry.add(aggregate);
		// Read in the same batch as the other four variables, so indexing it costs no extra round trip.
		const sipCallId = normalizeSipCallId(variables[SIP_CALL_ID_VARIABLE]);
		if (sipCallId !== undefined) {
			this.registry.indexSipDialog(aggregate, sipCallId);
		}

		// Explicitly subscribe to this leg's events. The engine's socket is narrow on purpose
		// (`ARI_SUBSCRIBE_ALL=false`), and a narrow subscription stops the moment a channel leaves
		// the application — which is precisely when teardown starts. Without this, a call the
		// ENGINE ends reports the leg leaving and then nothing: no `channel.hangup`, no
		// `channel.destroyed`, and no CDR. Best-effort: a media server that refuses the
		// subscription is a degraded call, not a rejected one.
		try {
			await this.media.watchChannel(channel.id);
		} catch (error) {
			this.logger.warn(
				{ ariChannelId: channel.id, err: String(error) },
				"could not subscribe to this channel's events; its teardown may not be observed",
			);
		}

		// `created → initializing → routing`: the leg exists, its endpoint context is known, and
		// a destination is being resolved for it.
		aggregate.transitionTo("initializing");
		aggregate.transitionTo("routing");

		await this.events.publish("channel.created", {
			orgId: organizationId,
			callId: aggregate.callId,
			data: {
				legId: aggregate.channelId,
				leg: "a" satisfies LegSide,
				direction: direction satisfies CallDirection,
				from: {
					number: dialStringOr(channel.callerNumber),
					...(channel.callerName === undefined || channel.callerName === ""
						? {}
						: { name: channel.callerName }),
				},
				to: { number: dialStringOr(channel.dialedNumber) },
				// The field has been in the contract since P1 and nothing populated it. It is what lines
				// a call in the event stream up with a packet capture, and — now that the engine indexes
				// it — with the REFER a desk phone sends about that same dialog.
				...(sipCallId === undefined ? {} : { sipCallId }),
				...(channel.context === undefined || channel.context === ""
					? {}
					: { routingContext: channel.context }),
			},
		});
		await this.jetstream.putChannel(aggregate.snapshot);

		aggregate.transitionTo("executing");

		if (this.env.ENGINE_ROUTING_ENABLED) {
			this.startRoutedProgram(aggregate, channel);
			return;
		}
		await this.runUnroutedProgram(aggregate);
	}

	/**
	 * Which tenant this call belongs to, in the only order that is safe.
	 *
	 * 1. **`OPTIMIQ_ORG_ID` on the channel.** The SIP edge or the dialplan already decided, which is
	 *    the strongest signal there is: it was made with the INVITE in hand, including headers this
	 *    process never sees. A deployment where the edge stamps `X-Optimiq-Org-Id` lands here.
	 * 2. **The `did-index` bucket, keyed by the dialled number.** The multi-tenant path: the control
	 *    plane wrote the mapping when the number was provisioned, and `phone_number.e164` carries a
	 *    platform-wide unique index so at most one tenant can ever have claimed it.
	 * 3. **`ENGINE_DEFAULT_ORGANIZATION_ID`.** Development only, and LAST on purpose. Ordering it
	 *    above the index would make a developer box with the variable set answer every tenant's DID
	 *    as its own tenant — which is exactly the bug the index exists to prevent, reintroduced by
	 *    the fallback meant to make one box convenient.
	 *
	 * `undefined` is a rejection, never a default. There is no fourth step.
	 */
	private async attributeCall(
		channel: MediaChannelSnapshot,
		variables: Readonly<Record<string, string | undefined>>,
	): Promise<string | undefined> {
		// No fallback here: the env default is applied below, after the index has had its say.
		const stamped = resolveOrganizationId(variables);
		if (stamped !== undefined) {
			return stamped;
		}

		const dialled = channel.dialedNumber;
		const hit = await this.didIndex.organizationFor(dialled);
		if (hit !== undefined) {
			this.logger.info(
				{
					ariChannelId: channel.id,
					did: dialled,
					organizationId: hit.organizationId,
					phoneNumberId: hit.phoneNumberId,
					enabled: hit.enabled,
				},
				"attributed an inbound call from the did-index bucket",
			);
			return hit.organizationId;
		}

		const fallback = this.env.ENGINE_DEFAULT_ORGANIZATION_ID;
		if (fallback !== undefined) {
			this.logger.warn(
				{ ariChannelId: channel.id, did: dialled, organizationId: fallback },
				"no did-index entry; falling back to ENGINE_DEFAULT_ORGANIZATION_ID (development only)",
			);
			return resolveOrganizationId({}, fallback);
		}
		return undefined;
	}

	/**
	 * The pre-routing program: alert, then answer, then (on `Up`) an optional announcement.
	 *
	 * Kept, and kept working, for two cases that are not hypothetical: `ENGINE_ROUTING_ENABLED=false`
	 * in a lab, and a call whose organization has no readable artifact — at which point answering
	 * and holding the line is a better failure than a fast busy, because it is diagnosable.
	 */
	private async runUnroutedProgram(aggregate: ChannelAggregate): Promise<void> {
		for (const verb of [{ verb: "ringing" }, { verb: "answer" }] satisfies Verb[]) {
			const executed = await this.execute(aggregate, verb);
			if (executed === undefined || aggregate.isTearingDown) {
				return;
			}
		}
	}

	/**
	 * Part two of the unrouted program: whatever needs a media path.
	 *
	 * Separate from {@link runUnroutedProgram} because `answer` is a REQUEST, not a state: the
	 * command returns as soon as the media server has accepted it, and the leg only becomes active
	 * — and only gains a media path — when the far end's `200 OK` has been exchanged, which arrives
	 * as a later state change. Playing audio in the same loop as `answer` means playing it
	 * at a leg that has not answered yet, which the verb guard correctly refuses.
	 *
	 * Skipped entirely when a routing walk owns the leg: the plan decides what the caller hears,
	 * and an announcement playing over an IVR greeting is the placeholder overruling the product.
	 */
	private async runAnsweredProgram(aggregate: ChannelAggregate): Promise<void> {
		const announcement = this.env.ENGINE_INBOUND_ANNOUNCEMENT;
		if (
			announcement === undefined ||
			aggregate.isTearingDown ||
			this.walks.has(aggregate.ariChannelId)
		) {
			return;
		}
		await this.execute(aggregate, { verb: "play", media: announcement });
	}

	// -------------------------------------------------------------------------------------------
	// Routing
	// -------------------------------------------------------------------------------------------

	/**
	 * Starts the routing walk, detached.
	 *
	 * Detached is not a shortcut, it is a requirement: the walk awaits media events (a B-leg
	 * answering, a digit arriving) that are delivered through this same handler. Awaiting the walk
	 * from inside the arrival handler would make the call wait for events that cannot be processed
	 * until the call stops waiting.
	 */
	private startRoutedProgram(aggregate: ChannelAggregate, channel: MediaChannelSnapshot): void {
		const key = aggregate.ariChannelId;
		const walk = this.runRoutedProgram(aggregate, channel)
			.catch(async (error: unknown) => {
				this.logger.error(
					{ channelId: aggregate.channelId, err: String(error) },
					"the routing walk failed; the call is being torn down",
				);
				await this.hangupQuietly(aggregate.ariChannelId, "NORMAL_TEMPORARY_FAILURE");
			})
			.finally(() => {
				this.walks.delete(key);
			});
		this.walks.set(key, walk);
	}

	/**
	 * Resolves the call and walks the plan.
	 *
	 * The organization comes from the channel variable, never from a guess (invariant 3, applied
	 * again one layer up). The ARTIFACT comes from {@link RoutingArtifactSource}; when it cannot be
	 * obtained the call falls back to the unrouted program rather than being dropped, because a
	 * control plane that is briefly unreachable must not silently reject every inbound call.
	 */
	private async runRoutedProgram(
		aggregate: ChannelAggregate,
		channel: MediaChannelSnapshot,
	): Promise<void> {
		const artifact = await this.routing.get(aggregate.organizationId);
		if (artifact === undefined) {
			this.logger.error(
				{ organizationId: aggregate.organizationId, channelId: aggregate.channelId },
				"no routing artifact for this organization; falling back to the unrouted program",
			);
			await this.runUnroutedProgram(aggregate);
			return;
		}

		const route = this.resolveRoute(artifact, aggregate, channel);
		if (route.blocked !== undefined) {
			this.logger.info(
				{
					channelId: aggregate.channelId,
					ruleId: route.blocked.ruleId,
					action: route.blocked.action,
				},
				"the caller matched a call-block rule",
			);
			if (route.blocked.action === "voicemail") {
				// The resolver flags it and leaves the plan alone deliberately: which mailbox a
				// screened caller should land in is a fact only the engine has, and it does not have
				// it yet either. Recorded as a follow-up rather than diverted to a guessed box.
				this.logger.warn(
					{ channelId: aggregate.channelId, ruleId: route.blocked.ruleId },
					"call-block action 'voicemail' is not wired to a mailbox yet; the plan was walked as resolved",
				);
			}
		}

		if (route.plan === undefined) {
			this.logger.warn(
				{ channelId: aggregate.channelId, reason: route.reason },
				"the resolver produced no plan; rejecting the call",
			);
			await this.execute(aggregate, { verb: "hangup", cause: "UNALLOCATED_NUMBER" });
			return;
		}

		this.logger.info(
			{
				channelId: aggregate.channelId,
				context: route.context,
				matched: route.matched,
				entryNodeId: route.plan.entryNodeId,
				reason: route.reason,
			},
			"resolved a route",
		);

		const walker = this.walkerFor(aggregate);

		const outcome = await walker.walk({
			plan: route.plan,
			timeConditions: artifact.timeConditions,
			now: new Date(),
			...(route.dialedNumber === undefined ? {} : { dialedNumber: route.dialedNumber }),
			// What the caller actually pressed, so the Kari's Law notification can say `9911` rather
			// than the `911` the switch sent. Same precedence as the resolve above: on an originated
			// leg the digits are the ones the API was asked to dial, and the channel has none.
			...(() => {
				const pressed = aggregate.snapshot.variables.OPTIMIQ_DIALED_NUMBER ?? channel.dialedNumber;
				return pressed === undefined ? {} : { originalDialedNumber: pressed };
			})(),
			...(route.callerIdNumber === undefined ? {} : { callerIdNumber: route.callerIdNumber }),
			...(route.callerIdName === undefined ? {} : { callerIdName: route.callerIdName }),
			...(route.featureArgument === undefined ? {} : { featureArgument: route.featureArgument }),
			// The mailbox table travels with the plan so a `check` can answer "does the extension
			// this call came from have a box?" without a database handle. See `WalkInput.mailboxes`.
			mailboxes: artifact.internal.mailboxes,
		});

		await this.mirrorAfterWalk(aggregate);

		this.logger.info(
			{
				channelId: aggregate.channelId,
				status: outcome.status,
				hangupCause: outcome.hangupCause,
				destinationType: outcome.destination?.destinationType,
				visited: outcome.visited,
				notes: outcome.notes,
			},
			"the routing walk finished",
		);
	}

	/**
	 * Builds a plan walker over this leg.
	 *
	 * One factory, two callers: the inbound routing walk, and every re-route a call-control feature
	 * asks for — a blind transfer's destination, an attended transfer's consultation, a park
	 * timeout's ringback. They MUST be the same walker: that is what makes a transferred call produce
	 * the same B-leg CDR, the same `channel.bridged` and the same failover branches as a call that
	 * arrived at the destination the ordinary way. Two walkers would be two behaviours, and the
	 * second one would be discovered from a support ticket.
	 */
	private walkerFor(
		aggregate: ChannelAggregate,
		extra: { readonly beforeBridge?: (bridgeId: string) => Promise<void> } = {},
	): PlanWalker {
		return new PlanWalker({
			media: this.media,
			signals: this.signals,
			channel: walkerChannelFor(aggregate),
			execute: (verb) => this.execute(aggregate, verb),
			publish: (type, data) => this.publishCallEvent(aggregate, type, data),
			settings: this.walkerSettings(),
			peerLegId: legIdForAriChannel,
			legs: this.legHooksFor(aggregate),
			voicemail: this.voicemailPortFor(aggregate),
			mailbox: this.mailbox,
			// The two self-service seams: the WRITE behind `*72`/`*74`/`*76`/`*78`/`*21` and the ledger
			// read behind `*69`. Both are stateless over the shared rpc client, so one instance serves
			// every walk — see `routing.module.ts`.
			features: this.extensionFeatures,
			lastCaller: this.lastCaller,
			// `greetings` is deliberately ABSENT, and `*99` therefore announces "not available" and
			// records nothing.
			//
			// The runtime is complete (`PlanWalker.recordGreetingCode`) and so is the port; what does not
			// exist is a CONTRACT to carry a recorded greeting to the control plane. A greeting is not a
			// `voicemail.message.left` — filing one is a two-row write (clear the incumbent, activate the
			// new one) inside a recompile, which `voicemail-greetings.service.ts` explains at length and
			// which `voicemailMessageLeftDataSchema` cannot express. Publishing it as a message would put
			// somebody's greeting in their own inbox and light their MWI lamp.
			//
			// Wiring a port that could not file would be the one outcome the runtime is built to avoid:
			// a user who records thirty seconds of their voice and is told it worked. So the seam stays
			// open until `packages/events` carries the subject, and the caller is told the truth in the
			// meantime.
			// The ACD plane, passed as a bundle rather than five constructor arguments to the walker:
			// a queue node needs all five or none of them, and a walk that had four would fail in the
			// middle of somebody's hold music rather than at construction.
			conferences: this.conferences,
			queue: {
				membership: this.queueMembership,
				agents: this.agentState,
				events: this.queueEvents,
				positions: this.queuePositions,
				cursor: this.queueCursors,
			},
			control: this.walkerCallControlFor(aggregate),
			trunkCapacity: this.trunkCapacity,
			onDestination: async (destination) => {
				await this.recordDestination(aggregate, destination);
			},
			...(extra.beforeBridge === undefined ? {} : { beforeBridge: extra.beforeBridge }),
			log: (message, detail) => {
				this.logger.info({ channelId: aggregate.channelId, ...detail }, message);
			},
		});
	}

	// -------------------------------------------------------------------------------------------
	// Call control
	// -------------------------------------------------------------------------------------------

	/**
	 * The call-control runtime's view of one leg.
	 *
	 * Getters throughout, for the reason {@link walkerChannelFor}'s are: a parked call sits in its
	 * orbit for minutes, and every one of these values can change underneath it.
	 *
	 * `peerMediaChannelId` is derived from the bridge-peer VARIABLE rather than from a live bridge
	 * lookup, because that variable is the one thing written on both legs at bridge time and it is
	 * what survives into the KV snapshot a failover reads.
	 */
	private controlledLegFor(mediaChannelId: string): ControlledLeg | undefined {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		return aggregate === undefined ? undefined : this.controlledLeg(aggregate);
	}

	private controlledLeg(aggregate: ChannelAggregate): ControlledLeg {
		const registry = this.registry;
		return {
			mediaChannelId: aggregate.ariChannelId,
			legId: aggregate.channelId,
			callId: aggregate.callId,
			organizationId: aggregate.organizationId,
			get isTearingDown(): boolean {
				return aggregate.isTearingDown;
			},
			get isAnswered(): boolean {
				return aggregate.isAnswered;
			},
			get bridgeId(): string | undefined {
				return aggregate.snapshot.bridgeId;
			},
			get peerMediaChannelId(): string | undefined {
				const peerLegId = aggregate.snapshot.variables[BRIDGE_PEER_VARIABLE];
				return peerLegId === undefined
					? undefined
					: registry.byDomainChannelId(peerLegId)?.ariChannelId;
			},
			get callerIdNumber(): string | undefined {
				return aggregate.snapshot.profile.callerIdNumber;
			},
			get callerIdName(): string | undefined {
				return aggregate.snapshot.profile.callerIdName;
			},
			get destinationNumber(): string | undefined {
				return aggregate.snapshot.profile.destinationNumber;
			},
			moveTo: (state) => aggregate.tryTransitionTo(state),
			moveCallStateTo: (state) => aggregate.tryCallStateTo(state),
			setBridge: (bridgeId) => {
				aggregate.setBridge(bridgeId);
			},
			setBridgePeer: (peerLegId) => {
				if (peerLegId === undefined) {
					aggregate.clearVariable(BRIDGE_PEER_VARIABLE);
				} else {
					aggregate.setVariable(BRIDGE_PEER_VARIABLE, peerLegId);
				}
				void this.jetstream.putChannel(aggregate.snapshot);
			},
			addFlag: (flag) => {
				aggregate.addFlag(flag);
			},
			removeFlag: (flag) => {
				aggregate.removeFlag(flag);
			},
			markHangup: (cause) => {
				aggregate.markHangup({ cause, at: Date.now(), initiatedByEngine: true });
			},
			detach: () => {
				aggregate.detach();
			},
		};
	}

	/** Everything the call-control runtime needs that only this class can answer. */
	private callControlHost(): CallControlHost {
		return {
			legFor: (mediaChannelId) => this.controlledLegFor(mediaChannelId),
			ringingFor: async (leg, extension) => await this.ringingCandidates(leg, extension),
			publish: async (leg, type, data) => {
				const aggregate = this.registry.byDomainChannelId(leg.legId);
				if (aggregate === undefined) {
					return;
				}
				await this.publishCallEvent(aggregate, type, data);
			},
			route: async (leg, request) => await this.routeLeg(leg, request),
			parkLotFor: async (leg, lotRef) => await this.parkLotFor(leg, lotRef),
			parkLotForSlot: async (leg, slot) => await this.parkLotForSlot(leg, slot),
		};
	}

	/** The narrow slice of call control a plan node can reach, bound to the leg being walked. */
	private walkerCallControlFor(aggregate: ChannelAggregate): WalkerCallControl {
		const leg = this.controlledLeg(aggregate);
		return {
			park: async (request) => {
				const outcome = await this.control.park(leg, {
					lot: request.parkLotId,
					...(request.orbit === undefined ? {} : { orbit: request.orbit }),
					...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
					...(request.mohClass === undefined ? {} : { musicOnHold: request.mohClass }),
				});
				return {
					ok: outcome.result.ok,
					...(outcome.slot === undefined ? {} : { slot: outcome.slot }),
					...(outcome.result.ok ? {} : { reason: outcome.result.reason }),
				};
			},
			unpark: async (request) => {
				const result = await this.control.unpark(leg, {
					lot: request.parkLotId,
					orbit: request.orbit,
				});
				return result.ok ? { ok: true } : { ok: false, reason: result.reason };
			},
			pickup: async (request) => {
				const result = await this.control.pickup(leg, {
					kind: request.kind,
					extension: request.extension,
				});
				return result.ok ? { ok: true } : { ok: false, reason: result.reason };
			},
			/**
			 * `*69`'s return call, resolved as if the caller had dialled the digits themselves.
			 *
			 * Internal FIRST and outbound only if nothing matched, which is the same two-step and the
			 * same order {@link resolveRoute} uses for a call arriving on an internal context — and it
			 * is where the toll gate lives. `routeLeg` alone would have been the internal half only,
			 * and an extension whose last caller was a mobile is the case `*69` mostly exists for.
			 *
			 * That this walks a SECOND plan on the same leg is deliberate and is not new: a blind
			 * transfer does exactly this, through this method's own `routeLeg`. The outer walk stops as
			 * soon as this returns, so the two never run at once.
			 */
			dial: async (request) => {
				const internal = await this.routeLeg(leg, {
					destination: request.destination,
					context: "internal",
				});
				if (internal.status !== "unresolved") {
					return {
						status: internal.status,
						...(internal.cause === undefined ? {} : { cause: internal.cause }),
					};
				}
				const outbound = await this.routeLeg(leg, {
					destination: request.destination,
					context: "outbound",
				});
				return {
					status: outbound.status,
					...(outbound.cause === undefined ? {} : { cause: outbound.cause }),
					...(outbound.status === "unresolved"
						? { reason: outbound.notes.join("; ") || internal.notes.join("; ") }
						: {}),
				};
			},
		};
	}

	/**
	 * Re-resolves a destination for a leg that is already up, and walks the plan it produces.
	 *
	 * The transfer context is `internal` and nothing else by default. A transfer destination that
	 * resolved in `outbound` would turn every phone with a transfer key into a way to dial anywhere
	 * on the tenant's account — the toll-fraud boundary the three separate match tables exist to
	 * hold, given away by a feature.
	 *
	 * An internal destination that matches nothing does NOT fall through to outbound here, which is
	 * the one place this deliberately differs from {@link resolveRoute}: an inbound caller dialling
	 * an unknown extension is a routing question, and a transfer to an unknown extension is a
	 * mistake somebody made on a keypad while holding a live call.
	 */
	private async routeLeg(leg: ControlledLeg, request: RouteRequest): Promise<RouteOutcome> {
		const aggregate = this.registry.byDomainChannelId(leg.legId);
		if (aggregate === undefined) {
			return { status: "unresolved", notes: ["this engine is no longer handling the leg"] };
		}

		const artifact = await this.routing.get(aggregate.organizationId);
		if (artifact === undefined) {
			return {
				status: "unresolved",
				notes: [`no routing artifact for organization ${aggregate.organizationId}`],
			};
		}

		const context = request.context ?? "internal";
		const from = request.callerIdNumber ?? aggregate.snapshot.profile.callerIdNumber ?? "";
		const now = new Date();
		const resolved =
			context === "outbound"
				? resolveOutbound(artifact, { from, dialed: request.destination, now })
				: resolveInternal(artifact, { from, dialed: request.destination, now });

		if (resolved.plan === undefined || !resolved.matched) {
			return {
				status: "unresolved",
				notes: [resolved.reason ?? `nothing matched ${request.destination} in ${context}`],
			};
		}

		// The walker's hook takes a bridge id it has no use for; the caller's takes none. Adapted here
		// rather than widening the caller's contract with an argument no call-control operation reads.
		const beforeBridge = request.beforeBridge;
		const outcome = await this.walkerFor(
			aggregate,
			beforeBridge === undefined ? {} : { beforeBridge: async () => await beforeBridge() },
		).walk({
			plan: resolved.plan as ExecutionPlan,
			timeConditions: artifact.timeConditions,
			now,
			// The digits that were dialled, so a park lot on the far side can tell a retrieval from a
			// park exactly as it would for a caller who dialled them.
			originalDialedNumber: request.destination,
			...(resolved.dialedNumber === undefined ? {} : { dialedNumber: resolved.dialedNumber }),
			...(request.callerIdNumber === undefined ? {} : { callerIdNumber: request.callerIdNumber }),
			...(request.callerIdName === undefined ? {} : { callerIdName: request.callerIdName }),
			...(resolved.featureArgument === undefined
				? {}
				: { featureArgument: resolved.featureArgument }),
			mailboxes: artifact.internal.mailboxes,
		});

		// The transferred leg's CDR says where it ENDED UP, not where it was going when the transfer
		// took it: the walker's `onDestination` hook overwrote the variables as the new walk entered
		// each destination, and the last one it entered is the one the record keeps.
		await this.mirrorAfterWalk(aggregate);

		return {
			status: outcome.status,
			...(outcome.hangupCause === undefined ? {} : { cause: outcome.hangupCause }),
			notes: outcome.notes,
		};
	}

	/**
	 * Phones this instance currently has ringing for an extension.
	 *
	 * A B-leg is what rings: the switch dialled it on behalf of somebody, and that somebody is its
	 * `OPTIMIQ_ORIGINATING_LEG_ID`. A candidate with no live originator is skipped rather than
	 * offered — picking one up would connect the picker to nobody.
	 *
	 * ## Group pickup is restricted to the caller's own group
	 *
	 * `*8` means "answer whatever is ringing IN MY GROUP", and the group now survives compilation:
	 * `extension.pickup_group` lands on the extension node and on `extensionsByNumber`, which is what
	 * lets this method turn the caller's number into a group with no database on the call path.
	 *
	 * The rule, and each half is deliberate:
	 *
	 * - The caller is in a group, and the ringing extension is in one → the groups must MATCH. This
	 *   is the case the feature exists for, and without it a receptionist answers the warehouse's
	 *   call, which reads as a phone-system bug and is not one.
	 * - The ringing extension is in NO group → it is available to anybody. Org-wide is the documented
	 *   fallback, and it is the behaviour every extension had before groups were compiled; making an
	 *   ungrouped extension unpickable instead would take a working feature away from every tenant
	 *   who has not configured groups yet.
	 * - The CALLER is in no group but the target is → refused. The caller has no group to match, and
	 *   letting them into every group would make the restriction decorative: an admin who groups half
	 *   their extensions expects the other half to be outside those groups, not inside all of them.
	 *
	 * A DIRECTED pickup (`**<ext>`) is not filtered at all. The caller named one specific extension,
	 * which is a different intent from "whatever is ringing near me" — upstream systems treat it the
	 * same way, and a directed pickup that silently refused would look like the target was not
	 * ringing.
	 */
	private async ringingCandidates(
		leg: ControlledLeg,
		extension: string,
	): Promise<readonly PickupCandidate[]> {
		const wanted = extension.trim();
		const directed = wanted !== "";
		const groups = directed ? undefined : await this.pickupGroups(leg);
		const candidates: PickupCandidate[] = [];

		for (const aggregate of this.registry.all) {
			if (
				aggregate.organizationId !== leg.organizationId ||
				aggregate.isTearingDown ||
				aggregate.snapshot.variables.OPTIMIQ_LEG !== "b" ||
				aggregate.isAnswered
			) {
				continue;
			}
			const ringingNumber = aggregate.snapshot.profile.destinationNumber;
			if (directed && ringingNumber !== wanted) {
				continue;
			}
			if (groups !== undefined && !groups(ringingNumber)) {
				continue;
			}
			const originatorLegId = aggregate.snapshot.variables.OPTIMIQ_ORIGINATING_LEG_ID;
			const caller =
				originatorLegId === undefined
					? undefined
					: this.registry.byDomainChannelId(originatorLegId);
			if (caller === undefined || caller.isTearingDown || caller.isDetached) {
				continue;
			}
			candidates.push({
				ringingLeg: this.controlledLeg(aggregate),
				callerLeg: this.controlledLeg(caller),
				ringingSinceMs: aggregate.snapshot.createdAt,
			});
		}

		return candidates.sort((left, right) => left.ringingSinceMs - right.ringingSinceMs);
	}

	/**
	 * The group filter for a group pickup, or `undefined` when this organization has no groups.
	 *
	 * The rule itself is {@link pickupGroupFilter} in `call-control.ts`, spec'd there. This method is
	 * only the artifact fetch, which is the part that needs the orchestrator.
	 */
	private async pickupGroups(
		leg: ControlledLeg,
	): Promise<((ringingNumber: string | undefined) => boolean) | undefined> {
		const artifact = await this.routing.get(leg.organizationId);
		return artifact === undefined
			? undefined
			: pickupGroupFilter(artifact.extensionsByNumber, leg.callerIdNumber);
	}

	/** The lot a park should use: the one named, or the organization's only one. */
	private async parkLotFor(leg: ControlledLeg, lotRef?: string): Promise<ParkLot | undefined> {
		const lots = await this.parkLots(leg);
		if (lotRef !== undefined && lotRef.trim() !== "") {
			return lots.find((lot) => lot.parkLotId === lotRef.trim());
		}
		// With several lots and no name there is no defensible default: parking a call in the wrong
		// lot puts it on a slot number nobody is going to dial.
		return lots.length === 1 ? lots[0] : undefined;
	}

	private async parkLotForSlot(leg: ControlledLeg, slot: number): Promise<ParkLot | undefined> {
		const lots = await this.parkLots(leg);
		return lots.find((lot) => slot >= lot.slotStart && slot <= lot.slotEnd);
	}

	/**
	 * The organization's park lots, from the compiled artifact.
	 *
	 * The RANGE comes from `internal.parkSlots` (which is what makes a dialled slot resolve) and the
	 * timeout and music come from the `park` plan node the range points at. Both halves are needed:
	 * a lot with a range and no timeout would hold a forgotten call until the process restarted.
	 */
	private async parkLots(leg: ControlledLeg): Promise<readonly ParkLot[]> {
		const artifact = await this.routing.get(leg.organizationId);
		if (artifact === undefined) {
			return [];
		}
		return artifact.internal.parkSlots.map((range) => {
			const node = artifact.nodes[range.nodeId];
			const park = node?.kind === "park" ? (node as ParkPlanNode) : undefined;
			return {
				parkLotId: range.parkLotId,
				slotStart: range.slotStart,
				slotEnd: range.slotEnd,
				...(park?.timeoutSeconds === undefined ? {} : { timeoutSeconds: park.timeoutSeconds }),
				...(park?.mohClass === undefined ? {} : { mohClass: park.mohClass }),
			};
		});
	}

	/**
	 * Gives every leg the walk originates a `ChannelAggregate`, and therefore a CDR of its own.
	 *
	 * ## Why a B-leg needs one at all
	 *
	 * A call is not one leg. A caller reaching a ring group of four produces five legs, four of which
	 * were rung, one of which answered, and three of which lost the race — and until now the system
	 * wrote ONE record, for the caller. Everything a PBX is asked about the other four is unanswerable
	 * from that record: which agent picked up, how long each phone rang before the winner did, whether
	 * a member was ringing at all, what the trunk charged for the leg that reached a mobile. The
	 * `call_legs` table has always modelled it correctly (`leg`, `originating_leg_id`, `bridge_leg_id`
	 * are its first four columns); nothing was filling the rows.
	 *
	 * ## Why the aggregate is created BEFORE the originate
	 *
	 * Because a fast-answering leg can ARRIVE before the originate's own response does. Creating the
	 * aggregate afterwards would leave a window in which the leg's events — including the one that
	 * ends it, and therefore its CDR — arrive at an orchestrator that has never heard of it.
	 *
	 * ## Direction, and what a B-leg's `toNumber` means
	 *
	 * The leg keeps the CALL's direction, not the wire's: an inbound call to a ring group produces
	 * B-legs the switch dialled outward, but they are part of an inbound call and reporting them as
	 * outbound would put a company's incoming volume in its outbound column. `fromNumber` is the
	 * caller identity the leg was asked to present and `toNumber` is what it was asked to reach,
	 * which is the pair a human reads as "who rang whom".
	 */
	private legHooksFor(aLeg: ChannelAggregate): OriginatedLegHooks {
		return {
			originated: async (leg) => {
				if (this.registry.byAriChannelId(leg.mediaChannelId) !== undefined) {
					return;
				}
				const admittedAt = Date.now();
				const bLeg = ChannelAggregate.create({
					ariChannelId: leg.mediaChannelId,
					channelId: legIdForAriChannel(leg.mediaChannelId),
					// The A-leg's call id, so every leg of one call shares a subject and a `call_id`.
					callId: aLeg.callId,
					organizationId: aLeg.organizationId,
					direction: callDirectionFrom(aLeg.snapshot.variables.OPTIMIQ_CALL_DIRECTION),
					leg: "b",
					profile: {
						callerIdName: aLeg.snapshot.profile.callerIdName,
						callerIdNumber: aLeg.snapshot.profile.callerIdNumber,
						ani: aLeg.snapshot.profile.ani,
						destinationNumber: leg.destinationNumber,
						context: aLeg.snapshot.profile.context,
						channelName: leg.endpoint,
						source: "ari",
					},
					variables: {
						OPTIMIQ_LEG: "b",
						OPTIMIQ_ORIGINATING_LEG_ID: aLeg.channelId,
						[CHANNEL_OWNER_INSTANCE_VARIABLE]: this.env.ENGINE_INSTANCE_ID,
						[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]: String(admittedAt + CHANNEL_OWNERSHIP_LEASE_MS),
						...(leg.destinationType === undefined
							? {}
							: { [DESTINATION_TYPE_VARIABLE]: leg.destinationType }),
						...(leg.destinationRef === undefined
							? {}
							: { [DESTINATION_REF_VARIABLE]: leg.destinationRef }),
					},
					createdAt: admittedAt,
				});
				const claim = await this.jetstream.claimChannel(bLeg.snapshot, admittedAt);
				if (claim !== "claimed") {
					throw new Error(`cannot originate ${leg.mediaChannelId}: channel ownership is ${claim}`);
				}
				this.registry.add(bLeg);
				// A B-leg is created, then immediately dialled: `initializing` is the state that says
				// "the endpoint is known, the INVITE has not gone out yet".
				bLeg.transitionTo("initializing");
				bLeg.transitionTo("routing");
				bLeg.transitionTo("executing");
				await this.publishBLegCreated(bLeg, aLeg, leg);
			},
			hangingUp: (mediaChannelId, cause) => {
				const aggregate = this.registry.byAriChannelId(mediaChannelId);
				// First-wins, so this only lands when nothing has decided the cause yet — which is
				// exactly the case it exists for: the walker's own `LOSE_RACE` / `ORIGINATOR_CANCEL`,
				// which the media server is about to overwrite with a generic code.
				aggregate?.markHangup({ cause, at: Date.now(), initiatedByEngine: true });
			},
			bridged: (mediaChannelId, bridgeId) => {
				const bLeg = this.registry.byAriChannelId(mediaChannelId);
				if (bLeg === undefined) {
					return;
				}
				bLeg.setBridge(bridgeId);
				bLeg.tryTransitionTo("exchanging-media");
				// Both directions, now, while both legs are still up. See `BRIDGE_PEER_VARIABLE`.
				bLeg.setVariable(BRIDGE_PEER_VARIABLE, aLeg.channelId);
				aLeg.setVariable(BRIDGE_PEER_VARIABLE, bLeg.channelId);
				void this.jetstream.putChannel(bLeg.snapshot);
				void this.jetstream.putChannel(aLeg.snapshot);
			},
		};
	}

	/**
	 * Where a recorded message goes.
	 *
	 * The walk records the audio and knows which box it belongs to; this turns that into the
	 * `voicemail.message.left` fact and puts it on the backbone with an ack. The engine deliberately
	 * does NOT write the `voicemail_message` row itself: it holds no database handle, the row lives
	 * in the control plane's bounded context, and an engine that opened a second Postgres connection
	 * to file a mailbox row would put a database on the call path for the first time.
	 *
	 * The envelope is validated before it is published, for the same reason the CDR's is: an event
	 * that fails its own schema at the consumer is a message nobody can file, discovered hours later.
	 */
	private voicemailPortFor(aggregate: ChannelAggregate): VoicemailPort {
		return {
			messageLeft: async (message) => {
				const envelope = makeVoicemailEvent("message.left", {
					orgId: aggregate.organizationId,
					mailboxId: message.voicemailBoxId,
					source: "engine",
					data: {
						messageId: message.messageId,
						mailboxNumber: message.mailboxNumber,
						callId: aggregate.callId,
						legId: aggregate.channelId,
						recordingId: message.recordingId,
						objectKey: message.objectKey,
						durationMs: message.durationMs,
						receivedAt: new Date().toISOString(),
						...(message.callerIdNumber === undefined
							? {}
							: { callerIdNumber: message.callerIdNumber }),
						...(message.callerIdName === undefined ? {} : { callerIdName: message.callerIdName }),
					},
				});
				validateEvent(envelope.subject, envelope);
				await this.jetstream.publishVoicemail(envelope);
				this.logger.info(
					{
						callId: aggregate.callId,
						mailboxId: message.voicemailBoxId,
						messageId: message.messageId,
						durationMs: message.durationMs,
						mwiEnabled: message.mwiEnabled,
					},
					"filed a voicemail message",
				);
			},
		};
	}

	/** `channel.created` for a leg the engine dialled. Best-effort: a B-leg's events are not its CDR. */
	private async publishBLegCreated(
		bLeg: ChannelAggregate,
		aLeg: ChannelAggregate,
		leg: OriginatedLeg,
	): Promise<void> {
		try {
			await this.events.publish("channel.created", {
				orgId: bLeg.organizationId,
				callId: bLeg.callId,
				data: {
					legId: bLeg.channelId,
					leg: "b" satisfies LegSide,
					direction: callDirectionFrom(
						aLeg.snapshot.variables.OPTIMIQ_CALL_DIRECTION,
					) satisfies CallDirection,
					from: {
						number: dialStringOr(bLeg.snapshot.profile.callerIdNumber),
						...(bLeg.snapshot.profile.callerIdName === undefined
							? {}
							: { name: bLeg.snapshot.profile.callerIdName }),
					},
					to: { number: dialStringOr(leg.destinationNumber) },
				},
			});
			await this.jetstream.putChannel(bLeg.snapshot);
		} catch (error) {
			this.logger.warn(
				{ channelId: bLeg.channelId, err: String(error) },
				"failed to publish channel.created for an originated leg",
			);
		}
	}

	/**
	 * Which resolver to run.
	 *
	 * The three are separate functions over separate tables because the difference between them is
	 * the toll-fraud boundary. Internal does NOT fall through to outbound implicitly: when an
	 * internal dial matches nothing the engine asks for outbound explicitly, and that second call is
	 * where the toll-class gate applies.
	 */
	private resolveRoute(
		artifact: RoutingArtifact,
		aggregate: ChannelAggregate,
		channel: MediaChannelSnapshot,
	): ResolvedRoute {
		const now = new Date();
		// The variable wins over the channel's own extension, and only an ORIGINATED leg has one:
		// an ARI origination into the Stasis application creates a channel with no dialplan, so the
		// number it is for cannot be read off it. See `OPTIMIQ_DIALED_NUMBER` in `channel-identity.ts`.
		const dialed = dialStringOr(
			aggregate.snapshot.variables.OPTIMIQ_DIALED_NUMBER ?? channel.dialedNumber,
		);
		const caller = channel.callerNumber?.trim();
		const callerName = channel.callerName?.trim();
		const context = aggregate.snapshot.variables.OPTIMIQ_ROUTING_CONTEXT;
		const direction = callDirectionFrom(aggregate.snapshot.variables.OPTIMIQ_CALL_DIRECTION);

		if (context === "outbound" || direction === "outbound") {
			return resolveOutbound(artifact, { from: caller ?? "", dialed, now });
		}
		if (context === "internal" || direction === "internal") {
			const internal = resolveInternal(artifact, { from: caller ?? "", dialed, now });
			if (internal.matched) {
				return internal;
			}
			return resolveOutbound(artifact, { from: caller ?? "", dialed, now });
		}
		return resolveInbound(artifact, {
			did: dialed,
			...(caller === undefined || caller === "" ? {} : { callerNumber: caller }),
			...(callerName === undefined || callerName === "" ? {} : { callerName }),
			now,
		});
	}

	/** The walker's deployment knobs, assembled from the engine's environment. */
	private walkerSettings(): Partial<PlanWalkerSettings> {
		return {
			application: this.env.ARI_APP,
			extensionDialTemplate: this.env.ENGINE_EXTENSION_DIAL_TEMPLATE,
			trunkDialTemplate: this.env.ENGINE_TRUNK_DIAL_TEMPLATE,
			defaultRingTimeoutSeconds: this.env.ENGINE_DEFAULT_RING_TIMEOUT_SECONDS,
			progressTimeoutSeconds: this.env.ENGINE_PROGRESS_TIMEOUT_SECONDS,
			recordingFormat: this.env.ENGINE_RECORDING_FORMAT,
			voicemailGreeting: this.env.ENGINE_VOICEMAIL_GREETING,
			unavailableAnnouncement: this.env.ENGINE_UNAVAILABLE_ANNOUNCEMENT,
			voicemailPinPrompt: this.env.ENGINE_VOICEMAIL_PIN_PROMPT,
			voicemailPinInvalidPrompt: this.env.ENGINE_VOICEMAIL_PIN_INVALID_PROMPT,
			voicemailPinAttempts: this.env.ENGINE_VOICEMAIL_PIN_ATTEMPTS,
			voicemailMenuTimeoutMs: this.env.ENGINE_VOICEMAIL_MENU_TIMEOUT_MS,
			confirmPrompt: this.env.ENGINE_CONFIRM_PROMPT,
			confirmAcceptDigit: this.env.ENGINE_CONFIRM_ACCEPT_DIGIT,
			confirmAttempts: this.env.ENGINE_CONFIRM_ATTEMPTS,
			confirmTimeoutMs: this.env.ENGINE_CONFIRM_TIMEOUT_MS,
			mediaRefs: {
				promptPrefix: this.env.ENGINE_PROMPT_MEDIA_PREFIX,
				fallbackMedia: this.env.ENGINE_UNAVAILABLE_ANNOUNCEMENT,
				objectMediaRoot: this.env.ENGINE_MEDIA_OBJECT_ROOT,
			},
		};
	}

	private async publishCallEvent(
		aggregate: ChannelAggregate,
		type: CallEvent,
		data: Record<string, unknown>,
	): Promise<void> {
		await this.events.publish(type, {
			orgId: aggregate.organizationId,
			callId: aggregate.callId,
			data: data as never,
		});
	}

	/**
	 * Runs one verb against a leg.
	 *
	 * This is the engine's Effect seam: the `ModuleEffectRuntime` the calls module provides under a
	 * Symbol token, disposed by Nest on shutdown, exactly per the oikos convention (§3).
	 *
	 * It deliberately does NOT use `runEffect`. That helper's whole job is to turn a typed failure
	 * into an `HttpException` for a request/response boundary, and an ARI event has no HTTP
	 * response to shape. A verb that fails on the event path has one meaningful outcome — the call
	 * cannot proceed — so the exit is inspected here and the failure is logged in domain terms.
	 * `runEffect` remains the seam for the session-protocol HTTP surface that lands in P3.
	 *
	 * Returns the verb's RESULT rather than a boolean, because the plan walker needs it: an IVR's
	 * `gather` is only useful if the digits come back, and `undefined` remains the single, honest
	 * "this verb did not run".
	 */
	private async execute(aggregate: ChannelAggregate, verb: Verb): Promise<VerbResult | undefined> {
		if (verb.verb === "hangup") {
			// Fix the cause BEFORE the media server is told, because the media server will not tell
			// it back. A locally-initiated teardown comes back as a hangup request carrying the
			// server's own generic code, and `markHangup` is first-wins —
			// so without this the CDR for every call the ENGINE ended would say
			// `NORMAL_UNSPECIFIED` instead of the routing decision that ended it. It is also what
			// makes `hangupSide` report `system` rather than blaming the caller.
			aggregate.markHangup({
				cause: verb.cause ?? "NORMAL_CLEARING",
				at: Date.now(),
				initiatedByEngine: true,
			});
		}

		const context: VerbChannelContext = {
			mediaChannelId: aggregate.ariChannelId,
			channelId: aggregate.channelId,
			isTearingDown: aggregate.isTearingDown,
			hasMediaPath: aggregate.isAnswered,
		};

		const exit = await this.runtime.runPromiseExit((executor) => executor.dispatch(context, verb));
		if (Exit.isSuccess(exit)) {
			return exit.value;
		}

		this.logger.warn(
			{ verb: verb.verb, channelId: aggregate.channelId, cause: Cause.pretty(exit.cause) },
			"verb execution failed",
		);
		return undefined;
	}

	// -------------------------------------------------------------------------------------------
	// Progress
	// -------------------------------------------------------------------------------------------

	private async onCallStateChanged(
		mediaChannelId: string,
		nextCallState: CallState,
	): Promise<void> {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);

		if (aggregate === undefined) {
			// Not one of this instance's A-legs. If a walk is waiting on it, it is a leg that walk
			// originated and this is the answer it is waiting for.
			this.emitLegProgress(mediaChannelId, nextCallState);
			return;
		}

		// The A-leg's own progress is published on the bus too, because `ensureAnswered` in the
		// walker waits for exactly this: `answer` is a request and `active` is the confirmation.
		this.emitLegProgress(mediaChannelId, nextCallState);

		if (aggregate.isTearingDown) {
			return;
		}

		if (!aggregate.tryCallStateTo(nextCallState)) {
			return;
		}

		if (nextCallState === "ringing") {
			await this.events.publish("channel.ringing", {
				orgId: aggregate.organizationId,
				callId: aggregate.callId,
				data: { legId: aggregate.channelId },
			});
		}

		const justAnswered = nextCallState === "active" && aggregate.markAnswered(Date.now());
		if (justAnswered) {
			// The billing clock starts here, not at bridge time.
			aggregate.tryTransitionTo("exchanging-media");
			this.armCallDurationCeiling(aggregate);
			await this.events.publish("channel.answered", {
				orgId: aggregate.organizationId,
				callId: aggregate.callId,
				data: { legId: aggregate.channelId },
			});
		}

		await this.jetstream.putChannel(aggregate.snapshot);

		// After the mirror, so a failover that happens mid-announcement sees an answered leg.
		// A-legs only: the pre-routing announcement is for the CALLER. Playing it at a callee's leg
		// the walker just dialled would talk over the person who picked up.
		if (justAnswered && legSideOf(aggregate) === "a") {
			await this.runAnsweredProgram(aggregate);
		}
	}

	private async onDtmf(mediaChannelId: string, digit: string, durationMs: number): Promise<void> {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		const pressed = digit.toUpperCase();
		if (!isDtmfDigit(pressed)) {
			this.logger.warn(
				{ digit, channelId: aggregate?.channelId ?? mediaChannelId },
				"ignoring a non-DTMF symbol",
			);
			return;
		}

		// Before the aggregate check, because the leg that most needs this has none: a leg the plan
		// walker originated is deliberately not filed as a call of its own, so its digits have no
		// inbox to land in and answer confirmation would never hear the `1`. Unwatched keys are a
		// no-op, so an ordinary A-leg pays one map lookup for it.
		this.signals.emit(legSignalKey(mediaChannelId), { kind: "dtmf", digit: pressed });

		if (aggregate === undefined) {
			return;
		}

		const event = dtmfEventFrom({ digit: pressed, durationMs });

		// The mid-call runtime gets first refusal, and ONLY when nothing is collecting: a running
		// `gather` is an application that asked for these digits, and handing one to a feature code
		// instead would break every IVR whose menu uses a star. The runtime itself refuses any leg
		// that is not bridged, which is the second half of the same guard.
		const inbox = this.dtmf.forChannel(aggregate.channelId);
		const consumed =
			!inbox.isCollecting &&
			(await this.midCall.offer(this.controlledLeg(aggregate), event.digit)) === "consumed";
		if (!consumed) {
			inbox.push(event);
		}

		// Published either way, and with no marker saying which. `channel.dtmf` is the record of what
		// the party PRESSED — a report that omitted the digits the switch acted on would be missing
		// exactly the interesting ones — and adding a `consumedBy` would be a wire-contract change
		// (schema, codegen, Go parity) for something the engine log already carries.
		await this.events.publish("channel.dtmf", {
			orgId: aggregate.organizationId,
			callId: aggregate.callId,
			data: {
				legId: aggregate.channelId,
				digit: event.digit,
				durationMs: event.durationMs,
				source: event.source,
			},
		});
	}

	/** Republishes a leg's progress on the signal bus. Unwatched keys are a no-op. */
	private emitLegProgress(ariChannelId: string, callState: CallState): void {
		const key = legSignalKey(ariChannelId);
		if (!this.signals.isWatched(key)) {
			return;
		}
		if (callState === "ringing") {
			this.signals.emit(key, { kind: "ringing" });
			return;
		}
		if (callState === "active") {
			this.signals.emit(key, { kind: "answered" });
		}
	}

	/**
	 * The phone at one end pressed hold.
	 *
	 * This is the OTHER half of hold, and the half that actually happens on a real PBX: an agent
	 * presses the key on their desk phone, the phone re-INVITEs with `sendonly`, and the engine finds
	 * out from a media event rather than from a verb. The person who needs music is the FAR END — the
	 * caller, who would otherwise hear nothing at all and conclude the call had dropped.
	 *
	 * So the engine plays music at the peer rather than at the leg the event is about, and publishes
	 * `channel.held` naming the peer, because the peer is the party a BLF subscriber and a wallboard
	 * see as held. The leg that pressed hold is not on hold; it is holding.
	 *
	 * Best-effort throughout: a music class that will not start leaves a caller in silence, which is
	 * a worse call and a much better outcome than an exception on the event socket.
	 */
	private async onPhoneHold(
		mediaChannelId: string,
		held: boolean,
		musicClass?: string,
	): Promise<void> {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		if (aggregate === undefined || aggregate.isTearingDown) {
			return;
		}
		const peerLegId = aggregate.snapshot.variables[BRIDGE_PEER_VARIABLE];
		const peer = peerLegId === undefined ? undefined : this.registry.byDomainChannelId(peerLegId);

		if (held) {
			aggregate.addFlag("hold");
		} else {
			aggregate.removeFlag("hold");
		}

		if (peer !== undefined && !peer.isTearingDown) {
			try {
				if (held) {
					await this.media.startMusicOnHold(peer.ariChannelId, musicClass);
				} else {
					await this.media.stopMusicOnHold(peer.ariChannelId);
				}
			} catch (error) {
				this.logger.warn(
					{ ariChannelId: peer.ariChannelId, held, err: String(error) },
					"could not move the far end's hold music",
				);
			}
			// `held → unheld → active`: the transient state is what lets a watcher tell "resumed" from
			// "was never held", and the machine refuses to skip it.
			if (held) {
				peer.tryCallStateTo("held");
			} else {
				peer.tryCallStateTo("unheld");
				peer.tryCallStateTo("active");
			}
			await this.events.publish(held ? "channel.held" : "channel.unheld", {
				orgId: peer.organizationId,
				callId: peer.callId,
				data: {
					legId: peer.channelId,
					...(held && musicClass !== undefined ? { mohClass: musicClass } : {}),
				} as never,
			});
			await this.jetstream.putChannel(peer.snapshot);
		}

		await this.jetstream.putChannel(aggregate.snapshot);
	}

	private onVariableSet(mediaChannelId: string, variable: string, value: string): void {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		if (aggregate === undefined || !variable.startsWith("OPTIMIQ_")) {
			return;
		}
		aggregate.setVariable(variable, value);
	}

	// -------------------------------------------------------------------------------------------
	// Teardown
	// -------------------------------------------------------------------------------------------

	/**
	 * The far end asked to hang up. Fixes the cause NOW, while it is known — the leg's end arrives
	 * later and, for a locally-initiated teardown, with a less specific code.
	 */
	private onHangupRequested(mediaChannelId: string, cause: HangupCause): void {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		if (aggregate === undefined) {
			return;
		}
		aggregate.markHangup({ cause, at: Date.now(), initiatedByEngine: false });
	}

	/** The leg left the engine's control. Teardown has begun; no further verbs will run. */
	private onLegLeft(mediaChannelId: string): void {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		if (aggregate === undefined) {
			return;
		}
		this.dtmf.release(aggregate.channelId);
		this.midCall.release(mediaChannelId);
	}

	/**
	 * The leg is gone. Durably records terminal recovery state, publishes the terminal event pair and
	 * the CDR, then clears the KV mirror.
	 *
	 * The order is load-bearing: `channel.hangup` (why it ended) before `channel.destroyed` (that
	 * it ended) before `cdr.leg.write` (what it cost), and the KV entry is only cleared once the
	 * CDR has been acknowledged — an entry that outlives its call is recoverable, a CDR that was
	 * never written is revenue.
	 */
	private async onLegEnded(
		mediaChannelId: string,
		// What the MEDIA SERVER says ended the leg, which is not necessarily what the CDR records:
		// `markHangup` is first-wins, so an earlier and more specific cause (the far end's hangup
		// request, a routing decision) keeps its place. Both are needed, hence two names.
		reportedCause: HangupCause,
		causeCode: number,
	): Promise<void> {
		// Emitted FIRST and unconditionally: a walk waiting on this leg — whether it is one it
		// originated or the A-leg it is answering — must be released before anything slow runs,
		// or a dial sits on its own ring timeout for a leg that is already gone.
		this.signals.emit(legSignalKey(mediaChannelId), {
			kind: "ended",
			cause: reportedCause,
			causeCode,
		});

		// Before the aggregate check, and unconditionally: a trunk channel this leg was holding has
		// to come back whether or not the leg was ever filed, or the ceiling ratchets down by one
		// every time a leg ends outside the registry and the trunk eventually refuses everything.
		this.trunkCapacity.releaseLeg(mediaChannelId);
		this.disarmCallDurationCeiling(mediaChannelId);

		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		if (aggregate === undefined) {
			return;
		}
		if (aggregate.state === "reporting") {
			await this.finishReporting(aggregate, causeCode);
			return;
		}
		if (aggregate.state === "destroyed") {
			return;
		}

		// BEFORE the cause is fixed and before the CDR is written, because two of these change what
		// the record says: completing an attended transfer fixes this leg's cause as
		// `ATTENDED_TRANSFER`, and stopping a recording is what puts an object key behind the call.
		try {
			await this.control.onLegEnded(mediaChannelId);
		} catch (error) {
			this.logger.warn(
				{ ariChannelId: mediaChannelId, err: String(error) },
				"a call-control operation could not be released cleanly",
			);
		}

		const at = Date.now();
		aggregate.markHangup({ cause: reportedCause, at, initiatedByEngine: false });

		this.dtmf.release(aggregate.channelId);
		this.midCall.release(mediaChannelId);

		aggregate.tryTransitionTo("hangup");
		aggregate.tryCallStateTo("hangup");

		await this.finishReporting(aggregate, causeCode);
	}

	/** Publishes retry-stable terminal facts and only then removes the aggregate and its snapshot. */
	private async finishReporting(
		aggregate: ChannelAggregate,
		fallbackCauseCode: number,
	): Promise<void> {
		const mediaChannelId = aggregate.ariChannelId;
		const inFlight = this.cdrWrites.get(mediaChannelId);
		if (inFlight !== undefined) {
			await inFlight;
			return;
		}

		this.clearCdrRetryTimer(mediaChannelId);
		const attempt = this.attemptFinishReporting(aggregate, fallbackCauseCode);
		this.cdrWrites.set(mediaChannelId, attempt);
		try {
			await attempt;
		} finally {
			if (this.cdrWrites.get(mediaChannelId) === attempt) {
				this.cdrWrites.delete(mediaChannelId);
			}
		}
	}

	private async attemptFinishReporting(
		aggregate: ChannelAggregate,
		fallbackCauseCode: number,
	): Promise<void> {
		const enteringReporting = aggregate.state === "hangup";
		if (aggregate.state === "hangup") {
			aggregate.transitionTo("reporting");
		}
		if (aggregate.state !== "reporting") {
			return;
		}

		const variables = aggregate.snapshot.variables;
		const hasTerminalEventIds =
			variables[TERMINAL_HANGUP_EVENT_ID_VARIABLE] !== undefined ||
			variables[TERMINAL_DESTROYED_EVENT_ID_VARIABLE] !== undefined;
		// Reporting snapshots written before terminal event recovery was introduced can only have
		// reached this state after publishing both events. Preserve that shipped behavior rather than
		// replaying them once with newly invented IDs during an upgrade.
		if (!enteringReporting && !hasTerminalEventIds) {
			aggregate.setVariable(TERMINAL_EVENTS_PUBLISHED_VARIABLE, "true");
		} else {
			if (variables[TERMINAL_HANGUP_EVENT_ID_VARIABLE] === undefined) {
				aggregate.setVariable(TERMINAL_HANGUP_EVENT_ID_VARIABLE, createEntityId());
			}
			if (variables[TERMINAL_DESTROYED_EVENT_ID_VARIABLE] === undefined) {
				aggregate.setVariable(TERMINAL_DESTROYED_EVENT_ID_VARIABLE, createEntityId());
			}
		}
		if (aggregate.snapshot.variables[CDR_ID_VARIABLE] === undefined) {
			aggregate.setVariable(CDR_ID_VARIABLE, createEntityId());
		}
		if (aggregate.snapshot.variables[CDR_HANGUP_CAUSE_CODE_VARIABLE] === undefined) {
			aggregate.setVariable(CDR_HANGUP_CAUSE_CODE_VARIABLE, String(fallbackCauseCode));
		}
		// A real barrier, not the best-effort live mirror. Publishing without this acknowledgement
		// would leave neither the terminal events nor a recoverable reporting snapshot after a crash.
		const persisted = await this.jetstream.persistChannel(aggregate.snapshot);
		if (!persisted) {
			this.logger.error(
				{ channelId: aggregate.channelId, callId: aggregate.callId },
				"failed to persist the terminal channel snapshot; deferring terminal reporting",
			);
			this.scheduleCdrRetry(aggregate, fallbackCauseCode);
			return;
		}

		const causeCode = this.cdrCauseCodeFor(aggregate, fallbackCauseCode);
		const cause = aggregate.hangupCause ?? "NORMAL_UNSPECIFIED";
		const side = hangupSideFor({
			leg: legSideOf(aggregate),
			initiatedByEngine: aggregate.wasHungUpByEngine,
		});
		const endedAt = aggregate.snapshot.hangupAt ?? Date.now();
		if (aggregate.snapshot.variables[TERMINAL_EVENTS_PUBLISHED_VARIABLE] !== "true") {
			const hangupPublished = await this.events.publish("channel.hangup", {
				orgId: aggregate.organizationId,
				callId: aggregate.callId,
				id: aggregate.snapshot.variables[TERMINAL_HANGUP_EVENT_ID_VARIABLE],
				at: new Date(endedAt),
				data: {
					legId: aggregate.channelId,
					cause,
					// The RAW wire code, not the code of the named cause: an unnamed Q.850 point maps
					// to `NORMAL_UNSPECIFIED`, but its number is the only evidence of what happened.
					causeCode,
					side,
				},
			});
			if (hangupPublished === undefined) {
				this.scheduleCdrRetry(aggregate, causeCode);
				return;
			}

			const destroyedPublished = await this.events.publish("channel.destroyed", {
				orgId: aggregate.organizationId,
				callId: aggregate.callId,
				id: aggregate.snapshot.variables[TERMINAL_DESTROYED_EVENT_ID_VARIABLE],
				at: new Date(endedAt),
				data: {
					legId: aggregate.channelId,
					durationMs: Math.max(0, endedAt - aggregate.snapshot.createdAt),
				},
			});
			if (destroyedPublished === undefined) {
				this.scheduleCdrRetry(aggregate, causeCode);
				return;
			}

			aggregate.setVariable(TERMINAL_EVENTS_PUBLISHED_VARIABLE, "true");
			if (!(await this.jetstream.persistChannel(aggregate.snapshot))) {
				this.logger.error(
					{ channelId: aggregate.channelId, callId: aggregate.callId },
					"failed to persist terminal event progress; deferring the CDR",
				);
				this.scheduleCdrRetry(aggregate, causeCode);
				return;
			}
		}

		const published = await this.writeCdr(aggregate, { cause, causeCode, side, endedAt });
		if (!published) {
			this.scheduleCdrRetry(aggregate, causeCode);
			return;
		}

		this.clearCdrRetry(aggregate.ariChannelId);
		aggregate.transitionTo("destroyed");
		await this.jetstream.deleteChannel(aggregate.snapshot);
		this.registry.remove(aggregate);
		await this.endBridgePeer(aggregate);
	}

	private cdrCauseCodeFor(aggregate: ChannelAggregate, fallback: number): number {
		const persisted = Number(aggregate.snapshot.variables[CDR_HANGUP_CAUSE_CODE_VARIABLE]);
		return Number.isInteger(persisted) ? persisted : fallback;
	}

	private scheduleCdrRetry(aggregate: ChannelAggregate, fallbackCauseCode: number): void {
		const mediaChannelId = aggregate.ariChannelId;
		if (
			this.cdrRetriesStopped ||
			aggregate.state !== "reporting" ||
			this.registry.byAriChannelId(mediaChannelId) !== aggregate ||
			this.cdrRetryTimers.has(mediaChannelId)
		) {
			return;
		}

		const attempt = this.cdrRetryAttempts.get(mediaChannelId) ?? 0;
		const delayMs = cdrRetryDelay(attempt);
		this.cdrRetryAttempts.set(mediaChannelId, attempt + 1);
		const timer = setTimeout(() => {
			this.cdrRetryTimers.delete(mediaChannelId);
			void this.finishReporting(aggregate, fallbackCauseCode).catch((error: unknown) => {
				this.logger.error(
					{ channelId: aggregate.channelId, callId: aggregate.callId, err: String(error) },
					"an autonomous terminal reporting retry failed unexpectedly",
				);
				this.scheduleCdrRetry(aggregate, fallbackCauseCode);
			});
		}, delayMs);
		timer.unref?.();
		this.cdrRetryTimers.set(mediaChannelId, timer);
	}

	private clearCdrRetryTimer(mediaChannelId: string): void {
		const timer = this.cdrRetryTimers.get(mediaChannelId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.cdrRetryTimers.delete(mediaChannelId);
		}
	}

	private clearCdrRetry(mediaChannelId: string): void {
		this.clearCdrRetryTimer(mediaChannelId);
		this.cdrRetryAttempts.delete(mediaChannelId);
	}

	private async stopCdrRetries(): Promise<void> {
		this.cdrRetriesStopped = true;
		for (const mediaChannelId of this.cdrRetryTimers.keys()) {
			this.clearCdrRetryTimer(mediaChannelId);
		}

		// One final immediate attempt while JetStream is still available. A remaining failure keeps
		// the reporting snapshot in KV for startup recovery rather than leaving a live timer behind.
		const reporting = this.registry.all.filter((aggregate) => aggregate.state === "reporting");
		await Promise.allSettled(
			reporting.map(
				async (aggregate) =>
					await this.finishReporting(aggregate, this.cdrCauseCodeFor(aggregate, 0)),
			),
		);
		for (const mediaChannelId of this.cdrRetryTimers.keys()) {
			this.clearCdrRetryTimer(mediaChannelId);
		}
		this.cdrRetryAttempts.clear();
	}

	/**
	 * Ends the leg this one was bridged to, once its own record is written.
	 *
	 * A bridge is two legs and a call is over when either of them goes. The walker already handles
	 * one direction — it watches the leg it originated and tears the call down when the callee hangs
	 * up — but nothing handled the other, because until B-legs were tracked there was nothing to
	 * handle it WITH: the callee's channel was invisible to this process. The visible symptom was a
	 * Local channel still holding a media port after the caller had gone, ended eventually by
	 * Asterisk's absolute timeout rather than by the call finishing.
	 *
	 * Ordered after the CDR deliberately. Hanging the peer up first would race the peer's own end
	 * against this leg's record, and the two legs of one call must not be able to interleave their
	 * teardown.
	 */
	private async endBridgePeer(aggregate: ChannelAggregate): Promise<void> {
		const peerLegId = aggregate.snapshot.variables[BRIDGE_PEER_VARIABLE];
		if (peerLegId === undefined) {
			return;
		}
		const peer = this.registry.byDomainChannelId(peerLegId);
		if (peer === undefined || peer.isTearingDown) {
			return;
		}
		peer.markHangup({ cause: "NORMAL_CLEARING", at: Date.now(), initiatedByEngine: true });
		await this.hangupQuietly(peer.ariChannelId, "NORMAL_CLEARING");
	}

	/**
	 * Records where a walk has just arrived, while the leg is still up.
	 *
	 * Written as channel variables so the KV mirror carries them too: a failover that picks this leg
	 * up from another instance must be able to write the same CDR.
	 *
	 * Called from the walker's `onDestination` hook rather than from the walk's result, and that
	 * timing is the fix for a race that produced wrong CDRs rather than merely late ones. A walk
	 * ending in a hangup — a queue nobody is staffing, an IVR out of retries — hangs the leg up from
	 * INSIDE the walk; `ChannelDestroyed` then arrives on the ARI socket and writes the CDR, and it
	 * has a real chance of getting there before the walk's own return. When it did, a caller who had
	 * demonstrably been put in a queue was filed under `destinationType: "unknown"`, and the
	 * post-walk write that followed put the leg back into the `channels` bucket a moment after the
	 * teardown had deleted it — a live-channel entry for a call that was over.
	 *
	 * A leg that has already gone is skipped rather than mirrored: see the guard below.
	 */
	private async recordDestination(
		aggregate: ChannelAggregate,
		destination: PlanDestination,
	): Promise<void> {
		aggregate.setVariable(DESTINATION_TYPE_VARIABLE, destination.destinationType);
		if (destination.destinationRef !== undefined) {
			aggregate.setVariable(DESTINATION_REF_VARIABLE, destination.destinationRef);
		}
		// The variables are set either way — an in-flight CDR reads them from the snapshot, not from
		// KV — but the bucket must not be written for a leg whose entry has already been deleted, or
		// the mirror keeps a live channel for a call that is over.
		if (aggregate.isTearingDown) {
			return;
		}
		await this.jetstream.putChannel(aggregate.snapshot);
	}

	/**
	 * Flushes the leg's snapshot once a walk is over.
	 *
	 * A walk mutates the leg as it goes — the bridge a conference put it in, the state it moved to,
	 * the destination it arrived at — and the mirror has to end up carrying all of it. This used to
	 * be folded into the post-walk destination write, which meant it happened only for a walk that
	 * FOUND a destination and, worse, happened even for a leg the walk had already hung up: the
	 * teardown deletes the entry, and a write landing after it left a live channel in the bucket for
	 * a call that was over.
	 */
	private async mirrorAfterWalk(aggregate: ChannelAggregate): Promise<void> {
		if (aggregate.isTearingDown) {
			return;
		}
		await this.jetstream.putChannel(aggregate.snapshot);
	}

	private async writeCdr(
		aggregate: ChannelAggregate,
		input: {
			readonly cause: HangupCause;
			readonly causeCode: number;
			readonly side: ReturnType<typeof hangupSideFor>;
			readonly endedAt: number;
		},
	): Promise<boolean> {
		try {
			// The destination the routing walk reached, mirrored onto the leg as channel variables
			// so it survives a failover. Absent means the leg was never routed, and the CDR says
			// `unknown` rather than inventing one.
			const destinationType = aggregate.snapshot.variables[DESTINATION_TYPE_VARIABLE];
			const destinationRef = aggregate.snapshot.variables[DESTINATION_REF_VARIABLE];
			// Set on a B-leg by `legHooksFor`, absent on an A-leg. This is what makes the four rows of
			// a ring-group call assemble back into one call: they share `callId`, and each B-leg names
			// the leg that dialled it.
			const originatingLegId = aggregate.snapshot.variables.OPTIMIQ_ORIGINATING_LEG_ID;
			const bridgeLegId = aggregate.snapshot.variables[BRIDGE_PEER_VARIABLE];
			const data = buildCdrLegWrite({
				id: aggregate.snapshot.variables[CDR_ID_VARIABLE],
				snapshot: aggregate.snapshot,
				leg: legSideOf(aggregate),
				direction: callDirectionFrom(aggregate.snapshot.variables.OPTIMIQ_CALL_DIRECTION),
				hangupCause: input.cause,
				hangupCauseCode: input.causeCode,
				hangupSide: input.side,
				endedAt: input.endedAt,
				...(originatingLegId === undefined ? {} : { originatingLegId }),
				...(bridgeLegId === undefined ? {} : { bridgeLegId }),
				...(destinationType === undefined ? {} : { destinationType }),
				...(destinationRef === undefined ? {} : { destinationRef }),
			});
			const envelope = makeCdrLegWriteEvent({
				id: data.id,
				at: new Date(input.endedAt),
				orgId: aggregate.organizationId,
				source: "engine",
				data,
			});
			validateEvent(envelope.subject, envelope);
			await this.jetstream.publishCdrLeg(envelope);
			return true;
		} catch (error) {
			// The aggregate remains in `reporting` and in KV. A redelivered terminal event, including
			// one received by a replacement process, retries this same idempotency key.
			this.logger.error(
				{ channelId: aggregate.channelId, callId: aggregate.callId, err: String(error) },
				"failed to publish the CDR for a finished leg",
			);
			return false;
		}
	}

	// -------------------------------------------------------------------------------------------
	// Drain
	// -------------------------------------------------------------------------------------------

	/**
	 * Stops accepting new calls and waits for the live ones to finish.
	 *
	 * Two phases, because they answer different questions. Closing the door is instant and makes
	 * the instance safe to remove from rotation; waiting is best-effort and bounded, because a
	 * call can legitimately last an hour and a deploy cannot.
	 *
	 * Stragglers are hung up with `NORMAL_TEMPORARY_FAILURE` rather than killed silently: the
	 * caller's carrier sees a cause it can retry on, and the CDR records that the platform ended
	 * the call, not the caller.
	 */
	async drain(timeoutMs: number = this.env.ENGINE_DRAIN_TIMEOUT_MS): Promise<void> {
		this.draining = true;
		this.stopOwnershipMaintenance();
		this.registry.closeForNewCalls();
		// Every walk is waiting on a signal that will never come once the calls are gone. Dropping
		// the waiters lets the timers fire and the walks settle instead of holding the drain open.
		this.signals.clear();
		this.midCall.clear();
		// Park timeouts and consultation watchers are the same problem one layer up: a lot's ringback
		// timer would otherwise fire during the drain and route a call on an instance that is leaving.
		this.control.clear();
		this.parks.clear();
		// Same problem again: a ceiling that fired mid-drain would hang a call up with
		// `ALLOTTED_TIMEOUT` on an instance that is already handing its work over.
		for (const timer of this.durationCeilings.values()) {
			clearTimeout(timer);
		}
		this.durationCeilings.clear();

		const deadline = Date.now() + timeoutMs;
		while (this.registry.size > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}

		const stragglers = this.registry.all;
		if (stragglers.length === 0) {
			await this.stopCdrRetries();
			return;
		}

		this.logger.warn(
			{ count: stragglers.length, timeoutMs },
			"drain deadline reached; hanging up the remaining channels",
		);
		for (const aggregate of stragglers) {
			aggregate.markHangup({
				cause: "NORMAL_TEMPORARY_FAILURE",
				at: Date.now(),
				initiatedByEngine: true,
			});
			await this.hangupQuietly(aggregate.ariChannelId, "NORMAL_TEMPORARY_FAILURE");
		}
		await this.stopCdrRetries();
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopOwnershipMaintenance();
		await this.stopCdrRetries();
	}

	// -------------------------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------------------------

	/**
	 * Arms the maximum-call-duration cut-off for an answered A-leg.
	 *
	 * ## Why the engine has to own this
	 *
	 * A call that never ends is not a rare edge: a phone that loses power mid-conversation, a
	 * carrier that drops a BYE, a bridge whose far end went away without a hangup — all of them
	 * leave a leg up, holding a licence, a trunk channel and a billing meter, until somebody
	 * notices. Neither driver has a watchdog of its own on the Asterisk path, and nothing above the
	 * engine can see a leg to hang it up.
	 *
	 * ## Why `ALLOTTED_TIMEOUT` and not a generic cause
	 *
	 * 802 has been in the taxonomy since it was written and has never been raised. A CDR that says
	 * `NORMAL_CLEARING` for a call the platform cut is a CDR that cannot answer "did we drop this
	 * customer's call, or did they hang up?" — and that question is exactly what somebody asks when
	 * they see a four-hour call on their bill.
	 *
	 * A-legs only. A B-leg is bridged to an A-leg whose ceiling covers the same conversation, and
	 * arming both would cut the same call twice and race over which cause the CDR keeps.
	 */
	private armCallDurationCeiling(aggregate: ChannelAggregate): void {
		const seconds = this.env.ENGINE_MAX_CALL_DURATION_SECONDS;
		if (!Number.isFinite(seconds) || seconds <= 0 || legSideOf(aggregate) !== "a") {
			return;
		}
		const mediaChannelId = aggregate.ariChannelId;
		this.disarmCallDurationCeiling(mediaChannelId);

		const timer = setTimeout(() => {
			this.durationCeilings.delete(mediaChannelId);
			const live = this.registry.byAriChannelId(mediaChannelId);
			if (live === undefined || live.isTearingDown) {
				return;
			}
			this.logger.warn(
				{ channelId: live.channelId, callId: live.callId, seconds },
				"a call reached the maximum call duration and was ended by the engine",
			);
			// Fixed BEFORE the hangup is issued, because `markHangup` is first-wins and the media
			// server is about to report a generic code for a teardown it did not decide.
			live.markHangup({ cause: "ALLOTTED_TIMEOUT", at: Date.now(), initiatedByEngine: true });
			void this.hangupQuietly(mediaChannelId, "ALLOTTED_TIMEOUT");
		}, seconds * 1_000);
		timer.unref?.();
		this.durationCeilings.set(mediaChannelId, timer);
	}

	/** Drops a leg's cut-off. Called on every leg end, so an unarmed leg costs one map lookup. */
	private disarmCallDurationCeiling(mediaChannelId: string): void {
		const timer = this.durationCeilings.get(mediaChannelId);
		if (timer === undefined) {
			return;
		}
		clearTimeout(timer);
		this.durationCeilings.delete(mediaChannelId);
	}

	/** Hangs a channel up without letting a media-server failure become the caller's problem. */
	private async hangupQuietly(ariChannelId: string, cause: HangupCause): Promise<void> {
		try {
			await this.media.hangup(ariChannelId, cause);
		} catch (error) {
			this.logger.warn({ ariChannelId, cause, err: String(error) }, "failed to hang up a channel");
		}
	}

	/**
	 * Reads the engine's channel variables in one pass. Absent variables come back `undefined`.
	 *
	 * Four of the five are stored under the name they are read by. The fifth is not: the SIP
	 * `Call-ID` is READ from a dialplan function and STORED under an `OPTIMIQ_` name, because a
	 * variable is what survives into the KV snapshot and what a dialplan can pre-stamp, while the
	 * function is what the media server actually answers. Hence a pair per entry rather than a name.
	 */
	private async readEngineVariables(
		channel: MediaChannelSnapshot,
	): Promise<Record<string, string | undefined>> {
		const fromEvent = channel.variables;
		const names: readonly { readonly variable: string; readonly read: string }[] = [
			{ variable: "OPTIMIQ_ORG_ID", read: "OPTIMIQ_ORG_ID" },
			{ variable: "OPTIMIQ_CALL_DIRECTION", read: "OPTIMIQ_CALL_DIRECTION" },
			{ variable: "OPTIMIQ_ROUTING_CONTEXT", read: "OPTIMIQ_ROUTING_CONTEXT" },
			// Marks a leg the engine originated. Read here rather than guessed from the dialplan,
			// because it is the only thing that is true of every originated leg and of nothing else.
			{ variable: "OPTIMIQ_LEG", read: "OPTIMIQ_LEG" },
			{ variable: SIP_CALL_ID_VARIABLE, read: SIP_CALL_ID_CHANNEL_FUNCTION },
		];
		const entries = await Promise.all(
			names.map(async ({ variable, read }) => {
				// The event's variables are only populated when the media server is configured to
				// export them with every event, so they are an optimisation, never the truth.
				const inline = fromEvent[variable] ?? fromEvent[read];
				if (inline !== undefined && inline !== "") {
					return [variable, inline] as const;
				}
				try {
					return [variable, await this.media.getVariable(channel.id, read)] as const;
				} catch {
					return [variable, undefined] as const;
				}
			}),
		);
		return Object.fromEntries(entries);
	}

	// -------------------------------------------------------------------------------------------
	// SIP dialogs
	// -------------------------------------------------------------------------------------------

	/**
	 * Records which SIP dialog a leg already in the registry is carrying, and indexes it.
	 *
	 * For the legs that do NOT go through the arrival path's variable batch: a B-leg the walker
	 * originated (whose aggregate was created before the channel existed to be read from) and a
	 * channel re-delivered by a masquerade. Both are the leg a desk phone is actually holding when
	 * its user presses TRANSFER, so skipping them would make the feature work in one direction only.
	 *
	 * Silent on every failure. A leg with no readable dialog — a Local half, a snoop, a media server
	 * that refuses the read — is a leg no REFER can name, which is not a problem with the call.
	 */
	private async recordSipDialog(channel: MediaChannelSnapshot): Promise<void> {
		const aggregate = this.registry.byAriChannelId(channel.id);
		if (aggregate === undefined) {
			return;
		}
		const sipCallId = await this.readSipCallId(channel);
		if (
			sipCallId === undefined ||
			aggregate.snapshot.variables[SIP_CALL_ID_VARIABLE] === sipCallId
		) {
			return;
		}
		aggregate.setVariable(SIP_CALL_ID_VARIABLE, sipCallId);
		this.registry.indexSipDialog(aggregate, sipCallId);
		void this.jetstream.putChannel(aggregate.snapshot);
	}

	/** The leg's SIP `Call-ID`: pre-stamped if a dialplan did it, read off the media server if not. */
	private async readSipCallId(channel: MediaChannelSnapshot): Promise<string | undefined> {
		const inline = normalizeSipCallId(
			channel.variables[SIP_CALL_ID_VARIABLE] ?? channel.variables[SIP_CALL_ID_CHANNEL_FUNCTION],
		);
		if (inline !== undefined) {
			return inline;
		}
		try {
			return normalizeSipCallId(
				await this.media.getVariable(channel.id, SIP_CALL_ID_CHANNEL_FUNCTION),
			);
		} catch {
			return undefined;
		}
	}

	/**
	 * The media channel carrying a SIP dialog, for `rpc.sip.v1.transfer`.
	 *
	 * Keyed on the `Call-ID` alone, and the dialog TAGS the request also carries are deliberately not
	 * consulted. Two reasons, and the second is the one that decides it. A `Call-ID` is required to be
	 * globally unique for the dialog it names (RFC 3261 §8.1.1.4), so it is already an exact key for
	 * everything short of a forked INVITE — which a phone registered through `apps/sipd` cannot
	 * produce, because the registrar is the only thing forking. And Asterisk does not expose the local
	 * and remote tags of a PJSIP session as readable channel values at all, so a tag comparison would
	 * have to be built out of a second data source before it could reject anything.
	 *
	 * The consequence is written down rather than hidden: this index cannot tell two dialogs apart
	 * that share a `Call-ID`, and it does not try to. Authorisation is a separate matter and is done
	 * by the responder, on the leg this returns.
	 */
	private resolveSipDialog(sipCallId: string): string | undefined {
		return this.registry.bySipCallId(sipCallId)?.ariChannelId;
	}

	/**
	 * Whether a REFER's `Refer-To` resolves to anything in the tenant's plan.
	 *
	 * Resolved against the TRANSFEREE's identity rather than the transferor's, because the transferee
	 * is who `CallControl` actually routes on a blind transfer — asking the question about anybody
	 * else would answer for a call that is not the one about to be placed.
	 *
	 * `internal`, hard-coded, and matching `CallControlSettings.transferContext`: the responder does
	 * not let a request off the SIP edge choose a context, and a check performed in a wider one than
	 * the transfer itself uses would pass destinations the transfer then refuses.
	 *
	 * An unreadable artifact answers TRUE. This is a pre-flight courtesy, not the gate: refusing every
	 * transfer for a tenant whose artifact is briefly unfetchable would turn a cache miss into a
	 * feature outage, and the transfer path behind it already reports what it finds.
	 */
	private async isDialableFromLeg(leg: ControlledLeg, destination: string): Promise<boolean> {
		const dialed = destination.trim();
		if (dialed === "") {
			return false;
		}
		const artifact = await this.routing.get(leg.organizationId);
		if (artifact === undefined) {
			return true;
		}
		const transferee =
			leg.peerMediaChannelId === undefined
				? undefined
				: this.controlledLegFor(leg.peerMediaChannelId);
		const resolved = resolveInternal(artifact, {
			from: transferee?.callerIdNumber ?? leg.callerIdNumber ?? "",
			dialed,
			now: new Date(),
		});
		return resolved.matched && resolved.plan !== undefined;
	}

	/**
	 * Places a click-to-call: ring the extension, and let the ordinary routing path dial the target
	 * when it answers.
	 *
	 * ## The seam, and why it is this one
	 *
	 * There are three places a click-to-call could have been bolted on, and two of them are worse.
	 *
	 * It could have originated the TARGET first and bridged the extension to it afterwards, which is
	 * what a naive `Originate` does — and which makes the far end listen to silence while somebody
	 * wanders back to their desk, and bills the tenant for the attempt when they never do.
	 *
	 * It could have originated the extension and then driven the B-side itself, through
	 * {@link routeLeg}. That is closer, and it is still wrong: `routeLeg` exists for a leg that is
	 * ALREADY up and being re-pointed, so it resolves in the `internal` context and does not fall
	 * through to outbound — a transfer must not become a way to dial anywhere. A click-to-call is not
	 * a transfer; it is the extension's own first dial, and it must be resolved exactly as one.
	 *
	 * So the seam is the ORDINARY one. The A-leg is originated into the Stasis application with no
	 * `OPTIMIQ_LEG`, which means `onLegArrived` files it as a new A-leg, `runRoutedProgram` resolves
	 * it against the tenant's artifact through the same internal-then-outbound ladder any handset
	 * gets, and the walker dials the target, publishes the events, mirrors the channels bucket and
	 * writes the CDRs. Follow-me, ring groups, queues, time conditions and call blocking all apply,
	 * for free, because none of this is a second code path.
	 *
	 * The one thing the ordinary path could not supply is the dialled number: an ARI origination
	 * creates a channel with no dialplan, so there is nothing to read it off. That is the entire new
	 * surface — one channel variable, `OPTIMIQ_DIALED_NUMBER`, preferred over the channel's own
	 * extension in {@link resolveRoute}. See `channel-identity.ts` for why it does not feed
	 * attribution.
	 *
	 * ## Idempotency
	 *
	 * `originateId` becomes the media channel id, so a retry of a request whose reply was lost finds
	 * a channel this instance is already tracking and is answered with the ids of the call it already
	 * placed. Without that, a five-second timeout on a slow media server would ring somebody's desk
	 * twice for one click.
	 */
	private async placeOriginatedCall(request: OriginateRequest): Promise<OriginatePlacement> {
		const existing = this.registry.byAriChannelId(request.originateId);
		if (existing !== undefined) {
			// The retry path. Answered `placed` rather than refused: the caller asked for a call to
			// exist and it does, which is the same outcome by any measure the caller can act on.
			return {
				kind: "placed",
				callId: existing.callId,
				legId: existing.channelId,
				endpoint: existing.snapshot.profile.channelName ?? "",
			};
		}

		if (this.draining || !this.registry.isAccepting) {
			return {
				kind: "refused",
				reason: "shutting_down",
				error: "this engine instance is draining",
			};
		}
		if (this.env.ENGINE_MEDIA_DRIVER !== "ari") {
			// `apps/mediad` refuses origination by design — SIP signalling is `apps/sipd`'s. A named
			// refusal beats letting `MediaPort.originate` throw and reporting every extension in the
			// tenant as unregistered.
			return {
				kind: "refused",
				reason: "not_supported",
				error: `this engine's media driver (${this.env.ENGINE_MEDIA_DRIVER}) cannot originate`,
			};
		}

		const artifact = await this.routing.get(request.orgId);
		if (artifact === undefined) {
			// NOT `unknown_extension`: the extension may well exist. What is missing is the compiled
			// plan, which is the control plane's to publish, and saying "no such extension" here would
			// send an integrator looking at their own configuration for our outage.
			return {
				kind: "refused",
				reason: "internal",
				error: `no routing artifact for organization ${request.orgId}`,
			};
		}

		const plan = planOriginate(artifact, {
			fromExtension: request.fromExtension,
			to: request.to,
			extensionDialTemplate: this.env.ENGINE_EXTENSION_DIAL_TEMPLATE,
			now: new Date(),
		});
		if (!plan.ok) {
			return { kind: "refused", reason: plan.reason, error: plan.error };
		}

		const callerId =
			request.callerIdName ?? plan.callerIdName ?? request.callerIdNumber ?? plan.callerIdNumber;
		const callerIdNumber = request.callerIdNumber ?? plan.callerIdNumber;
		try {
			await this.media.originate({
				endpoint: plan.endpoint,
				application: this.env.ARI_APP,
				channelId: request.originateId,
				...(callerIdNumber === undefined
					? {}
					: {
							callerId:
								callerId === callerIdNumber ? callerIdNumber : `"${callerId}" <${callerIdNumber}>`,
						}),
				...(request.ringTimeoutSeconds === undefined
					? {}
					: { timeoutSeconds: request.ringTimeoutSeconds }),
				variables: {
					OPTIMIQ_ORG_ID: request.orgId,
					// `internal`, so the walk takes the internal-then-outbound ladder rather than being
					// resolved against the DID table — this leg was not dialled from outside.
					OPTIMIQ_CALL_DIRECTION: "internal",
					OPTIMIQ_ROUTING_CONTEXT: "internal",
					OPTIMIQ_DIALED_NUMBER: request.to,
				},
			});
		} catch (error) {
			// What `MediaPort.originate` throws for: an endpoint that is not configured, or one with no
			// contact to send an INVITE to. The plan walker reads exactly this as "not registered", and
			// so does the contract's `extension_offline`.
			this.logger.info(
				{
					originateId: request.originateId,
					orgId: request.orgId,
					endpoint: plan.endpoint,
					err: String(error),
				},
				"could not originate a click-to-call towards the extension",
			);
			return {
				kind: "refused",
				reason: "extension_offline",
				error: `no contact for ${request.fromExtension}: ${String(error)}`,
			};
		}

		// Derived, not invented, and derivable BEFORE the channel reaches Stasis — which is what lets
		// this reply carry the ids while the phone is still ringing. See `channel-identity.ts`.
		return {
			kind: "placed",
			callId: callIdForAriChannel(request.originateId),
			legId: legIdForAriChannel(request.originateId),
			endpoint: plan.endpoint,
		};
	}
}

/**
 * Which side of the call a tracked leg is.
 *
 * Read off `OPTIMIQ_LEG`, which the walker exports onto every leg it originates and which nothing
 * else sets, rather than off a field: the variable is already mirrored into the `channels` KV
 * snapshot, so an instance that picks this leg up after a failover reads the same answer and writes
 * the same CDR. A field would live only in the process that died.
 */
function legSideOf(aggregate: ChannelAggregate): LegSide {
	return aggregate.snapshot.variables.OPTIMIQ_LEG === "b" ? "b" : "a";
}

/**
 * The A-leg, as the plan walker sees it.
 *
 * Getters, not a snapshot: the walk is long-lived and the aggregate moves underneath it — a leg
 * that answered halfway through an IVR must read as answered on the next node, not as it was when
 * the walk began.
 */
function walkerChannelFor(aggregate: ChannelAggregate): WalkerChannel {
	return {
		mediaChannelId: aggregate.ariChannelId,
		channelId: aggregate.channelId,
		callId: aggregate.callId,
		organizationId: aggregate.organizationId,
		get isTearingDown(): boolean {
			return aggregate.isTearingDown;
		},
		get isDetached(): boolean {
			return aggregate.isDetached;
		},
		get isAnswered(): boolean {
			return aggregate.isAnswered;
		},
		get callerIdNumber(): string | undefined {
			return aggregate.snapshot.profile.callerIdNumber;
		},
		get callerIdName(): string | undefined {
			return aggregate.snapshot.profile.callerIdName;
		},
		moveTo: (state) => aggregate.tryTransitionTo(state),
		setBridge: (bridgeId) => {
			aggregate.setBridge(bridgeId);
		},
	};
}

/** The caller profile for a leg at its first routing hop. */
function profileFrom(
	channel: MediaChannelSnapshot,
	routingContext: string | undefined,
): CallerProfile {
	return {
		callerIdName: emptyToUndefined(channel.callerName),
		callerIdNumber: emptyToUndefined(channel.callerNumber),
		ani: emptyToUndefined(channel.callerNumber),
		destinationNumber: dialStringOr(channel.dialedNumber),
		context: routingContext ?? emptyToUndefined(channel.context) ?? "default",
		channelName: emptyToUndefined(channel.name),
		source: "ari",
	};
}

function emptyToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function definedOnly(values: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}
