import { Inject, Injectable, Optional, type OnApplicationShutdown } from "@nestjs/common";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { makeCdrLegWriteEvent, makeVoicemailEvent, validateEvent } from "@optimiq-voice/events";
import { createEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logging";
import { resolveInbound, resolveInternal, resolveOutbound } from "@optimiq-voice/routing";
import { hangupCauseCode, isDtmfDigit } from "@optimiq-voice/telephony";
import { SplitPlaneMediaPort } from "../media/split-plane.port";
import { CallControlService as EngineCallControlService } from "../nats/call-control.service";
import { CallEventPublisher } from "../nats/call-event-publisher.service";
import {
	CHANNEL_OWNER_EXPIRES_AT_VARIABLE,
	CHANNEL_OWNER_INSTANCE_VARIABLE,
	CHANNEL_OWNERSHIP_LEASE_MS,
	channelOwnershipOf,
} from "../nats/channel-ownership";
import { ConferenceControlService } from "../nats/conference-control.service";
import { JetStreamService } from "../nats/jetstream.service";
import { CALLS_EFFECT_RUNTIME, ENGINE_ENV, MEDIA_PORT } from "../nats/nats.tokens";
import { OriginateService } from "../nats/originate.service";
import { ParkHandoffService } from "../nats/park-handoff.service";
import { SessionAnnounceService } from "../nats/session-announce.service";
import { SessionVerbService } from "../nats/session-verb.service";
import { SipInviteService } from "../nats/sip-invite.service";
import { SipTransferService } from "../nats/sip-transfer.service";
import { AgentStateStore } from "../queue/agent-state.store";
import { QueueCallbackScheduler } from "../queue/queue-callback.scheduler";
import { QueueEventPublisher } from "../queue/queue-event-publisher.service";
import { QueueMembershipSource } from "../queue/queue-membership.source";
import { QueueCursors } from "../queue/queue-registry";
import { QueueWaitingStore } from "../queue/queue-waiting.store";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "../routing/call-signals";
import { ConferenceRegistry } from "../routing/conference-registry";
import { DidIndexSource } from "../routing/did-index.source";
import { ExtensionFeatureRpcPort } from "../routing/extension-feature.source";
import { HotDeskRpcPort } from "../routing/hot-desk.source";
import { LastCallerRpcSource } from "../routing/last-caller.source";
import { ParkRegistry } from "../routing/park-registry";
import { PlanWalker } from "../routing/plan-walker";
import { RoutingArtifactSource } from "../routing/routing-artifact.source";
import { SharedLineRegistry } from "../routing/shared-line-registry";
import { SupervisorAuthzRpcPort } from "../routing/supervisor-authz.source";
import { ToggleFeatureRpcPort } from "../routing/toggle-feature.source";
import { TrunkCapacityRegistry } from "../routing/trunk-capacity";
import { TrunkStatusPublisher } from "../routing/trunk-status.publisher";
import { VoicemailGreetingRpcPort } from "../routing/voicemail-greeting.source";
import { VoicemailMailboxRpcSource } from "../routing/voicemail-mailbox.source";
import { ApplicationSessions } from "../session/application-sessions";
import { dtmfEventFrom } from "../verbs/dtmf-inbox";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import { callDirectionFrom, dialStringOr, hangupSideFor } from "./ari-mapping";
import { CallControl, pickupGroupFilter } from "./call-control";
import { CallControlRegistry } from "./call-control-registry";
import { attestationOf, authorizationOf, buildCdrLegWrite, queueLegOf } from "./cdr-leg";
import { ChannelAggregate } from "./channel-aggregate";
import {
	callIdForAriChannel,
	legIdForAriChannel,
	normalizeSipCallId,
	REPLACES_LEG_ID_VARIABLE,
	resolveOrganizationId,
	SIP_CALL_ID_CHANNEL_FUNCTION,
	SIP_CALL_ID_VARIABLE,
	SIPD_INSTANCE_ID_VARIABLE,
} from "./channel-identity";
import { ChannelRegistry } from "./channel-registry";
import { MidCallFeatureRuntime } from "./mid-call-features";
import { planOriginate, planQueueCallback } from "./originate-plan";
import type { EngineEnv } from "../config/engine-env";
import type { MediaChannelSnapshot, MediaEvent } from "../media/media-event";
import type { MediaDirection, MediaPort } from "../media/media-port";
import type { CallControlOutcome } from "../nats/call-control.service";
import type { ConferenceControlOutcome } from "../nats/conference-control.service";
import type { ChannelClaimResult } from "../nats/jetstream.service";
import type { OriginatePlacement } from "../nats/originate.service";
import type { SipInviteAdmission, SipReplacesAuthorization } from "../nats/sip-invite.service";
import type { QueueCallbackSchedulePort } from "../queue/queue-session";
import type { ConferenceMember } from "../routing/conference-registry";
import type { PlanDestination } from "../routing/plan-destination";
import type {
	OriginatedLeg,
	OriginatedLegHooks,
	PlanWalkerSettings,
	VoicemailPort,
	WalkerCallControl,
	PinAuthorization,
	WalkerQueueOutcome,
	WalkerChannel,
} from "../routing/plan-walker";
import type { PlanWalkerDependencies } from "../routing/plan-walker";
import type { VerbDispatchOutcome } from "../session/application-sessions";
import type { VerbFailure } from "../verbs/verb-errors";
import type { VerbChannelContext, VerbExecutorRuntime } from "../verbs/verb-executor";
import type {
	CallControlHost,
	ControlledLeg,
	ParkLot,
	PickupCandidate,
	RouteOutcome,
	RouteRequest,
	SharedLine,
	SupervisionTarget,
} from "./call-control";
import type {
	CallControlRequest,
	CallDirection,
	CallEvent,
	ConferenceControlRequest,
	LegSide,
	OriginateRequest,
	QueueCallbackRpcRequest,
	SipInviteRequest,
} from "@optimiq-voice/events";
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
/**
 * How many channel-lease renewals are in flight at once during ownership maintenance.
 *
 * Bounded rather than a bare `Promise.all` over every owned leg: a replica holding hundreds of
 * calls would otherwise open hundreds of concurrent KV updates on the same connection each tick,
 * which is a different way of being slow.
 */
const OWNERSHIP_RENEWAL_BATCH = 16;

const DESTINATION_TYPE_VARIABLE = "OPTIMIQ_DESTINATION_TYPE";
const DESTINATION_REF_VARIABLE = "OPTIMIQ_DESTINATION_REF";
/**
 * The music-on-hold class the destination this leg reached configured.
 *
 * Mirrored onto the leg for the same reason the destination is, and read at a moment the walk is
 * long over: hold arrives as a re-INVITE from a phone, minutes into a conversation, and SIP gives it
 * no way to name a class. Without a variable the far end always heard the media server's default and
 * the tenant's own music was reachable only from a queue or a park lot. Absent means exactly what it
 * means in the compiler — "the media server's default class".
 */
const MOH_CLASS_VARIABLE = "OPTIMIQ_MOH_CLASS";
/**
 * Which authorisation code opened a gated outbound route, mirrored exactly as the destination is.
 *
 * Channel variables and not walk state, for the reason `recordDestination` gives: the CDR is written
 * by whichever of the teardown and the walk's return gets there first, and only the variables are
 * visible to both. The ordinal and the label — never the digits, which stop at the walker.
 */
const AUTH_PIN_ORDINAL_VARIABLE = "OPTIMIQ_AUTH_PIN_ORDINAL";
const AUTH_PIN_LABEL_VARIABLE = "OPTIMIQ_AUTH_PIN_LABEL";
/**
 * The carrier's STIR/SHAKEN claim about the calling number, stamped onto the A-leg at admission.
 *
 * Channel variables for the reason the pin ordinal is one: the CDR is written by whichever of the
 * teardown and the walk's return gets there first, and only the variables are visible to both —
 * and they travel into the `channels` bucket, so a replica adopting the leg after a failover writes
 * the same record. The alternative, holding the INVITE request in memory until hangup, loses the
 * fact on exactly the restart a traceback would be asking about.
 *
 * Only ever set from a TRUNK INVITE (the edge refuses to read the headers off a digest one), and
 * only the keys the carrier actually sent — an absent claim is an absent variable, never an empty
 * string, so `attestationOf` can tell "no claim" from "a claim that said nothing".
 */
const SIP_ATTESTATION_VARIABLE = "OPTIMIQ_SIP_ATTESTATION";
const SIP_VERSTAT_VARIABLE = "OPTIMIQ_SIP_VERSTAT";
const SIP_ORIGID_VARIABLE = "OPTIMIQ_SIP_ORIGID";
/**
 * The registered device a digest INVITE authenticated as.
 *
 * Same mechanism and the same reason: the walker reads it back off the leg when it publishes
 * `call.emergency.dialed`, and a Ray Baum dispatchable location that survives a failover is the
 * whole point of not keeping it in process memory.
 */
const DEVICE_ID_VARIABLE = "OPTIMIQ_DEVICE_ID";
const CDR_RELATED_CALL_ID_VARIABLE = "OPTIMIQ_CDR_RELATED_CALL_ID";
/**
 * Every variable an arriving leg carries, in ONE list, because the two halves drifted apart once.
 *
 * `invitedChannelSnapshot` stamps these onto the arriving snapshot and `readEngineVariables` reads
 * them back onto the aggregate. When the stamping side grew `OPTIMIQ_DEVICE_ID` and the three
 * attestation names, the reading side did not learn about them, and every one was dropped between
 * the INVITE and the aggregate — which silently emptied the STIR/SHAKEN CDR columns and made the
 * hot-desk feature code's `deviceId` precondition unsatisfiable by any endpoint.
 *
 * Both halves are now derived from this array: the stamp builds a `Record<ArrivalVariable, …>`, so
 * a name added here fails to compile until it is stamped, and the read iterates the same array, so
 * a name that is stamped is by construction a name that is read.
 */
const ARRIVAL_VARIABLES = [
	"OPTIMIQ_ORG_ID",
	"OPTIMIQ_CALL_DIRECTION",
	"OPTIMIQ_ROUTING_CONTEXT",
	"OPTIMIQ_LEG",
	SIP_CALL_ID_VARIABLE,
	SIPD_INSTANCE_ID_VARIABLE,
	REPLACES_LEG_ID_VARIABLE,
	DEVICE_ID_VARIABLE,
	SIP_ATTESTATION_VARIABLE,
	SIP_VERSTAT_VARIABLE,
	SIP_ORIGID_VARIABLE,
	CDR_RELATED_CALL_ID_VARIABLE,
] as const;
type ArrivalVariable = (typeof ARRIVAL_VARIABLES)[number];
/**
 * What to ask the media server for when nothing stamped the variable inline.
 *
 * An entry ABSENT here is inline-or-nothing, and that is the whole distinction `readEngineVariables`
 * documents: the facts the SIP edge carries — which instance holds the dialog, the authorised
 * `Replaces`, the device, the carrier's attestation — exist on no media server, so there is nothing
 * to ask and asking costs a round trip per call per variable.
 */
const ARRIVAL_VARIABLE_READS: Readonly<Partial<Record<ArrivalVariable, string>>> = {
	OPTIMIQ_ORG_ID: "OPTIMIQ_ORG_ID",
	OPTIMIQ_CALL_DIRECTION: "OPTIMIQ_CALL_DIRECTION",
	OPTIMIQ_ROUTING_CONTEXT: "OPTIMIQ_ROUTING_CONTEXT",
	// Marks a leg the engine originated. Read here rather than guessed from the dialplan, because it
	// is the only thing that is true of every originated leg and of nothing else.
	OPTIMIQ_LEG: "OPTIMIQ_LEG",
	[SIP_CALL_ID_VARIABLE]: SIP_CALL_ID_CHANNEL_FUNCTION,
};
/**
 * The queue's verdict on a caller's stay, mirrored onto the leg exactly as the destination is.
 *
 * Channel variables and not walk state, for the reason `recordDestination` gives: the CDR is written
 * by whichever of the teardown and the walk's return gets there first, and only the variables are
 * visible to both. They also travel into the `channels` bucket, so an instance that picks the leg up
 * after a failover writes the same CDR this one would have.
 */
const QUEUE_REF_VARIABLE = "OPTIMIQ_QUEUE_REF";
const QUEUE_WAIT_MS_VARIABLE = "OPTIMIQ_QUEUE_WAIT_MS";
const QUEUE_OUTCOME_VARIABLE = "OPTIMIQ_QUEUE_OUTCOME";
const QUEUE_AGENT_REF_VARIABLE = "OPTIMIQ_QUEUE_AGENT_REF";
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
const CDR_EVENT_ID_VARIABLE = "OPTIMIQ_CDR_EVENT_ID";
const CDR_HANGUP_CAUSE_CODE_VARIABLE = "OPTIMIQ_CDR_HANGUP_CAUSE_CODE";
/**
 * The cross-CALL link, for a leg this engine created to settle an earlier one.
 *
 * `call_legs` links legs WITHIN one `call_id` (`originatingLegId`, `bridgeLegId`); nothing linked two
 * calls until `related_call_id`. A queue callback is the first thing that needs it: it is a new call,
 * minutes later, and this is the only thing that says which wait it settled. A channel variable
 * rather than a field on the aggregate, so it survives the snapshot an instance reads after failover.
 */
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
	private readonly originatedCallers = new Map<string, MediaChannelSnapshot>();
	private draining = false;
	/** Monotonic: channels taken over from a replica proved dead by its instance lease. */
	private adoptedFromDeadPeers = 0;
	/** Hold, transfer, park, pickup and on-demand recording, over the ports below. */
	private readonly control: CallControl;
	/** Calls this instance has handed to an external application. See `application-sessions.ts`. */
	private readonly sessions: ApplicationSessions;
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
	/**
	 * The setup cut-off, per admitted leg that has produced no response yet.
	 *
	 * The other half of `durationCeilings`, and the half that was missing: that one is armed when a
	 * leg is ANSWERED, so a walk that hangs before it rings leaves a leg with no timer at all. See
	 * {@link ChannelOrchestrator.armSetupDeadline}.
	 */
	private readonly setupDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * Adopted legs that never answered, waiting to be checked against the SIP edge's own record.
	 *
	 * Bounded by the number of legs this instance has adopted and drained on the next maintenance
	 * tick; an entry is removed whether or not the check could be made, because a leg that survives
	 * one inconclusive check is covered by its setup deadline. See {@link reconcileAdoptedLegs}.
	 */
	private readonly adoptedPendingReconcile = new Set<string>();
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
		private readonly greetings: VoicemailGreetingRpcPort,
		private readonly supervision: SupervisorAuthzRpcPort,
		private readonly didIndex: DidIndexSource,
		private readonly signals: CallSignalBus,
		private readonly conferences: ConferenceRegistry,
		private readonly queueMembership: QueueMembershipSource,
		private readonly agentState: AgentStateStore,
		private readonly queueEvents: QueueEventPublisher,
		private readonly queueWaiting: QueueWaitingStore,
		private readonly queueCursors: QueueCursors,
		private readonly parks: ParkRegistry,
		private readonly callControl: CallControlRegistry,
		private readonly parkHandoff: ParkHandoffService,
		private readonly sipTransfer: SipTransferService,
		private readonly originate: OriginateService,
		private readonly sipInvite: SipInviteService,
		/**
		 * Optional, and LAST, so the spec harnesses — which construct this class positionally and
		 * never feed it a trunk transition — need not fake a publisher. The deployed module always
		 * provides it; `@Optional()` only widens what Nest tolerates, not what production wires.
		 */
		@Optional() private readonly trunkStatus?: TrunkStatusPublisher,
		/**
		 * The session protocol's two halves. Optional and last, for the same reason `trunkStatus` is:
		 * the spec harnesses construct this class positionally and none of them speaks the session
		 * protocol. Their absence is a real deployment — an engine whose `application` destinations
		 * announce because there is no control plane to hand a call to — rather than a broken one.
		 */
		@Optional() private readonly sessionAnnounce?: SessionAnnounceService,
		@Optional() private readonly sessionVerbs?: SessionVerbService,
		/**
		 * In-conference moderation, arriving from `apps/api`. Optional and last, for the reason the two
		 * above it are: the spec harnesses construct this class positionally and none of them moderates
		 * a room. Absent is an engine whose conferences run and cannot be moderated over HTTP, which is
		 * exactly what every engine did before this wave.
		 */
		@Optional() private readonly conferenceControl?: ConferenceControlService,
		/**
		 * `*65` / `*64` — the organization-wide toggles, and the shared-line seizure registry. Both
		 * optional and last for the reason every entry above them is: the spec harnesses construct this
		 * class positionally. Absent, the walker announces the toggle codes as unavailable and refuses
		 * to seize a shared line, which is what the walker's `toggles`/`sharedLines` deps already
		 * document; the deployed module always provides both from `RoutingModule`.
		 */
		@Optional() private readonly toggles?: ToggleFeatureRpcPort,
		@Optional() private readonly sharedLines?: SharedLineRegistry,
		@Optional() private readonly hotDesk?: HotDeskRpcPort,
		/**
		 * Virtual hold's sweep, told when a queue owes somebody a call. Optional and last on the same
		 * terms; absent means a promise is written and swept by whichever instance does have one.
		 */
		@Optional() private readonly queueCallbacks?: QueueCallbackScheduler,
		/**
		 * The PBX recording control, arriving from `apps/api`. Optional and last, for the reason every
		 * entry above it is: the spec harnesses construct this class positionally. Absent is an engine
		 * whose recordings run and cannot be paused over HTTP — which is what every engine did before
		 * this wave, and is still what one does for a call under an application's control, where the
		 * session verb channel is the surface.
		 */
		@Optional() private readonly recordingControl?: EngineCallControlService,
	) {
		this.control = new CallControl({
			media: this.media,
			signals: this.signals,
			parks: this.parks,
			host: this.callControlHost(),
			// The mid-call half of a shared line. Optional on `CallControlDependencies`, so a spec that
			// does not construct one gets a deployment whose shared lines ring and bridge and do not
			// light each other's keys — which is what every engine did before this wave.
			...(this.sharedLines === undefined ? {} : { sharedLines: this.sharedLines }),
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
			// The supervisor's `4`/`5`/`6`, on the same terms and through the same getter-shaped
			// indirection: `this.midCall` is built from `this.control` and does not exist yet here.
			supervisionKeys: {
				arm: (mediaChannelId, escalate) => {
					this.midCall.armSupervisionKeys(mediaChannelId, escalate);
				},
				disarm: (mediaChannelId) => {
					this.midCall.disarmSupervisionKeys(mediaChannelId);
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
			// The consultation the phone brokered on its own second line, which is a call of THIS
			// engine's — the reason a `Replaces` is honourable here at all. Resolved on the same
			// `Call-ID` index and by the same drain rule as the dialog the REFER arrived in.
			resolveReplacedDialog: async (request) =>
				this.draining || request.replaces === undefined
					? undefined
					: this.resolveSipDialog(request.replaces.callId),
			legFor: (mediaChannelId) => this.controlledLegFor(mediaChannelId),
			isDialableTarget: async (leg, destination) => await this.isDialableFromLeg(leg, destination),
			transfer: async (leg, request) => await this.control.transfer(leg, request),
			completeAttendedTransfer: async (transferor, consultation, destination) =>
				await this.control.completeAttendedRefer(transferor, consultation, destination),
		});
		// Click-to-call, arriving from `apps/api` on `rpc.engine.v1.originate`. Same push, same reason.
		this.originate.attach({
			place: async (request) => await this.placeOriginatedCall(request),
			// The queue's own outbound call. A separate entry rather than a shape on `place`, for the
			// reason `rpc.engine.v1.queue-callback` is a separate subject: one is an extension placing a
			// call and is authorised as one, and the other is the tenant calling a customer back.
			placeQueueCallback: async (request) => await this.placeQueueCallbackCall(request),
		});
		// A call arriving on the SIP edge, asking to be admitted. Same push, same reason — and the one
		// place on this list where the responder decides something before the call path is asked: the
		// toll-fraud check on `routingContext` is `SipInviteService`'s, because it needs no call.
		this.sipInvite.attach({
			authorizeReplaces: async (request) => await this.authorizeInviteReplaces(request),
			admit: async (request) => await this.placeInvitedCall(request),
		});
		// The session protocol. Built here rather than injected for the reason `CallControl` is: it
		// needs the verb executor and the channel registry, both of which are this class's, and a
		// provider that reached back for them would be the Nest cycle `call-control-registry.ts`
		// exists to break.
		this.sessions = new ApplicationSessions({
			announce: async (request) =>
				(await this.sessionAnnounce?.announce(request)) ?? {
					accepted: false,
					reason: "no-application",
					error: "this engine has no session client",
				},
			execute: async (legId, verb) => await this.executeForSession(legId, verb),
			instanceId: this.env.ENGINE_INSTANCE_ID,
			log: (message, detail) => {
				this.logger.info(detail ?? {}, message);
			},
		});
		// A draining instance refuses verbs rather than half-running them, exactly as it refuses park
		// handoffs: it is about to hang its remaining legs up, and a `gather` accepted now would wait
		// thirty seconds for digits on a channel this process is closing.
		this.sessionVerbs?.attach({
			execute: async (request) =>
				this.draining
					? {
							ok: false,
							verb: request.verb,
							reason: "shutting-down",
							error: "this instance is draining",
						}
					: await this.sessions.execute(request),
		});
		// In-conference moderation, from `apps/api`. Pushed here for the reason the park handler is:
		// this class holds the registry AND the media port, and the responder is constructed by the
		// NATS module long before it — a provider that reached back for both would be a Nest cycle.
		this.conferenceControl?.attach({
			moderate: async (request) => await this.moderateConference(request),
		});
		// The recording control, from `apps/api`. Attached here for the reason the two above it are:
		// this class holds the registry AND the call-control runtime, and the responder is built by
		// the NATS module long before either.
		this.recordingControl?.attach({
			control: async (request) => await this.controlCallRecording(request),
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

	/**
	 * Takes over one snapshot whose ownership lease has lapsed, for the `channels` watch.
	 *
	 * The expiry-fenced half of adoption, driven per key by an event instead of by a cluster-wide
	 * listing every heartbeat. `adoptChannel` refuses anything a live replica still holds, so this is
	 * safe to call on any snapshot the watch reports.
	 */
	async adoptOrphanedChannel(snapshot: ChannelSnapshot, now = Date.now()): Promise<boolean> {
		if (this.draining) {
			return false;
		}
		return await this.hydrateChannel(snapshot, now);
	}

	/**
	 * Contests every channel a PROVED-DEAD engine replica owned, and resumes the ones this instance
	 * wins.
	 *
	 * ## Why this is separate from {@link maintainChannelOwnership}
	 *
	 * That pass adopts a channel whose ownership lease has EXPIRED, and it must: an unexpired lease
	 * is the only evidence a survivor has that a peer is alive, and adopting past it would take a
	 * busy replica's calls out from under it. But that lease is ninety seconds wide, so a SIGKILLed
	 * engine's calls sit unowned for up to a minute and a half — media flowing, dialog standing, no
	 * aggregate anywhere in the fleet, and a BYE arriving in that window returning early against a
	 * replica that has no leg for it. Measured live: forty seconds after the kill, nothing adopted,
	 * no CDR.
	 *
	 * `engine-instances` is the evidence that closes it. When {@link EngineLivenessService} reports
	 * a peer's lease lapsed, that peer is gone, and its channel leases are promises nobody is left
	 * to keep — so this pass contests them regardless of their expiry, fenced instead by the
	 * revision-CAS in {@link JetStreamService.adoptChannelFromInstance} (so exactly one survivor
	 * wins each channel) and by the requirement that the snapshot still name the dead instance (so a
	 * peer's death can never be used to take a third party's calls).
	 *
	 * Winning is not the end of it: {@link installChannel} re-registers the leg with the split-plane
	 * port, restores its variables, resubscribes to its media events and re-indexes its SIP dialog,
	 * which is what makes the next BYE end the call and file both CDR legs.
	 */
	async adoptChannelsOfInstance(deadInstanceId: string, now = Date.now()): Promise<number> {
		if (this.draining) {
			// This instance is leaving. Adopting a dead peer's calls now would hand them straight to
			// the drain's straggler teardown, which ends a live call the next survivor could have kept.
			return 0;
		}
		if (deadInstanceId === this.env.ENGINE_INSTANCE_ID) {
			// Our own id, reported lost — a renewal this process failed to write, not a death. Every
			// channel named here is one we are actively serving.
			this.logger.warn(
				{ instanceId: deadInstanceId },
				"refusing to contest this instance's own channels",
			);
			return 0;
		}
		let adopted = 0;
		let candidates = 0;
		for await (const snapshot of this.jetstream.channelSnapshots()) {
			if (channelOwnershipOf(snapshot)?.instanceId !== deadInstanceId) {
				continue;
			}
			candidates += 1;
			if (
				await this.installChannel(
					snapshot,
					async () => await this.jetstream.adoptChannelFromInstance(snapshot, deadInstanceId, now),
				)
			) {
				adopted += 1;
				// One line per adoption, at INFO, naming the call: this is the record that a stranded
				// call was picked up, and it is the first thing an operator greps for after a crash.
				this.logger.info(
					{
						instanceId: deadInstanceId,
						callId: snapshot.callId,
						channelId: snapshot.channelId,
						organizationId: snapshot.organizationId,
					},
					"adopted a channel from an engine replica that died",
				);
			}
		}
		this.logger.warn(
			{ instanceId: deadInstanceId, candidates, adopted },
			"finished contesting the channels of an engine replica that died",
		);
		this.adoptedFromDeadPeers += adopted;
		return adopted;
	}

	/** Channels this instance has taken over from a dead replica. `/healthz` reads it. */
	get adoptedChannelCount(): number {
		return this.adoptedFromDeadPeers;
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

	/**
	 * One pass: renew what this replica owns, then adopt what nobody does.
	 *
	 * Both halves used to be strictly sequential, which put `L + 2·N` KV round trips — N being the
	 * CLUSTER-wide live-channel count, not this replica's — inside every tick on every replica. A
	 * pass slower than the heartbeat is not a latency problem but a correctness one: a lease is
	 * three intervals wide, so a slow pass fences live calls. Hence the two changes here — renewals
	 * run in bounded-concurrency batches, and a snapshot carrying another instance's UNEXPIRED
	 * lease is skipped outright, since adoption has nothing to do for one.
	 */
	private async runChannelOwnershipMaintenance(now: number): Promise<void> {
		const fenced = new Set<string>();
		const aggregates = [...this.registry.all];
		for (let index = 0; index < aggregates.length; index += OWNERSHIP_RENEWAL_BATCH) {
			const batch = aggregates.slice(index, index + OWNERSHIP_RENEWAL_BATCH);
			const renewals = await Promise.all(
				batch.map(async (aggregate) => await this.jetstream.renewChannel(aggregate.snapshot, now)),
			);
			for (const [offset, renewed] of renewals.entries()) {
				const aggregate = batch[offset];
				if (aggregate === undefined) {
					continue;
				}
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
		}

		for await (const snapshot of this.jetstream.channelSnapshots()) {
			const ownership = channelOwnershipOf(snapshot);
			if (
				ownership !== undefined &&
				ownership.expiresAt > now &&
				ownership.instanceId !== this.env.ENGINE_INSTANCE_ID
			) {
				// Another live replica holds this one. `adoptChannel` would refuse it anyway, after a
				// second KV read per snapshot — which is the bulk of the pass on a busy cluster.
				continue;
			}
			try {
				if (fenced.has(ChannelAggregate.hydrate(snapshot).ariChannelId)) {
					continue;
				}
			} catch {
				// Let the ordinary hydration path log the malformed snapshot with its channel identity.
			}
			await this.hydrateChannel(snapshot, now);
		}

		await this.reconcileAdoptedLegs();
	}

	/**
	 * Ends the adopted legs no plane knows about any more.
	 *
	 * ## The residue this closes
	 *
	 * A survivor adopting a dead peer's channels cannot tell a call that is still ringing from one
	 * the SIP edge refused seconds after its owner died: both are snapshots in a pre-answer state
	 * with nothing driving them. Measured live — two WSS legs admitted five seconds after a SIGKILL,
	 * rejected by `sipd` at admission, correctly adopted, and then held in `activeChannels` with no
	 * dialog behind them.
	 *
	 * ## Why `sip-dialogs` is the right witness
	 *
	 * It is the EDGE's own record of which dialogs exist, written by the process that owns the
	 * socket and deleted when the dialog ends. Asking it is asking the only party that knows. A
	 * missing entry is not ambiguous the way a stale channel snapshot is: `sipd` writes the claim as
	 * part of accepting the dialog, so a leg with no claim is a leg that has no dialog anywhere.
	 *
	 * ## Why an unanswerable question changes nothing
	 *
	 * `sipDialogExists` answers `undefined` when the read failed, and that is left ALONE. Treating a
	 * broker blip as "the edge has no dialog" would hang up every live pre-answer call on the
	 * platform at once, which is a far worse outcome than the leak this is closing.
	 *
	 * Answered legs are never checked: a dialog claim can be reaped under a call that is still up,
	 * and the answered ones are covered by `armCallDurationCeiling` anyway.
	 */
	private async reconcileAdoptedLegs(): Promise<void> {
		const pending = [...this.adoptedPendingReconcile];
		this.adoptedPendingReconcile.clear();
		for (const mediaChannelId of pending) {
			const live = this.registry.byAriChannelId(mediaChannelId);
			if (live === undefined || live.isTearingDown || live.isAnswered) {
				continue;
			}
			const exists = await this.jetstream.sipDialogExists(mediaChannelId);
			if (exists !== false) {
				continue;
			}
			this.logger.warn(
				{ channelId: live.channelId, callId: live.callId, state: live.state },
				"ending an adopted leg the sip edge has no dialog for: it never answered and no plane " +
					"knows about it, so nothing else would ever end it",
			);
			live.markHangup({ cause: "NO_USER_RESPONSE", at: Date.now(), initiatedByEngine: true });
			await this.endStalledLeg(mediaChannelId);
		}
	}

	/**
	 * Ends a leg locally as well as on the wire.
	 *
	 * `hangupQuietly` alone is not enough here, and the reason is the whole shape of the leak these
	 * two callers close. An ordinary hangup is finished by the EVENT it provokes — `dialog.terminated`
	 * from the edge, `session.ended` from the media plane — and that is what removes the aggregate,
	 * files the CDR and frees the channel. A leg nobody has a dialog for provokes no event: `sipd`
	 * answers the BYE `unknown_dialog` and there is nothing left to report anything. So the leg stayed
	 * in `activeChannels` after being told to hang up — observed live, on the two channels the
	 * adoption pass left behind and on a walk that had already decided to hang up three milliseconds
	 * after admission.
	 *
	 * `onLegEnded` is the same local teardown `endLegsOnPlaneLoss` drives for the same reason, and it
	 * is idempotent: a `dialog.terminated` that does arrive afterwards finds nothing to end.
	 */
	private async endStalledLeg(mediaChannelId: string): Promise<void> {
		await this.hangupQuietly(mediaChannelId, "NO_USER_RESPONSE");
		try {
			await this.onLegEnded(
				mediaChannelId,
				"NO_USER_RESPONSE",
				hangupCauseCode("NO_USER_RESPONSE"),
			);
		} catch (error) {
			this.logger.error(
				{ mediaChannelId, err: String(error) },
				"could not finish ending a leg that produced no response",
			);
		}
	}

	private async hydrateChannel(snapshot: ChannelSnapshot, now: number): Promise<boolean> {
		return await this.installChannel(
			snapshot,
			async () => await this.jetstream.adoptChannel(snapshot, now),
		);
	}

	/**
	 * Claims one snapshot with `claim`, then rebuilds everything this instance needs to finish the
	 * call: the aggregate, its dialog index, its media subscription, and — the half that was missing
	 * — the split-plane port's per-leg record. See {@link SplitPlaneMediaPort.registerAdoptedLeg}.
	 */
	private async installChannel(
		snapshot: ChannelSnapshot,
		claimWith: () => Promise<ChannelClaimResult | "vanished">,
	): Promise<boolean> {
		try {
			const candidate = ChannelAggregate.hydrate(snapshot);
			if (this.registry.byAriChannelId(candidate.ariChannelId) !== undefined) {
				return false;
			}
			const claim = await claimWith();
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
			if (!aggregate.isAnswered && !aggregate.isTearingDown) {
				// An adopted leg that never answered is the one shape nothing on this platform could
				// end. Two guards, deliberately both: the reconcile below asks the SIP edge whether the
				// dialog still exists and ends it in seconds when it does not, and the setup deadline is
				// the backstop for when the edge cannot be asked at all.
				this.adoptedPendingReconcile.add(aggregate.ariChannelId);
				this.armSetupDeadline(aggregate);
			}
			if (this.media instanceof SplitPlaneMediaPort) {
				// Without this the adopted leg has no plane state, and `hangup` — which tolerates a
				// missing leg — silently skips the BYE: the aggregate is torn down and the CDR filed
				// while both phones are still up and still hearing each other.
				this.media.registerAdoptedLeg(aggregate.ariChannelId, {
					orgId: recoverable.organizationId,
					callId: recoverable.callId,
					sipdInstanceId: recoverable.variables[SIPD_INSTANCE_ID_VARIABLE],
					variables: recoverable.variables,
				});
			}
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
		this.disarmSetupDeadline(aggregate.ariChannelId);
		this.adoptedPendingReconcile.delete(aggregate.ariChannelId);
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
		// The SAME knob the park and conference claims renew on, rather than the hard-coded constant
		// behind its default. One variable, one behaviour: an operator lowering it for a slow or
		// contended KV means channel leases too, which are the ones whose expiry fences a live call.
		this.ownershipMaintenanceTimer = setInterval(() => {
			void this.maintainChannelOwnership().catch((error: unknown) => {
				this.logger.error({ err: String(error) }, "channel ownership maintenance failed");
			});
		}, this.env.ENGINE_CLAIM_HEARTBEAT_MS);
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
				await this.onCallStateChanged(event.channelId, event.callState, event.sdpAnswer);
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
					...(event.bytes === undefined ? {} : { bytes: event.bytes }),
					...(event.pauses === undefined ? {} : { pauses: event.pauses }),
				});
				return;
			case "recording-failed":
				this.signals.emit(recordingSignalKey(event.recordingName), {
					kind: "recording-failed",
					reason: event.reason,
				});
				return;
			case "trunk-endpoint-status":
				// Not a call event at all: no channel, no registry entry, no signal. Handed to the
				// trunk-status publisher, which resolves the endpoint to a trunk row and publishes
				// the write-back event. `handle` never throws — see its own contract.
				await this.trunkStatus?.handle(event);
				return;
		}
	}

	// -------------------------------------------------------------------------------------------
	// Call entry
	// -------------------------------------------------------------------------------------------

	private async onLegArrived(
		channel: MediaChannelSnapshot,
		beforeProgram?: (aggregate: ChannelAggregate) => void,
		waitForCallerAnswer = false,
	): Promise<void> {
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

		if (!(await this.admitWithinConcurrencyCeiling(channel, organizationId))) {
			return;
		}

		const direction = callDirectionFrom(variables.OPTIMIQ_CALL_DIRECTION);
		const admittedAt = Date.now();
		const aggregate = ChannelAggregate.create({
			ariChannelId: channel.id,
			channelId: this.domainLegId(channel.id),
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
		// Armed the moment the leg is ours, so no admitted leg is ever without a timer. Disarmed by
		// the first sign of life — a `180`, progress, or an answer. See `armSetupDeadline`.
		this.armSetupDeadline(aggregate);
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

		beforeProgram?.(aggregate);
		aggregate.transitionTo("executing");
		if (waitForCallerAnswer) {
			this.originatedCallers.set(channel.id, channel);
			return;
		}

		// A third program, chosen by a channel variable exactly as the two below it are chosen by
		// configuration. An INVITE carrying an authorised RFC 3891 `Replaces` has no plan to walk: it
		// does not resolve a destination, it TAKES one that already exists. Walking a plan for it would
		// dial the transfer target a second time, which is the failure `runReplacesProgram` is written
		// out to avoid. Everything above this line — attribution, the ceiling, the KV claim,
		// `channel.created`, the registry, the CDR — is the same code for all three.
		const replacedLegId = aggregate.snapshot.variables[REPLACES_LEG_ID_VARIABLE];
		if (replacedLegId !== undefined && replacedLegId !== "") {
			this.startReplacesProgram(aggregate, replacedLegId);
			return;
		}

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

		const walker = this.walkerFor(aggregate, {
			...(artifact.settings.realm === undefined ? {} : { realm: artifact.settings.realm }),
			...(artifact.prompts === undefined ? {} : { prompts: artifact.prompts }),
			queueNumbers: queueNumbersOf(artifact),
		});

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
			// The extension's CLIR setting. It rides beside the number and the name because it is the
			// third part of one identity: a trunk attempt that carries the number but not the
			// presentation asserts an identity the caller asked to withhold.
			...(route.callerIdPresentation === undefined
				? {}
				: { callerIdPresentation: route.callerIdPresentation }),
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
	private domainLegId(mediaChannelId: string): string {
		return this.media instanceof SplitPlaneMediaPort
			? mediaChannelId
			: legIdForAriChannel(mediaChannelId);
	}

	private walkerFor(
		aggregate: ChannelAggregate,
		extra: {
			readonly beforeBridge?: (bridgeId: string) => Promise<void>;
			/**
			 * The tenant's SIP realm from the compiled artifact (`CompiledRoutingSettings.realm`), when
			 * the caller has the artifact in hand. Both callers do — a routing walk and a re-route each
			 * read the org's artifact one line above — so the realm is passed rather than re-fetched.
			 *
			 * There is NO fleet-wide fallback. A realm identifies exactly one tenant on the sipd plane
			 * (`sip-credentials.service.ts` refuses a realm two organizations claim), so substituting a
			 * deployment default would dial an extension into another tenant's domain. Absent leaves
			 * `sipRealm` undefined and the composite refuses the B-leg `originate` by name.
			 */
			readonly realm?: string;
			/**
			 * The artifact's `prompts` table — prompt row id → `object://<objectKey>`. Passed for the
			 * same reason and by the same two callers as {@link realm}: it is per-organization, it is
			 * in the artifact each of them already holds, and without it a tenant's prompt id is
			 * rendered under the deployment-wide prefix and names a file that does not exist.
			 */
			readonly prompts?: Readonly<Record<string, string>>;
			/**
			 * Queue id → the queue's own dialable number, from the artifact's internal match table.
			 *
			 * Passed for the same reason and by the same two callers as {@link realm}. What needs it is
			 * virtual hold: `QueueCallbackRunner` hands the number to `planQueueCallback` as the `from`
			 * of the outbound resolve, and it is also where the answered customer is put back. Without
			 * it the resolve runs with an empty `from`, so a tenant whose outbound rules are gated on
			 * the queue's toll class matches nothing and every callback is refused `invalid_target` —
			 * which is a promise made to a caller and silently never kept.
			 */
			readonly queueNumbers?: Readonly<Record<string, string>>;
		} = {},
	): PlanWalker {
		// Held in the closure rather than on the aggregate: it belongs to THIS walk, a walk runs its
		// verbs one at a time, and a field on the aggregate would outlive the walk that set it.
		let lastVerbFailure: string | undefined;
		return new PlanWalker({
			media: this.media,
			signals: this.signals,
			channel: walkerChannelFor(aggregate),
			execute: async (verb) => {
				const outcome = await this.execute(aggregate, verb);
				if ("failed" in outcome) {
					lastVerbFailure = outcome.failed;
					return undefined;
				}
				lastVerbFailure = undefined;
				return outcome.ok;
			},
			verbFailure: () => lastVerbFailure,
			publish: (type, data) => this.publishCallEvent(aggregate, type, data),
			settings: this.walkerSettings(extra.realm, extra.prompts),
			peerLegId: (id) => this.domainLegId(id),
			legs: this.legHooksFor(aggregate),
			voicemail: this.voicemailPortFor(aggregate),
			mailbox: this.mailbox,
			// The three self-service seams: the WRITE behind `*72`/`*74`/`*76`/`*78`/`*21`, the ledger
			// read behind `*69`, and the greeting `*99` files. All three are stateless over the shared
			// rpc client, so one instance serves every walk — see `routing.module.ts`.
			features: this.extensionFeatures,
			// `*65`/`*64`'s write seam — the same shape as `features`, aimed at a row that is not on an
			// extension. Missing means the walker announces "not available" rather than pretending the
			// office is now closed.
			...(this.toggles === undefined ? {} : { toggles: this.toggles }),
			// `*31`/`*32` — hot desking. The same shape again, aimed at `device_line`: the walk gathers
			// the extension and the PIN and the API verifies both, because compiling a hot-desk gate
			// would broadcast every agent's PIN digest on the routing bucket. Missing means the code
			// announces rather than leaving a desk phone bound to somebody who has gone home.
			...(this.hotDesk === undefined ? {} : { hotDesk: this.hotDesk }),
			lastCaller: this.lastCaller,
			// `*0`'s gate. Wired in exactly the same shape as its two neighbours above and with the
			// OPPOSITE meaning when it is missing: `features` and `lastCaller` absent means the code
			// announces because the feature cannot run, and `supervision` absent means the code refuses
			// because the engine cannot establish that this handset MAY listen. That asymmetry is
			// stated on `PlanWalkerDependencies.supervision` and enforced in `eavesdropCode`, which has
			// no "no port, therefore allow" branch — this line exists so production never takes it.
			supervision: this.supervision,
			// `greetings` was deliberately absent for one wave, and this is the wire that closed it.
			// The runtime and the port were finished together with the rest of the feature codes; what
			// did not exist was a CONTRACT to carry a recorded greeting to the control plane, because a
			// greeting is not a `voicemail.message.left` — filing one is a two-row write (clear the
			// incumbent, activate the new one) inside a recompile, which
			// `voicemail-greetings.service.ts` explains at length and which
			// `voicemailMessageLeftDataSchema` cannot express. `rpc.pbx.v1.file-greeting` is that
			// contract, and `VoicemailGreetingRpcPort` is this end of it.
			//
			// The port check that runs BEFORE the beep stays exactly where it was: with a port wired,
			// the check passes and the recording happens; without one — a deployment with no rpc client
			// — `*99` still announces "not available" and records nothing, rather than taking thirty
			// seconds of somebody's voice it has nowhere to put.
			greetings: this.greetings,
			// The ACD plane, passed as a bundle rather than five constructor arguments to the walker:
			// a queue node needs all five or none of them, and a walk that had four would fail in the
			// middle of somebody's hold music rather than at construction.
			conferences: this.conferences,
			// The shared-line seizure compare-and-set, plus the one mid-call operation a WALK reaches:
			// dialling a held line's number from a second appearance is a retrieve, and it arrives here
			// as an ordinary call. Seize and release go straight to the registry; retrieve goes through
			// call control, which owns the bridge.
			...(this.sharedLines === undefined
				? {}
				: { sharedLines: this.sharedLinePortFor(aggregate, this.sharedLines) }),
			queue: {
				membership: this.queueMembership,
				agents: this.agentState,
				events: this.queueEvents,
				waiting: this.queueWaiting,
				cursor: this.queueCursors,
				// Virtual hold's sweep. Optional on `QueueServices` and optional here: the token a session
				// writes is already durable when this is called, so a queue the scheduler never heard
				// about is picked up by the next caller who joins it rather than being lost.
				...(this.queueCallbacks === undefined
					? {}
					: { callbacks: queueCallbackPort(this.queueCallbacks, extra.queueNumbers) }),
			},
			control: this.walkerCallControlFor(aggregate),
			// The `application` destination. `run` blocks for the length of the session — see
			// `applicationNode` — so this is the one walker port whose promise outlives the node.
			application: {
				run: async (request) => {
					const outcome = await this.sessions.run({
						application: request.application,
						leg: {
							legId: aggregate.channelId,
							callId: aggregate.callId,
							organizationId: aggregate.organizationId,
							isAnswered: aggregate.isAnswered,
							...(aggregate.snapshot.profile.callerIdNumber === undefined
								? {}
								: { callerIdNumber: aggregate.snapshot.profile.callerIdNumber }),
							...(aggregate.snapshot.profile.callerIdName === undefined
								? {}
								: { callerIdName: aggregate.snapshot.profile.callerIdName }),
						},
						// The SIGNALLING direction, which is what an application needs to know: whether this
						// call arrived at the platform or left it. The organizational `internal` third
						// value is a classification the channel does not carry.
						direction: aggregate.snapshot.direction === "outbound" ? "outbound" : "inbound",
						...(aggregate.snapshot.profile.destinationNumber === undefined
							? {}
							: { dialedNumber: aggregate.snapshot.profile.destinationNumber }),
						...(request.arguments === undefined ? {} : { arguments: request.arguments }),
					});
					// `sessionId` is bookkeeping the walker has no use for — it addresses nothing from
					// there — so it is dropped at this seam rather than widening the walker's port.
					return outcome.kind === "unavailable"
						? { kind: "unavailable", reason: outcome.reason }
						: outcome.kind === "aborted"
							? { kind: "aborted" }
							: { kind: "hangup", cause: outcome.cause };
				},
			},
			trunkCapacity: this.trunkCapacity,
			onDestination: async (destination) => {
				await this.recordDestination(aggregate, destination);
			},
			onQueueOutcome: async (outcome) => {
				await this.recordQueueOutcome(aggregate, outcome);
			},
			onPinAuthorization: async (authorization) => {
				await this.recordPinAuthorization(aggregate, authorization);
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
	/**
	 * One moderation command on one live room. The engine half of `conferences.moderate`.
	 *
	 * ## The order is state-second, and that is the opposite of the join path
	 *
	 * The MEDIA command runs first and the room's record is written only if it succeeded. A record
	 * that says muted while the mixer disagrees is the expensive direction to be wrong in: it is what
	 * a moderation panel renders, and a moderator looking at a muted row does not press mute again.
	 * The join path is the other way round — PIN, registry, bridge — because there the risk is a
	 * caller appearing in a room they failed to enter.
	 *
	 * ## What each action costs on the media plane, and the one that costs nothing
	 *
	 * `mute`/`unmute` and `deaf`/`undeaf` are the SAME media command in two directions:
	 * `MediaPort.mute(channelId, "in")` stops the room hearing them, `"out"` stops them hearing the
	 * room. Both drivers serve it — ARI natively, `mediad` through `rpc.media.v1.mute-session`.
	 *
	 * `kick` removes the member from the bridge and does NOT hang the call up, which is the whole
	 * distinction worth preserving: a kicked participant is out of the meeting and still on a call
	 * the engine could route somewhere. What happens to them next is a routing decision, and this
	 * release ends the leg with `NORMAL_CLEARING` rather than inventing a goodbye destination.
	 *
	 * `volume` is REFUSED on both drivers, and the refusal is typed rather than silent. Asterisk has
	 * no per-participant gain on a mixing bridge at all; `apps/mediad`'s mixer has `Member.SetGain`,
	 * atomic and applied on every frame, and no subject that reaches it. So the capability exists on
	 * one plane and is unreachable, which is a WIRE gap and not a missing feature — the seam is named
	 * on `MediadMediaPort`'s coverage map. Answering `ok` and doing nothing would give a moderator a
	 * slider that moves and changes nothing anybody can hear.
	 *
	 * `lock`/`unlock` touch no media at all: they are a flag in the shared claim, read by every
	 * instance's join path.
	 */
	private async moderateConference(
		request: ConferenceControlRequest,
	): Promise<ConferenceControlOutcome> {
		const organizationId = request.orgId;
		if (request.action === "lock" || request.action === "unlock") {
			return await this.setConferenceLock(request, organizationId);
		}

		if (request.memberRef === undefined) {
			return {
				ok: false,
				action: request.action,
				memberCount: 0,
				reason: "bad-request",
				error: `${request.action} names a participant and no memberRef was given`,
			};
		}
		const member = this.conferences.memberByLeg(
			request.conferenceId,
			request.memberRef,
			organizationId,
		);
		if (member === undefined) {
			// Two different refusals so the caller can tell "try the next contributor" from "this
			// participant is gone from a room I can see". Both mean "try the next one" to an api that
			// has more contributors left; only the second is worth logging when they are exhausted.
			const room = this.conferences.room(request.conferenceId, organizationId);
			return {
				ok: false,
				action: request.action,
				memberCount: room?.memberCount ?? 0,
				...(room === undefined ? {} : { locked: room.locked }),
				reason: room === undefined ? "unknown-conference" : "unknown-member",
				error:
					room === undefined
						? "no such conference on this instance"
						: "the room is on this instance and that member is not",
			};
		}

		if (request.action === "volume") {
			// Typed, and named, rather than a silent no-op. See the method doc: the mixer's per-member
			// gain exists on one media plane and has no subject to reach it, and the other has no
			// per-participant gain at all.
			return {
				ok: false,
				action: "volume",
				memberRef: request.memberRef,
				memberCount: this.conferences.room(request.conferenceId, organizationId)?.memberCount ?? 0,
				muted: member.muted,
				deafened: member.deafened,
				moderator: member.moderator,
				talkGainPercent: member.talkGainPercent,
				listenGainPercent: member.listenGainPercent,
				reason: "not-servable",
				error:
					"no media plane on this platform can re-level one conference participant: Asterisk " +
					"has no per-participant gain on a mixing bridge, and mediad's mixer has one with no " +
					"command that reaches it",
			};
		}

		if (request.action === "kick") {
			return await this.kickConferenceMember(request, member, organizationId);
		}

		// `mute`/`deaf` are one media command in two directions. `in` is audio arriving FROM the leg —
		// the room stops hearing them; `out` is audio sent TO it — they stop hearing the room.
		const direction: MediaDirection =
			request.action === "mute" || request.action === "unmute" ? "in" : "out";
		const lifting = request.action === "unmute" || request.action === "undeaf";
		try {
			await (lifting
				? this.media.unmute(member.mediaChannelId, direction)
				: this.media.mute(member.mediaChannelId, direction));
		} catch (error) {
			return {
				ok: false,
				action: request.action,
				memberRef: request.memberRef,
				memberCount: this.conferences.room(request.conferenceId, organizationId)?.memberCount ?? 0,
				reason: "media-refused",
				error: String(error),
			};
		}

		const updated =
			this.conferences.setMemberState(
				request.conferenceId,
				request.memberRef,
				direction === "in" ? { muted: !lifting } : { deafened: !lifting },
				organizationId,
			) ?? member;
		await this.publishConferenceMemberState(request, updated);
		return this.memberOutcome(request, updated, organizationId);
	}

	/**
	 * Removes a member from the room without hanging up their call — and then hangs it up.
	 *
	 * The two steps are separate on purpose even though this release always does both. Leaving the
	 * bridge is the MEETING ending for them; ending the leg is a routing decision about a caller who
	 * is now in no destination, and a release that had a "kicked participants go here" setting would
	 * change only the second half. `NORMAL_CLEARING` rather than `CALL_REJECTED`: the call was
	 * accepted and completed, and a CDR that said rejected would misreport every meeting somebody was
	 * removed from.
	 */
	private async kickConferenceMember(
		request: ConferenceControlRequest,
		member: ConferenceMember,
		organizationId: string,
	): Promise<ConferenceControlOutcome> {
		const room = this.conferences.room(request.conferenceId, organizationId);
		try {
			if (room !== undefined) {
				await this.media.removeFromBridge(room.bridgeId, [member.mediaChannelId]);
			}
		} catch (error) {
			return {
				ok: false,
				action: "kick",
				memberRef: request.memberRef ?? member.legId,
				memberCount: room?.memberCount ?? 0,
				reason: "media-refused",
				error: String(error),
			};
		}

		const departure = await this.conferences.leave(
			request.conferenceId,
			member.mediaChannelId,
			organizationId,
		);
		// The reason and the moderator who chose it, which is the whole point of the field: a report
		// that could not tell a kick from a hangup would show a meeting four people left early and no
		// evidence anybody removed them.
		await this.events.publish("conference.left", {
			orgId: organizationId,
			callId: member.legId,
			data: {
				legId: member.legId,
				conferenceId: request.conferenceId,
				roomNumber: room?.conferenceId ?? request.conferenceId,
				bridgeId: room?.bridgeId ?? request.conferenceId,
				moderator: member.moderator,
				memberCount: departure.memberCount,
				reason: "kicked",
				...(request.byUserId === undefined ? {} : { byUserId: request.byUserId }),
			},
		});
		await this.hangupQuietly(member.mediaChannelId, "NORMAL_CLEARING");

		return {
			ok: true,
			action: "kick",
			memberRef: request.memberRef ?? member.legId,
			memberCount: departure.memberCount,
			...(room === undefined ? {} : { locked: room.locked }),
		};
	}

	private async setConferenceLock(
		request: ConferenceControlRequest,
		organizationId: string,
	): Promise<ConferenceControlOutcome> {
		const locked = request.action === "lock";
		const result = await this.conferences.setLocked(request.conferenceId, locked, {
			organizationId,
			...(request.byUserId === undefined ? {} : { byUserId: request.byUserId }),
		});
		if (result.kind === "unknown-conference") {
			return {
				ok: false,
				action: request.action,
				memberCount: 0,
				reason: "unknown-conference",
				error: "no such conference on this instance",
			};
		}
		if (result.kind === "claims-unavailable") {
			return {
				ok: false,
				action: request.action,
				memberCount: 0,
				reason: "internal",
				error: result.reason,
			};
		}

		await this.events.publish(locked ? "conference.locked" : "conference.unlocked", {
			orgId: organizationId,
			// The ROOM's id as the call token, because a lock has no leg. See the event's own note on
			// why carrying one would invite a consumer to attribute the lock to a participant.
			callId: request.conferenceId,
			data: {
				conferenceId: request.conferenceId,
				roomNumber: request.conferenceId,
				memberCount: result.memberCount,
				...(request.byUserId === undefined ? {} : { byUserId: request.byUserId }),
			},
		});

		return {
			ok: true,
			action: request.action,
			memberCount: result.memberCount,
			locked: result.locked,
		};
	}

	private memberOutcome(
		request: ConferenceControlRequest,
		member: ConferenceMember,
		organizationId: string,
	): ConferenceControlOutcome {
		const room = this.conferences.room(request.conferenceId, organizationId);
		return {
			ok: true,
			action: request.action,
			memberRef: member.legId,
			memberCount: room?.memberCount ?? 0,
			...(room === undefined ? {} : { locked: room.locked }),
			muted: member.muted,
			deafened: member.deafened,
			moderator: member.moderator,
			talkGainPercent: member.talkGainPercent,
			listenGainPercent: member.listenGainPercent,
		};
	}

	/**
	 * Announces a member's WHOLE state after a change.
	 *
	 * Whole and not a delta, for the reason the event says: a participant list is rebuilt from these,
	 * and a consumer that applied a delta to a row drawn from a frame it missed would show a mute
	 * button that disagrees with the mixer.
	 */
	private async publishConferenceMemberState(
		request: ConferenceControlRequest,
		member: ConferenceMember,
	): Promise<void> {
		await this.events.publish("conference.participant.updated", {
			orgId: request.orgId,
			callId: member.legId,
			data: {
				legId: member.legId,
				conferenceId: request.conferenceId,
				roomNumber: request.conferenceId,
				muted: member.muted,
				deafened: member.deafened,
				moderator: member.moderator,
				talkGainPercent: member.talkGainPercent,
				listenGainPercent: member.listenGainPercent,
				...(request.byUserId === undefined ? {} : { byUserId: request.byUserId }),
			},
		});
	}

	private controlledLegFor(mediaChannelId: string): ControlledLeg | undefined {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		return aggregate === undefined ? undefined : this.controlledLeg(aggregate);
	}

	/**
	 * The same lookup keyed by the DOMAIN leg id — the identifier everything outside this process
	 * uses. See {@link CallControlHost.legByLegId} for why both exist.
	 */
	private controlledLegByLegId(legId: string): ControlledLeg | undefined {
		const aggregate = this.registry.byDomainChannelId(legId);
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
			get side(): LegSide {
				return legSideOf(aggregate);
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

	/**
	 * The PBX recording control: pause, resume or stop the recording on a call NOBODY was handed.
	 *
	 * ## The whole authorisation, in the order it runs
	 *
	 * legs of this call in THIS organization → this instance still owns one → something is actually
	 * recording on it → the verb. The organization comes from the request and is compared against
	 * the LEG's own, never the other way round, so a caller who guesses a call id from another
	 * tenant finds nothing and is answered exactly as one who guessed an id that never existed.
	 * That is the same "do not let them enumerate" rule `ApplicationSessions.execute` follows for
	 * the session channel.
	 *
	 * ## Why `legId` is usually absent, and what is done about it
	 *
	 * The control plane knows the CALL — that is what the `channels` bucket and the CDR are keyed by
	 * — and not which of its legs the recorder is attached to. So an absent `legId` means "the
	 * recorded leg of this call", answered by asking the call-control runtime which of this call's
	 * legs has a session. It is unambiguous because `startRecording` refuses a second recording on a
	 * leg that already has one, and because the on-demand recorder attaches to the leg that asked
	 * for it rather than to both sides.
	 *
	 * ## `wrong_instance` and `unknown-call` say different things
	 *
	 * The first means the address was stale: this instance has the leg in its registry and the
	 * ownership variable names somebody else, which is the window between a failover and an
	 * adoption. The caller should re-read the bucket. The second means nothing here has ever heard
	 * of the call — it ended, or it is on an instance the caller has not addressed — and the button
	 * should go away.
	 */
	private async controlCallRecording(request: CallControlRequest): Promise<CallControlOutcome> {
		if (this.draining) {
			return {
				ok: false,
				verb: request.verb,
				reason: "shutting-down",
				error: "this instance is draining",
			};
		}

		// A linear scan of this instance's legs, deliberately: there is no by-call index, the map is
		// one entry per LIVE leg on one process, and the caller is a person pressing a button. A
		// fifth index maintained on every call setup to serve a human-speed path would cost the hot
		// path to save this one nothing measurable.
		const legs = this.registry.all.filter(
			(aggregate) =>
				aggregate.callId === request.callId &&
				aggregate.organizationId === request.orgId &&
				!aggregate.isTearingDown &&
				(request.legId === undefined || aggregate.channelId === request.legId),
		);
		if (legs.length === 0) {
			return {
				ok: false,
				verb: request.verb,
				reason: "unknown-call",
				error: "no live leg of that call in that organization on this instance",
			};
		}
		// A leg whose ownership variable is ABSENT counts as ours. It is in this instance's registry,
		// which is the stronger fact, and the variable is stamped by the KV mirror — so a call
		// controlled in the window between admission and the first `putChannel` would otherwise be
		// refused as somebody else's. Only a variable that NAMES another instance is evidence.
		const owned = legs.filter((aggregate) => {
			const owner = aggregate.snapshot.variables[CHANNEL_OWNER_INSTANCE_VARIABLE];
			return owner === undefined || owner === this.env.ENGINE_INSTANCE_ID;
		});
		if (owned.length === 0) {
			return {
				ok: false,
				verb: request.verb,
				legId: legs[0]?.channelId,
				reason: "wrong_instance",
				error: "another engine instance owns that leg; re-read the channels bucket",
			};
		}

		const recorded = owned
			.map((aggregate) => ({
				aggregate,
				recording: this.control.recordingFor(aggregate.ariChannelId),
			}))
			.find((candidate) => candidate.recording !== undefined);
		if (recorded === undefined) {
			return {
				ok: false,
				verb: request.verb,
				legId: owned[0]?.channelId,
				recording: false,
				reason: "not-recording",
				error: "nothing is being recorded on that call",
			};
		}

		const leg = this.controlledLeg(recorded.aggregate);
		const result =
			request.verb === "stopRecord"
				? await this.control.stopRecording(leg)
				: await this.control.pauseRecording(leg, request.verb === "pauseRecord");
		const after = this.control.recordingFor(recorded.aggregate.ariChannelId);
		if (!result.ok) {
			this.logger.info(
				{
					orgId: request.orgId,
					callId: request.callId,
					legId: leg.legId,
					verb: request.verb,
					byUserId: request.byUserId,
					reason: result.reason,
				},
				"a recording control verb was refused",
			);
			return {
				ok: false,
				verb: request.verb,
				legId: leg.legId,
				recording: after !== undefined,
				...(after === undefined ? {} : { paused: after.paused }),
				// The media plane refusing is NOT the same as the platform being unable to: the ARI
				// driver refuses `pauseRecording` outright because its pause SHORTENS the file, so the
				// intervals it reported would not name the silence they describe — and a caller has to
				// be able to HIDE the control for that rather than retry it. `CallControl` flattens the
				// throw into its refusal string, so the driver's own error NAME is what tells the two
				// apart; it is a pinned field on the class, not a message a rewording can lose.
				reason: result.reason.includes("MediaOperationNotSupportedError")
					? "unsupported"
					: "media-refused",
				error: result.reason,
			};
		}

		this.logger.info(
			{
				orgId: request.orgId,
				callId: request.callId,
				legId: leg.legId,
				verb: request.verb,
				byUserId: request.byUserId,
			},
			"a recording control verb ran",
		);
		return {
			ok: true,
			verb: request.verb,
			legId: leg.legId,
			recording: after !== undefined,
			...(after === undefined ? {} : { paused: after.paused }),
		};
	}

	/** Everything the call-control runtime needs that only this class can answer. */
	private callControlHost(): CallControlHost {
		return {
			legFor: (mediaChannelId) => this.controlledLegFor(mediaChannelId),
			legByLegId: (legId) => this.controlledLegByLegId(legId),
			ringingFor: async (leg, extension) => await this.ringingCandidates(leg, extension),
			activeCallsFor: (leg, extension) => this.supervisionTargets(leg, extension),
			publish: async (leg, type, data) => {
				const aggregate = this.registry.byDomainChannelId(leg.legId);
				if (aggregate === undefined) {
					return;
				}
				await this.publishCallEvent(aggregate, type, data);
			},
			markRecording: (leg, state) => {
				const recorded = this.registry.byDomainChannelId(leg.legId);
				if (recorded === undefined) {
					this.logger.warn(
						{ legId: leg.legId, active: state.active, paused: state.paused },
						"could not mirror a recording state: this instance no longer holds the leg",
					);
					return;
				}
				// BOTH legs of the call, not only the one the recorder is attached to. A conversation
				// recording covers the two parties, and the surface that has to draw the indicator is
				// the softphone of whoever is ON the call — which reads its OWN `channels` row. Stamping
				// the recorded leg alone left the agent's row saying `flags: ["answered"]` while a
				// recorder was demonstrably running, so the control was never drawn however well the
				// pause worked.
				const peer = recorded.snapshot.variables[BRIDGE_PEER_VARIABLE];
				const legs = [
					recorded,
					...(peer === undefined ? [] : [this.registry.byDomainChannelId(peer)]),
				];
				for (const aggregate of legs) {
					// A leg on its way out is skipped rather than mirrored, on the same rule every other
					// late write here follows: the teardown has already cleared the KV entry, and a write
					// after it would leave a live-looking channel for a call that is over.
					if (aggregate === undefined || aggregate.isTearingDown) {
						continue;
					}
					if (state.active) {
						aggregate.addFlag("recording");
					} else {
						aggregate.removeFlag("recording");
					}
					if (state.active && state.paused) {
						aggregate.addFlag("recording-paused");
					} else {
						aggregate.removeFlag("recording-paused");
					}
					void this.jetstream.putChannel(aggregate.snapshot);
				}
			},
			route: async (leg, request) => await this.routeLeg(leg, request),
			parkLotFor: async (leg, lotRef) => await this.parkLotFor(leg, lotRef),
			parkLotForSlot: async (leg, slot) => await this.parkLotForSlot(leg, slot),
			sharedLineFor: async (leg, sharedLineId) => await this.sharedLineFor(leg, sharedLineId),
		};
	}

	/** The narrow slice of call control a plan node can reach, bound to the leg being walked. */
	private walkerCallControlFor(aggregate: ChannelAggregate): WalkerCallControl {
		const leg = this.controlledLeg(aggregate);
		return {
			startRecording: async () => {
				const outcome = await this.control.startRecording(leg);
				return outcome.result;
			},
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
			/**
			 * `*0` — the supervisor's leg joining somebody else's conversation.
			 *
			 * A straight adaptation: everything interesting is in `CallControl.monitor`, and the
			 * walker's contract differs from it only in that a walker outcome carries no `detail`. The
			 * supervising extension is taken from the LEG's own caller id rather than from the walker,
			 * because it is the identity the SIP edge authenticated and the identity the gate was
			 * asked about — reading it back off the request would let the two disagree.
			 */
			monitor: async (request) => {
				const result = await this.control.monitor(leg, {
					extension: request.extension,
					mode: request.mode,
					supervisorExtension: leg.callerIdNumber ?? "",
				});
				return result.ok ? { ok: true } : { ok: false, reason: result.reason };
			},
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
		const callerIdNumber = request.callerIdNumber ?? resolved.callerIdNumber;
		const callerIdName = request.callerIdName ?? resolved.callerIdName;
		const outcome = await this.walkerFor(aggregate, {
			...(beforeBridge === undefined ? {} : { beforeBridge: async () => await beforeBridge() }),
			...(artifact.settings.realm === undefined ? {} : { realm: artifact.settings.realm }),
			...(artifact.prompts === undefined ? {} : { prompts: artifact.prompts }),
			queueNumbers: queueNumbersOf(artifact),
		}).walk({
			plan: resolved.plan as ExecutionPlan,
			timeConditions: artifact.timeConditions,
			now,
			// The digits that were dialled, so a park lot on the far side can tell a retrieval from a
			// park exactly as it would for a caller who dialled them.
			originalDialedNumber: request.destination,
			...(resolved.dialedNumber === undefined ? {} : { dialedNumber: resolved.dialedNumber }),
			// The RESOLVE's identity behind the request's, which is the same cascade the inbound walk
			// uses and was missing here entirely. A re-entrant dial — `*67<number>`, `*82<number>`,
			// `*69` — arrives with no caller id on the request, so the walk had none to put on the
			// trunk attempt and the INVITE asserted the EDGE's own identity instead of the caller's:
			// under `Privacy: id` that is the harmful direction, because the network is told to
			// withhold an identity that was never asserted.
			...(callerIdNumber === undefined ? {} : { callerIdNumber }),
			...(callerIdName === undefined ? {} : { callerIdName }),
			// And the presentation beside them, for the reason it rides beside them on the main walk:
			// the three are one identity, and a leg that carries the number without the flag asserts
			// what the caller asked to withhold.
			...(resolved.callerIdPresentation === undefined
				? {}
				: { callerIdPresentation: resolved.callerIdPresentation }),
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
	 * Answered calls at an extension that THIS instance is holding, oldest first — what `*0` taps.
	 *
	 * The mirror image of {@link ringingCandidates} and deliberately written beside it, because the
	 * two scans differ in exactly the ways the two features do:
	 *
	 * - A pickup wants a leg that is RINGING; supervision wants one that is ANSWERED.
	 * - A pickup only ever looks at B-legs, because only a B-leg rings on somebody's behalf.
	 *   Supervision looks at both, because an extension is equally on a call when it DIALLED one —
	 *   so a leg matches if the extension is either what the leg was dialled to reach
	 *   (`destinationNumber`, an inbound call) or the identity it presented (`callerIdNumber`, an
	 *   outbound one).
	 * - A pickup filters by pickup group; supervision's gate is a permission the control plane
	 *   answered before this method was reachable, and re-deriving a second, telephony-shaped gate
	 *   here would be a quieter copy of the permission model.
	 *
	 * `isDetached` is excluded along with `isTearingDown`: a detached leg is alive and belongs to
	 * somebody else now (a pickup took it over), and tapping it would attach a supervisor to a
	 * conversation whose routing has already moved on.
	 *
	 * `OPTIMIQ_LEG` gives the SIDE — the leg the engine dialled on somebody's behalf is `b` and
	 * everything else is `a` — which is the one fact the media plane needs in order to make whisper
	 * mean "speak to this party" rather than "inject into this direction". See
	 * {@link import("../media/media-port").TapRequest.targetSide}.
	 *
	 * The instance-local limitation is stated at length on {@link CallControl.monitor}, which is
	 * where the announcement a supervisor actually hears is decided.
	 */
	private supervisionTargets(leg: ControlledLeg, extension: string): readonly SupervisionTarget[] {
		const wanted = extension.trim();
		if (wanted === "") {
			return [];
		}
		const targets: SupervisionTarget[] = [];

		for (const aggregate of this.registry.all) {
			if (
				aggregate.organizationId !== leg.organizationId ||
				aggregate.isTearingDown ||
				aggregate.isDetached ||
				!aggregate.isAnswered ||
				aggregate.ariChannelId === leg.mediaChannelId
			) {
				continue;
			}
			const profile = aggregate.snapshot.profile;
			if (profile.destinationNumber !== wanted && profile.callerIdNumber !== wanted) {
				continue;
			}
			targets.push({
				leg: this.controlledLeg(aggregate),
				side: legSideOf(aggregate),
				startedAtMs: aggregate.snapshot.createdAt,
			});
		}

		// Oldest first. The rule is stated on `CallControl.monitor`; the sort is here because this is
		// where `createdAt` lives.
		return targets.sort((left, right) => left.startedAtMs - right.startedAtMs);
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

	/** The walker's shared-line port: the registry, plus the retrieve that needs a bridge. */
	private sharedLinePortFor(
		aggregate: ChannelAggregate,
		lines: SharedLineRegistry,
	): NonNullable<PlanWalkerDependencies["sharedLines"]> {
		return {
			seize: async (orgId, sharedLineId, seizing) =>
				await lines.seize(orgId, sharedLineId, seizing),
			releaseOwn: async (orgId, sharedLineId) => await lines.releaseOwn(orgId, sharedLineId),
			held: (orgId, sharedLineId) => lines.held(orgId, sharedLineId),
			retrieve: async (orgId, sharedLineId) => {
				const outcome = await this.control.retrieveSharedLine(this.controlledLeg(aggregate), {
					sharedLineId,
				});
				return outcome.ok
					? { retrieved: true }
					: {
							retrieved: false,
							...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
						};
			},
		};
	}

	/**
	 * A shared line as the mid-call half needs it, from the compiled artifact.
	 *
	 * The recall timeout and the appearance NUMBERS, which is the pair the seizure cannot carry: a
	 * seizure records an extension ID, and a recall has to ring a number. Looked up by scanning the
	 * artifact's nodes, which is the same shape `parkLots` uses and for the same reason — there is no
	 * `sharedLineId -> node` index in the artifact, and building one here would be a second cache to
	 * keep in step with the first.
	 */
	private async sharedLineFor(
		leg: ControlledLeg,
		sharedLineId: string,
	): Promise<SharedLine | undefined> {
		const artifact = await this.routing.get(leg.organizationId);
		if (artifact === undefined) {
			return undefined;
		}
		for (const node of Object.values(artifact.nodes)) {
			if (node.kind !== "shared-line" || node.sharedLineId !== sharedLineId) {
				continue;
			}
			return {
				sharedLineId,
				holdRecallTimeoutSeconds: node.holdRecallTimeoutSeconds,
				appearances: node.appearances.map((appearance) => ({
					appearanceIndex: appearance.appearanceIndex,
					extensionId: appearance.extensionId,
					extensionNumber: appearance.extensionNumber,
				})),
			};
		}
		return undefined;
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
					channelId: this.domainLegId(leg.mediaChannelId),
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
				if (this.media instanceof SplitPlaneMediaPort) {
					this.media.registerOutboundLeg(leg.mediaChannelId, {
						orgId: bLeg.organizationId,
						callId: bLeg.callId,
					});
				}
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
	/**
	 * @param realm the tenant's SIP realm — the per-org value from the compiled artifact, already
	 *   read from the compiled artifact by {@link walkerFor} and never from a deployment default. Absent leaves
	 *   {@link PlanWalkerSettings.sipRealm} undefined, which is exactly right on the Asterisk plane and
	 *   makes the composite refuse an extension B-leg's `originate` by name on the `sipd` plane rather
	 *   than dialling a hostless URI.
	 */
	private walkerSettings(
		realm?: string,
		prompts?: Readonly<Record<string, string>>,
	): Partial<PlanWalkerSettings> {
		return {
			application: this.env.ARI_APP,
			extensionDialTemplate: this.env.ENGINE_EXTENSION_DIAL_TEMPLATE,
			trunkDialTemplate: this.env.ENGINE_TRUNK_DIAL_TEMPLATE,
			...(realm === undefined || realm === "" ? {} : { sipRealm: realm }),
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
				prompts: prompts ?? {},
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
	 * `gather` is only useful if the digits come back.
	 *
	 * It returns the failure's DETAIL rather than a bare `undefined` for a reason the live stack
	 * taught: `mediad refused start-playback (bad_request): audio: no such prompt: sound:moh/default`
	 * ended up in a log line and nowhere else, so the call it broke showed up as an IVR the caller
	 * abandoned. {@link walkerFor} collapses this back to `undefined` for the walk — which still
	 * treats a failed verb as fatal — while keeping the sentence for the walk's notes.
	 */
	private async execute(
		aggregate: ChannelAggregate,
		verb: Verb,
	): Promise<{ ok: VerbResult } | { failed: string }> {
		if (verb.verb === "ringing" && aggregate.isAnswered) {
			return { ok: { verb: "ringing", endReason: "completed" } };
		}
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
			isAnswered: aggregate.isAnswered,
		};

		const exit = await this.runtime.runPromiseExit((executor) => executor.dispatch(context, verb));
		if (Exit.isSuccess(exit)) {
			return { ok: exit.value };
		}

		this.logger.warn(
			{ verb: verb.verb, channelId: aggregate.channelId, cause: Cause.pretty(exit.cause) },
			"verb execution failed",
		);
		return { failed: verbFailureDetail(verb.verb, exit.cause) };
	}

	/**
	 * Runs one verb for the session protocol, keeping the typed failure instead of collapsing it.
	 *
	 * The sibling of {@link ChannelOrchestrator.execute} and deliberately not a call into it: that
	 * one answers a PLAN WALKER, whose only question is "did the verb work", and it turns every
	 * failure into `undefined` with a log line. An external application needs the difference —
	 * `unsupported` means stop asking, `not-permitted` means the leg is not in a state for this and
	 * the reason says which — so this path preserves the failure's tag and message all the way to
	 * the socket.
	 */
	private async executeForSession(legId: string, verb: Verb): Promise<VerbDispatchOutcome> {
		const aggregate = this.registry.byDomainChannelId(legId);
		if (aggregate === undefined) {
			return { ok: false, reason: "internal", error: "this engine is no longer handling the leg" };
		}
		if (verb.verb === "hangup") {
			// The same first-wins cause fix `execute` performs, and for the same reason: without it
			// every call an application ended would report the media server's generic code instead of
			// the cause the application chose.
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
			isAnswered: aggregate.isAnswered,
		};
		const exit = await this.runtime.runPromiseExit((executor) => executor.dispatch(context, verb));
		if (Exit.isSuccess(exit)) {
			return { ok: true, result: exit.value };
		}
		const failure = Cause.findErrorOption(exit.cause);
		if (failure._tag === "None") {
			this.logger.error(
				{ verb: verb.verb, channelId: legId, cause: Cause.pretty(exit.cause) },
				"a session verb died rather than failing",
			);
			return { ok: false, reason: "internal", error: "the verb died" };
		}
		const error = failure.value;
		switch (error._tag) {
			case "UnsupportedVerbFailure":
				return {
					ok: false,
					reason: "unsupported",
					error: `the engine does not implement ${error.verb}`,
				};
			case "VerbNotPermittedFailure":
				return { ok: false, reason: "not-permitted", error: error.reason };
			case "MediaCommandFailure":
				return { ok: false, reason: "not-permitted", error: error.detail };
			default:
				// `UnknownChannelFailure` — the leg vanished between the registry lookup above and the
				// dispatch. Reported as `internal` rather than `unknown-leg`, which the session layer
				// owns and which means something more specific: the SESSION does not name this leg.
				return { ok: false, reason: "internal", error: `the leg ${error.channelId} is unknown` };
		}
	}

	// -------------------------------------------------------------------------------------------
	// Progress
	// -------------------------------------------------------------------------------------------

	private async onCallStateChanged(
		mediaChannelId: string,
		nextCallState: CallState,
		sdpAnswer?: string,
	): Promise<void> {
		const aggregate = this.registry.byAriChannelId(mediaChannelId);

		// Settle the callee's SDP before signalling answer to the walker. Routed B-legs
		// already have an aggregate because their ownership is claimed before origination.
		if (
			nextCallState === "active" &&
			sdpAnswer !== undefined &&
			this.media instanceof SplitPlaneMediaPort
		) {
			if (!(await this.settleOutboundAnswer(mediaChannelId, sdpAnswer))) return;
		}

		// The same settle a beat earlier, when the carrier committed its answer on a `183` instead of a
		// `200`. Nothing about billing moves here — `markAnswered` below stays on `active` — but the
		// audio has to be accepted now or the caller hears silence over the announcement that told
		// them the number is out of service.
		if (
			nextCallState === "early" &&
			sdpAnswer !== undefined &&
			this.media instanceof SplitPlaneMediaPort
		) {
			if (!(await this.settleOutboundAnswer(mediaChannelId, sdpAnswer))) return;
			await this.relayEarlyMedia(mediaChannelId);
		}
		if (aggregate === undefined) {
			this.emitLegProgress(mediaChannelId, nextCallState);
			return;
		}

		// The A-leg's own progress is published on the bus too, because `ensureAnswered` in the
		// walker waits for exactly this: `answer` is a request and `active` is the confirmation.
		this.emitLegProgress(mediaChannelId, nextCallState);

		// A split-plane B-leg's dialog identity, filed the first time the leg says anything. The
		// originate reply is where the `Call-ID` becomes knowable and the arrival path never sees it,
		// so without this the leg carries no `sip_call_id` on its CDR row and — the sharper half —
		// `resolveSipDialog` cannot find it, which is what makes the engine answer `unknown_dialog` to
		// a REFER sent by the party who ANSWERED. Split plane only: on ARI the arrival path already
		// read the value and a second read would be an HTTP round trip per state change.
		if (
			this.media instanceof SplitPlaneMediaPort &&
			aggregate.snapshot.variables[SIP_CALL_ID_VARIABLE] === undefined
		) {
			await this.recordSipDialogFor(aggregate);
		}

		if (aggregate.isTearingDown) {
			return;
		}

		// A leg that has COMMITTED an offer/answer exchange on a `183` is not un-committed by a later
		// `180`. The state machine allows `early → ringing` because a leg can genuinely fall back to
		// ringback, but on this path the 180 is either a retransmission or a chatty carrier, and
		// letting it win reported a leg carrying audio as one that is merely alerting — on the
		// `channels` mirror a softphone and a wallboard both read.
		if (nextCallState === "ringing" && aggregate.snapshot.callState === "early") {
			return;
		}

		if (!aggregate.tryCallStateTo(nextCallState)) {
			return;
		}

		// Any call state past `initializing` is a response the caller can hear: the leg is alive and
		// the setup phase this deadline bounds is over.
		this.disarmSetupDeadline(mediaChannelId);

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

		const originatedCaller = this.originatedCallers.get(mediaChannelId);
		if (justAnswered && originatedCaller !== undefined) {
			this.originatedCallers.delete(mediaChannelId);
			this.startRoutedProgram(aggregate, originatedCaller);
			return;
		}

		// After the mirror, so a failover that happens mid-announcement sees an answered leg.
		// A-legs only: the pre-routing announcement is for the CALLER. Playing it at a callee's leg
		// the walker just dialled would talk over the person who picked up.
		if (justAnswered && legSideOf(aggregate) === "a") {
			await this.runAnsweredProgram(aggregate);
		}
	}

	/**
	 * Settles a B-leg's negotiated codec on `mediad` from the callee's answer, §5.2.
	 *
	 * The composite exposes `settleOutboundAnswer` for exactly this call — it is not a `MediaPort`
	 * method, because the answer is not known when `originate` returns; it arrives later, on the
	 * `dialog.answered` this handler is processing. The result is data, not a throw: an `ok` reply has
	 * committed the codec, and a refusal is the callee answering with something `mediad` cannot serve
	 * (G.729, say), which is a real destination failure and not an engine fault. That B-leg is hung up
	 * with `INCOMPATIBLE_DESTINATION` (Q.850 88) — the cause the plan walker reads as a dial failure —
	 * so the walk fails it over rather than bridging a leg whose media will never flow.
	 *
	 * @returns `true` when the codec settled and the leg may be reported answered; `false` when it was
	 *   refused and the leg has been torn down.
	 */
	private async settleOutboundAnswer(channelId: string, sdpAnswer: string): Promise<boolean> {
		const port = this.media;
		if (!(port instanceof SplitPlaneMediaPort)) {
			return true;
		}
		const reply = await port.settleOutboundAnswer(channelId, sdpAnswer);
		if (reply.ok) {
			return true;
		}
		this.logger.warn(
			{ channelId, reason: reply.reason, detail: reply.error },
			"mediad refused the B-leg answer (the callee chose a codec it cannot serve); hanging the leg up",
		);
		await port.hangup(channelId, "INCOMPATIBLE_DESTINATION");
		return false;
	}

	/**
	 * Passes a B-leg's early media on to the caller as a `183` of their own.
	 *
	 * The carrier's audio is settled on the B-leg by the time this runs, but the A-leg is still an
	 * un-answered dialog with no media path — so nothing reaches the person who dialled until their own
	 * offer/answer exchange is committed too, which is what the `183` does.
	 *
	 * ## Two ways to name the originator, because one of them was silently empty
	 *
	 * The composite's own record is asked first: {@link SplitPlaneMediaPort.originate} stamps the leg
	 * it was dialled FOR, and that is the authoritative answer. It is not the ONLY one, and treating it
	 * as such is what made this feature fail on the wire with no log line at all — a B-leg whose plane
	 * record was rebuilt without it (an adoption, a re-registration, a leg the port learned about after
	 * the originate) returns `undefined` here and the caller silently hears nothing until the `200`.
	 * `OPTIMIQ_ORIGINATING_LEG_ID` is the same fact mirrored onto the B-leg as a channel variable — it
	 * is what assembles a fan-out back into one call on the CDR — so it can answer the same question
	 * from the registry when the port cannot, and it survives a failover where the port record does not.
	 *
	 * Anything left after both is logged. The silence on this path is why finding it took a wire
	 * capture, and a `warn` costs one line per call that could not relay.
	 *
	 * Best-effort. A refusal here costs the caller the announcement, and failing the call over it would
	 * cost them the call — and the `200` that follows will open the media path anyway.
	 */
	private async relayEarlyMedia(mediaChannelId: string): Promise<void> {
		const port = this.media;
		if (!(port instanceof SplitPlaneMediaPort)) {
			return;
		}
		const originator = port.originatorOf(mediaChannelId) ?? this.originatorFromLeg(mediaChannelId);
		if (originator === undefined) {
			this.logger.warn(
				{ legId: mediaChannelId },
				"early media arrived on a leg with no known originator; the caller hears ringback until answer",
			);
			return;
		}
		try {
			await port.earlyMedia(originator, mediaChannelId);
		} catch (error) {
			this.logger.warn(
				{ channelId: originator, legId: mediaChannelId, err: String(error) },
				"could not relay the callee's early media to the caller; they hear ringback until answer",
			);
		}
	}

	/**
	 * The media channel of the leg that dialled this one, off the B-leg's own mirrored variable.
	 *
	 * The fallback half of {@link relayEarlyMedia}'s originator lookup. `OPTIMIQ_ORIGINATING_LEG_ID`
	 * holds the DOMAIN leg id (that is what the CDR links on), so it is resolved through the registry
	 * to get back to the media channel every port command is addressed by.
	 */
	private originatorFromLeg(mediaChannelId: string): string | undefined {
		const originatingLegId =
			this.registry.byAriChannelId(mediaChannelId)?.snapshot.variables.OPTIMIQ_ORIGINATING_LEG_ID;
		if (originatingLegId === undefined) {
			return undefined;
		}
		return this.registry.byDomainChannelId(originatingLegId)?.ariChannelId;
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

		// What the far end asked for, else the class the destination this call reached configured,
		// else nothing — which the media port reads as its own default. A SIP phone naming a class is
		// the rare case (`ari-mapping` carries one when Asterisk reports it); a re-INVITE naming none
		// is every browser softphone, and it is the case the variable exists for.
		const mohClass = musicClass ?? this.mohClassFor(aggregate, peer);

		if (peer !== undefined && !peer.isTearingDown) {
			try {
				if (held) {
					await this.media.startMusicOnHold(peer.ariChannelId, mohClass);
				} else {
					await this.media.stopMusicOnHold(peer.ariChannelId);
				}
			} catch (error) {
				// The held party now hears silence, which is the outcome this whole path exists to
				// prevent, so the class that could not be started is named: the live stack's version of
				// this was `no such prompt: sound:moh/default` on a deployment with no prompt pack, and
				// a log line that did not say which class was asked for could not have told anybody so.
				this.logger.warn(
					{
						ariChannelId: peer.ariChannelId,
						held,
						mohClass: mohClass ?? "(the media server's default)",
						err: String(error),
					},
					"could not move the far end's hold music; the held party hears silence",
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
					...(held && mohClass !== undefined ? { mohClass } : {}),
				} as never,
			});
			await this.jetstream.putChannel(peer.snapshot);
		}

		await this.jetstream.putChannel(aggregate.snapshot);

		// The shared-line half. Last, and deliberately after the far end already has its music: a line
		// whose lamp did not update is a worse shared line, and a caller in silence is a worse call.
		// `aggregate` is the APPEARANCE that pressed the key; `onSharedLineHold` is a no-op for the
		// overwhelming majority of holds, which are not on a shared line at all.
		await this.control.onSharedLineHold(this.controlledLeg(aggregate), held);
	}

	/**
	 * The music-on-hold class for a hold, off whichever of the two legs the walk labelled.
	 *
	 * The HOLDER's leg first: on an inbound call it is the B-leg the walk originated for the
	 * extension node, and that node is the one carrying the tenant's class. The held peer is the
	 * fallback for the mirror-image case — the caller pressing hold on a call they placed — and
	 * `undefined` means the compiler resolved no class, which the media port reads as its default.
	 */
	private mohClassFor(
		holder: ChannelAggregate,
		peer: ChannelAggregate | undefined,
	): string | undefined {
		return (
			holder.snapshot.variables[MOH_CLASS_VARIABLE] ?? peer?.snapshot.variables[MOH_CLASS_VARIABLE]
		);
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
		this.originatedCallers.delete(mediaChannelId);
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
		this.disarmSetupDeadline(mediaChannelId);

		// A remote BYE terminates SIP but does not release the independently owned media session.
		// Release it even when there is no aggregate; successful release also drops local leg state.
		if (this.media instanceof SplitPlaneMediaPort) {
			try {
				await this.media.releaseEndedLeg(mediaChannelId);
			} catch (error) {
				this.logger.warn(
					{ mediaChannelId, err: String(error) },
					"could not release media for an ended SIP leg",
				);
			}
		}

		const aggregate = this.registry.byAriChannelId(mediaChannelId);
		if (aggregate === undefined) {
			return;
		}
		// Releases the walk an application has been holding, and does it BEFORE the state checks
		// below so that a leg reaped in any state frees its session. An application whose caller hung
		// up finds out from the call events on its socket; what this guarantees is that the ENGINE
		// stops holding a promise for a channel that no longer exists.
		this.sessions.legEnded(aggregate.channelId);
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

		// Read ONCE, and copied, so every check below is against the same view. Mixing this binding
		// with fresh `aggregate.snapshot.variables` reads part-way through a run of `setVariable`
		// calls is two views of one map in one function, and only the disjointness of the keys made
		// it correct.
		const variables = { ...aggregate.snapshot.variables };
		const hasTerminalEventIds =
			variables[TERMINAL_HANGUP_EVENT_ID_VARIABLE] !== undefined ||
			variables[TERMINAL_DESTROYED_EVENT_ID_VARIABLE] !== undefined;
		// Reporting snapshots written before terminal event recovery was introduced can only have
		// reached this state after publishing both events. Preserve that shipped behavior rather than
		// replaying them once with newly invented IDs during an upgrade.
		//
		// TODO(2026-03): a migration shim, not a rule. No snapshot predating terminal-event recovery
		// can survive a call's lifetime, so once every deployment has been through one restart on a
		// build that carries the IDs, delete this branch — it marks the terminal events published
		// without ever publishing them, which is a lie a future reader cannot detect from here.
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
		if (variables[CDR_ID_VARIABLE] === undefined) {
			aggregate.setVariable(CDR_ID_VARIABLE, aggregate.channelId);
		}
		if (variables[CDR_EVENT_ID_VARIABLE] === undefined) {
			aggregate.setVariable(CDR_EVENT_ID_VARIABLE, createEntityId());
		}
		if (variables[CDR_HANGUP_CAUSE_CODE_VARIABLE] === undefined) {
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
		// A shared line this leg was on is freed here, at the one point every ending call passes
		// through, rather than on each of the several paths that can end one. A no-op for every leg
		// that is not the party a shared line was seized for.
		await this.control.releaseSharedLine(
			aggregate.organizationId,
			aggregate.callId,
			aggregate.channelId,
		);
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
		// The cause that WON, not the one just offered: `markHangup` is first-wins, so a peer whose
		// cause was already fixed — a plane-loss teardown's `NORMAL_TEMPORARY_FAILURE`, a duration
		// ceiling's `ALLOTTED_TIMEOUT` — must put that on the wire too. Sending 16 while the CDR says
		// 41 tells the far end's carrier a crashed call was a normal hang-up.
		await this.hangupQuietly(peer.ariChannelId, peer.hangupCause ?? "NORMAL_CLEARING");
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
		if (destination.mohClass !== undefined) {
			aggregate.setVariable(MOH_CLASS_VARIABLE, destination.mohClass);
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
	 * Mirrors a queue's verdict onto the leg, so the CDR carries it whichever path writes the row.
	 *
	 * The same shape as {@link recordDestination}, including the teardown guard: the variables are
	 * set either way — an in-flight CDR reads them from the snapshot — but the bucket must not be
	 * written for a leg whose entry the teardown has already deleted, or the mirror keeps a live
	 * channel for a call that is over.
	 */
	private async recordQueueOutcome(
		aggregate: ChannelAggregate,
		outcome: WalkerQueueOutcome,
	): Promise<void> {
		aggregate.setVariable(QUEUE_REF_VARIABLE, outcome.queueId);
		aggregate.setVariable(QUEUE_WAIT_MS_VARIABLE, String(outcome.waitMs));
		aggregate.setVariable(QUEUE_OUTCOME_VARIABLE, outcome.outcome);
		if (outcome.agentId !== undefined) {
			aggregate.setVariable(QUEUE_AGENT_REF_VARIABLE, outcome.agentId);
		}
		if (aggregate.isTearingDown) {
			return;
		}
		await this.jetstream.putChannel(aggregate.snapshot);
	}

	/**
	 * Records which authorisation code paid for a gated outbound call.
	 *
	 * Written the moment the code is accepted and BEFORE the first trunk is offered, on exactly the
	 * terms {@link recordDestination} sets out: the dial that follows may end in any number of ways,
	 * and the CDR must already know who authorised it whichever of teardown and the walk's return
	 * writes the row.
	 *
	 * The label is only mirrored when the set gave the entry one. An empty variable and an absent one
	 * would be the same row, but they are not the same snapshot, and `authorizationOf` reads both
	 * back as "no label" — writing the empty string would put a key in the bucket that means nothing.
	 */
	private async recordPinAuthorization(
		aggregate: ChannelAggregate,
		authorization: PinAuthorization,
	): Promise<void> {
		aggregate.setVariable(AUTH_PIN_ORDINAL_VARIABLE, String(authorization.ordinal));
		if (authorization.label !== undefined && authorization.label !== "") {
			aggregate.setVariable(AUTH_PIN_LABEL_VARIABLE, authorization.label);
		}
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
			const sipCallId = normalizeSipCallId(aggregate.snapshot.variables[SIP_CALL_ID_VARIABLE]);
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
				...queueLegOf(aggregate.snapshot.variables),
				...authorizationOf(aggregate.snapshot.variables),
				...attestationOf(aggregate.snapshot.variables),
				// The carrier's `Call-ID` for this leg's dialog. Off the variable and not the dialog
				// registry, so an adopted leg files the same value the original instance would have.
				...(sipCallId === undefined ? {} : { sipCallId }),
				// Off the channel variable rather than off the aggregate, so it survives the snapshot an
				// instance reads after a failover — the same rule every other CDR identity here follows.
				...(aggregate.snapshot.variables[CDR_RELATED_CALL_ID_VARIABLE] === undefined
					? {}
					: { relatedCallId: aggregate.snapshot.variables[CDR_RELATED_CALL_ID_VARIABLE] }),
			});
			let envelope: ReturnType<typeof makeCdrLegWriteEvent>;
			try {
				envelope = makeCdrLegWriteEvent({
					id: aggregate.snapshot.variables[CDR_EVENT_ID_VARIABLE],
					at: new Date(input.endedAt),
					orgId: aggregate.organizationId,
					source: "engine",
					data,
				});
				validateEvent(envelope.subject, envelope);
			} catch (invalid) {
				// PERMANENT, and told apart from a publish failure for that reason. A payload its own
				// schema rejects will be rejected identically by every redelivery and by every
				// replacement process, so the retry loop below can only spin: two legs carrying a
				// synthetic `feature-code:<kind>:<uuid>` destination held `activeChannels: 2` across a
				// restart and wrote 483 identical error lines. The row is dropped and the leg is
				// released — a lost CDR is a reporting hole, a leg nothing can free is a call the
				// platform believes is still up.
				this.logger.error(
					{
						channelId: aggregate.channelId,
						callId: aggregate.callId,
						destinationType,
						destinationRef,
						err: String(invalid),
					},
					"dropping an unwritable CDR for a finished leg; the payload fails its own contract and no retry can fix it",
				);
				return true;
			}
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
	// Plane loss
	// -------------------------------------------------------------------------------------------

	/**
	 * Ends every leg whose plane went away, with a cause, a CDR and a BYE where one can still be sent.
	 *
	 * ## Why this exists at all
	 *
	 * The split plane made each half of a call independently mortal, and it made exactly one of the
	 * two failures silent. A `mediad` crash is loud — the relay stops and both parties hear nothing —
	 * but the engine's own hangup path went THROUGH `mediad`, so the one process that could end the
	 * call could not. A `sipd` crash is worse: the media keeps flowing perfectly, the engine is told
	 * nothing at all, and the phone's BYE is answered `481` by whatever replaced the dead process.
	 * Both leave a live billing leg that nobody on the platform can end. Neither is a leak to be
	 * cleaned up later; both are calls that must be ENDED, now, and recorded as ended.
	 *
	 * ## Why `NORMAL_TEMPORARY_FAILURE`
	 *
	 * Q.850 41, which is the same cause `apps/sipd`'s own claim reaper publishes for the same event,
	 * and the same one the drain uses for a straggler — "the platform ended this call and it may be
	 * retried". It is not `NORMAL_CLEARING`: filing a crash as a hang-up makes an availability
	 * incident invisible in the CDR, which is precisely the question somebody asks afterwards. The
	 * taxonomy has no code for "the media owner vanished", and inventing one would be a schema
	 * change on the billing boundary to say something 41 already says; the REASON travels in the log
	 * line and in the event, where an operator reads it.
	 *
	 * ## Ordering
	 *
	 * The cause is fixed on the aggregate FIRST, because `markHangup` is first-wins and a late event
	 * from a plane that is coming back must not relabel a call the engine ended. Then the BYE, but
	 * only towards a plane that can still carry one — signalling at a dead `sipd` would be addressed
	 * at a process that never had the call and would cost a full RPC timeout per leg. Then
	 * {@link onLegEnded}, explicitly rather than by waiting for an event: the whole point is that the
	 * plane which would have reported it is gone.
	 */
	async endLegsOnPlaneLoss(loss: PlaneLoss): Promise<number> {
		if (this.draining) {
			// The drain is already hanging these legs up with a cause of its own, and both paths
			// calling `onLegEnded` for one leg would race over which cause the CDR keeps.
			return 0;
		}
		const port = this.media instanceof SplitPlaneMediaPort ? this.media : undefined;
		const affected = this.channelsAffectedBy(loss, port);
		if (affected.length === 0) {
			this.logger.info(
				{ plane: loss.plane, instanceId: loss.instanceId },
				"a plane was lost while this instance held no legs on it",
			);
			return 0;
		}

		this.logger.error(
			{
				plane: loss.plane,
				instanceId: loss.instanceId,
				reason: loss.reason,
				count: affected.length,
			},
			"ending every leg on a plane that is gone",
		);
		if (loss.plane === "media") {
			// Before the first teardown, so no leg pays the release timeout for a relay that is gone.
			port?.setMediaPlaneLost(true);
		}

		// Every cause fixed BEFORE the first teardown, not per leg inside the loop. `markHangup` is
		// first-wins, and ending the A-leg runs `endBridgePeer`, which hangs its bridged partner up
		// with `NORMAL_CLEARING` — so a per-leg mark would reach the B-leg too late and file half of
		// a crashed call as a normal hang-up. Proved live: the B-leg's CDR came back
		// `NORMAL_CLEARING` against a cause code of 41.
		const at = Date.now();
		for (const mediaChannelId of affected) {
			const aggregate = this.registry.byAriChannelId(mediaChannelId);
			aggregate?.markHangup({ cause: PLANE_LOSS_HANGUP_CAUSE, at, initiatedByEngine: true });
			// The numeric code too, and OVERWRITING whatever a dial or a bridge stamped earlier.
			// `finishReporting` keeps a code once written, for retry stability, and the CDR takes its
			// NAME from `markHangup` — so a leg that already carried a 16 would be filed as
			// `NORMAL_TEMPORARY_FAILURE` with a cause code of 16, which is a billing row that
			// contradicts itself. Seen live on the B-leg of a bridged pair. The loss is the terminal
			// decision and postdates anything stamped before it.
			aggregate?.setVariable(
				CDR_HANGUP_CAUSE_CODE_VARIABLE,
				String(hangupCauseCode(PLANE_LOSS_HANGUP_CAUSE)),
			);
			if (loss.plane === "signalling") {
				// Dropped from the composite BEFORE any teardown runs, not inside the loop. There is
				// nobody to send a BYE to, and every command addressed at the dead instance costs the
				// full RPC timeout — including the one `endBridgePeer` issues from inside another
				// leg's teardown, which is how a 500 ms wait on a dead edge appeared in the live log.
				// The media session is still released: `releaseEndedLeg` keys on the channel id.
				port?.forget(mediaChannelId);
			}
		}

		let ended = 0;
		for (const mediaChannelId of affected) {
			if (loss.plane === "media") {
				// `sipd` is alive: this is the BYE that tells both parties the call is over, and it is
				// the half that was impossible while the hangup path needed `mediad`.
				await this.hangupQuietly(mediaChannelId, PLANE_LOSS_HANGUP_CAUSE);
			}
			try {
				await this.onLegEnded(
					mediaChannelId,
					PLANE_LOSS_HANGUP_CAUSE,
					hangupCauseCode(PLANE_LOSS_HANGUP_CAUSE),
				);
				ended += 1;
			} catch (error) {
				this.logger.error(
					{ mediaChannelId, plane: loss.plane, err: String(error) },
					"could not finish ending a leg whose plane was lost",
				);
			}
		}
		this.logger.warn(
			{ plane: loss.plane, instanceId: loss.instanceId, ended, affected: affected.length },
			"finished ending the legs on a lost plane",
		);
		return ended;
	}

	/**
	 * The legs one plane loss took with it.
	 *
	 * A media loss is total: the reachability probe is queue-grouped, so "no reply" means no `mediad`
	 * in the fleet answered and every session this engine holds is dead. A signalling loss is
	 * per-instance, and is read from BOTH the composite port's own record of which instance holds
	 * which dialog and the leg variable the arrival stamped — the port forgets a leg on teardown and
	 * the variable survives into the `channels` snapshot, so neither is complete on its own.
	 */
	private channelsAffectedBy(
		loss: PlaneLoss,
		port: SplitPlaneMediaPort | undefined,
	): readonly string[] {
		if (loss.plane === "media") {
			return this.registry.all.map((aggregate) => aggregate.ariChannelId);
		}
		const affected = new Set<string>(port?.legsForInstance(loss.instanceId) ?? []);
		for (const aggregate of this.registry.all) {
			if (aggregate.snapshot.variables[SIPD_INSTANCE_ID_VARIABLE] === loss.instanceId) {
				affected.add(aggregate.ariChannelId);
			}
		}
		return [...affected];
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
		for (const timer of this.setupDeadlines.values()) {
			clearTimeout(timer);
		}
		this.setupDeadlines.clear();
		this.adoptedPendingReconcile.clear();
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

	/**
	 * Arms the setup cut-off for a leg that has just been admitted.
	 *
	 * ## The invariant this exists to make true
	 *
	 * **Every admitted leg is covered by a timer.** `armCallDurationCeiling` covers the ANSWERED
	 * ones; before this, nothing covered the rest. A routing walk is an unbounded await — a dial
	 * waiting on a signal, a queue session waiting on an agent — and a walk that hangs left a leg in
	 * `activeChannels` with no CDR, no final response and no clock, until the four-hour maximum-call
	 * ceiling that had never been armed for it. Measured under load at 2 walks in 200: the caller's
	 * INVITE simply ended with nothing.
	 *
	 * ## Why it cannot cut a legitimate call
	 *
	 * It is disarmed by the FIRST call-state progression — `ringing`, progress, or an answer — which
	 * every real destination produces within milliseconds. A queue caller has been sent `180` (and
	 * usually answered for hold music) long before this fires; so has an IVR, a ring group and a
	 * voicemail box. What survives to this deadline is a leg nothing is driving.
	 *
	 * ## Why `NO_USER_RESPONSE`
	 *
	 * The taxonomy's 18 is exactly this fact and no other: the call was placed and nothing answered
	 * it, provisionally or otherwise. `NORMAL_TEMPORARY_FAILURE` would say the platform refused a
	 * call it in fact accepted and then lost, and the CDR is the only artefact anyone has afterwards.
	 */
	private armSetupDeadline(aggregate: ChannelAggregate): void {
		const seconds = this.env.ENGINE_SETUP_TIMEOUT_SECONDS;
		if (!Number.isFinite(seconds) || seconds <= 0) {
			return;
		}
		const mediaChannelId = aggregate.ariChannelId;
		this.disarmSetupDeadline(mediaChannelId);

		const timer = setTimeout(() => {
			this.setupDeadlines.delete(mediaChannelId);
			const live = this.registry.byAriChannelId(mediaChannelId);
			if (live === undefined || live.isTearingDown || live.isAnswered) {
				return;
			}
			this.logger.warn(
				{ channelId: live.channelId, callId: live.callId, seconds, state: live.state },
				"an admitted leg produced no response inside the setup deadline; the engine is ending " +
					"it. This is a hung routing walk: the caller heard nothing and has already given up.",
			);
			// Fixed before the hangup, for the reason the duration ceiling fixes its own: `markHangup`
			// is first-wins and the CDR must say the platform cut this, not that it cleared normally.
			live.markHangup({ cause: "NO_USER_RESPONSE", at: Date.now(), initiatedByEngine: true });
			void this.endStalledLeg(mediaChannelId);
		}, seconds * 1_000);
		timer.unref?.();
		this.setupDeadlines.set(mediaChannelId, timer);
	}

	/** Drops a leg's setup cut-off. Unarmed legs cost one map lookup. */
	private disarmSetupDeadline(mediaChannelId: string): void {
		const timer = this.setupDeadlines.get(mediaChannelId);
		if (timer === undefined) {
			return;
		}
		clearTimeout(timer);
		this.setupDeadlines.delete(mediaChannelId);
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

	/**
	 * The organization's simultaneous-call ceiling, enforced at the door.
	 *
	 * ## Why here and not at the trunk
	 *
	 * `TrunkAttempt.maxChannels` already caps what one CARRIER will accept, and it is enforced in
	 * the plan walker where the INVITE is about to go out. This is a different quota with a
	 * different meaning: `org_limit.max_concurrent_calls` is what the tenant has BOUGHT, so it has
	 * to count internal extension-to-extension calls, conference legs and queue callers — none of
	 * which reach a trunk. Enforcing it at `trunkDialNode` would let an organization with a ceiling
	 * of ten hold two hundred internal calls and be refused only on the two hundred and first
	 * outbound one.
	 *
	 * ## Why at THIS point in admission
	 *
	 * After the organization is resolved, because there is no quota to check without one. Before
	 * `claimChannel`, and that ordering is the load-bearing half: a refused call must not take a KV
	 * ownership claim it will never release, must not publish `channel.created` for a call that
	 * never existed, and must not enter the registry it is being refused for being too full. Every
	 * one of those would make the refusal itself consume a slot.
	 *
	 * ## The count, and how nearly right it is
	 *
	 * `ChannelRegistry.liveCountFor` counts THIS REPLICA's legs. The limitation is stated on that
	 * method and is the same one `trunk-capacity.ts` accepts for the per-trunk ceiling: with N
	 * engines the effective ceiling is N times the configured one. It is wrong by a known factor and
	 * never in the dangerous direction — it can admit a call it should have refused, never the
	 * reverse — and for the single-instance deployment this repo ships it is exact.
	 *
	 * The comparison is `>=` for the reason `assertWithinLimit` uses it in the API: the count is
	 * taken BEFORE this leg is added, so at ten of ten this one would be the eleventh.
	 *
	 * ## The cause, and the absence of an announcement
	 *
	 * `SWITCH_CONGESTION`, which is what the per-trunk ceiling refuses with and what a carrier and a
	 * report both read as "full, try again". Not `NORMAL_TEMPORARY_FAILURE`, which the drain uses
	 * and which invites the carrier to fail the call over to another instance — that is exactly
	 * wrong here, because every other instance is subject to the same quota and would refuse it too.
	 *
	 * No announcement, unlike a refusal inside the plan walker. The leg has not been answered; to
	 * announce we would have to answer it, and answering a call in order to tell the caller we are
	 * not taking it bills the tenant for the refusal and makes it a connected call in their own CDR.
	 * A cause on an unanswered leg is what congestion is supposed to look like.
	 *
	 * Returns `true` when the call may proceed. A missing or unreadable artifact admits: a quota
	 * this process could not read must not become an outage.
	 */
	private async admitWithinConcurrencyCeiling(
		channel: MediaChannelSnapshot,
		organizationId: string,
	): Promise<boolean> {
		if (await this.isWithinConcurrencyCeiling(organizationId)) {
			return true;
		}
		this.logger.info(
			{ ariChannelId: channel.id, organizationId },
			"rejecting a new call: the organization is at its simultaneous-call ceiling",
		);
		await this.hangupQuietly(channel.id, "SWITCH_CONGESTION");
		return false;
	}

	/**
	 * The quota question on its own, with no channel and no teardown.
	 *
	 * Split out of {@link admitWithinConcurrencyCeiling} for the SIP edge's admission RPC, which must
	 * answer the SAME question BEFORE any leg exists: a call arriving there is refused with a reason
	 * that becomes a `503`, and hanging up a channel that has not been created — which is what the
	 * combined version would try to do — is both impossible and the wrong shape. Two callers, one
	 * predicate, so a tenant's ceiling can never come to mean two different things on two planes.
	 */
	private async isWithinConcurrencyCeiling(organizationId: string): Promise<boolean> {
		const artifact = await this.routing.get(organizationId).catch((error: unknown) => {
			this.logger.warn(
				{ organizationId, err: String(error) },
				"could not read the routing artifact to check the concurrent-call ceiling; admitting",
			);
			return undefined;
		});
		const ceiling = artifact?.settings.maxConcurrentCalls;
		if (ceiling === undefined) {
			return true;
		}
		// `<` and not `<=`, for the reason `assertWithinLimit` uses in the API: the count is taken
		// BEFORE this leg is added, so at ten of ten this one would be the eleventh.
		return this.registry.liveCountFor(organizationId) < ceiling;
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
	 * The names are {@link ARRIVAL_VARIABLES} and nothing else, because that array is also what
	 * `invitedChannelSnapshot` stamps — the two lists were maintained separately once and four
	 * stamped variables were dropped here for it.
	 *
	 * Most are stored under the name they are read by. The SIP `Call-ID` is not: it is READ from a
	 * dialplan function and STORED under an `OPTIMIQ_` name, because a variable is what survives into
	 * the KV snapshot and what a dialplan can pre-stamp, while the function is what the media server
	 * actually answers. Hence {@link ARRIVAL_VARIABLE_READS} being a map rather than a flag.
	 *
	 * ## Most entries have no `read`, and that is the whole distinction
	 *
	 * The variables the SIP edge stamps — which instance holds the dialog, which leg an authorised
	 * `Replaces` is taking over, the registered device, the carrier's attestation — exist on NO media
	 * server. There is nothing to ask: `MediadMediaPort` refuses `getVariable` outright and Asterisk
	 * has never heard of them. An entry with no `read` is therefore inline-or-absent, which saves a
	 * round trip per call per variable on the ARI plane and, more importantly, says what is true:
	 * these are facts the ARRIVAL carried, not facts a media server holds. Whatever this method
	 * returns is what lands on the aggregate and in the `channels` bucket, so a variable that is not
	 * read here is a variable a failover cannot recover.
	 */
	private async readEngineVariables(
		channel: MediaChannelSnapshot,
	): Promise<Record<string, string | undefined>> {
		const fromEvent = channel.variables;
		const entries = await Promise.all(
			ARRIVAL_VARIABLES.map(async (variable) => {
				const read: string | undefined = ARRIVAL_VARIABLE_READS[variable];
				// The event's variables are only populated when the media server is configured to
				// export them with every event, so they are an optimisation, never the truth.
				const inline = fromEvent[variable] ?? (read === undefined ? undefined : fromEvent[read]);
				if (inline !== undefined && inline !== "") {
					return [variable, inline] as const;
				}
				if (read === undefined) {
					return [variable, undefined] as const;
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
		await this.recordSipDialogFor(aggregate, channel.variables);
	}

	/**
	 * The same, for a leg whose event carried no snapshot.
	 *
	 * The split plane's B-leg reaches the registry through `legHooksFor(…).originated`, which runs
	 * BEFORE the INVITE goes out and therefore before anything knows the dialog's `Call-ID`. The
	 * first moment that value exists on this side is the originate reply, which
	 * {@link SplitPlaneMediaPort.originate} stamps as {@link SIP_CALL_ID_VARIABLE}; the first moment
	 * the engine is called again for that leg is its `18x` or its `200`. So the dialog is filed from
	 * the state change, which is why a `dialog.progressed` on a leg with no Call-ID yet reads one.
	 */
	private async recordSipDialogFor(
		aggregate: ChannelAggregate,
		inlineVariables: Readonly<Record<string, string>> = {},
	): Promise<void> {
		const sipCallId = await this.readSipCallId(aggregate.ariChannelId, inlineVariables);
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
	private async readSipCallId(
		mediaChannelId: string,
		variables: Readonly<Record<string, string>>,
	): Promise<string | undefined> {
		const inline = normalizeSipCallId(
			variables[SIP_CALL_ID_VARIABLE] ?? variables[SIP_CALL_ID_CHANNEL_FUNCTION],
		);
		if (inline !== undefined) {
			return inline;
		}
		// The VARIABLE before the channel function, because only one of the two exists per plane and
		// asking in the other order costs a split-plane B-leg its dialog. `SplitPlaneMediaPort` stamps
		// the originate reply's `Call-ID` here (it has no PJSIP session to ask), while Asterisk answers
		// `CHANNEL(pjsip,call-id)` and has nothing under this name. Both reads are local or one round
		// trip, and the first defined answer wins.
		for (const name of [SIP_CALL_ID_VARIABLE, SIP_CALL_ID_CHANNEL_FUNCTION]) {
			try {
				const value = normalizeSipCallId(await this.media.getVariable(mediaChannelId, name));
				if (value !== undefined) {
					return value;
				}
			} catch {
				// A media server that refuses the read is a leg with no readable dialog, which is the
				// documented outcome of this whole function. Try the other name before giving up.
			}
		}
		return undefined;
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
	 * On the native plane the engine claims the A-leg before origination and starts its routing
	 * walk only after the caller's SDP answer has settled. ARI supplies that arrival from Stasis.
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
		if (this.env.ENGINE_MEDIA_DRIVER !== "ari" && !(this.media instanceof SplitPlaneMediaPort)) {
			// Native origination requires the composite that joins SIP signalling and media.
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
		const native = this.media instanceof SplitPlaneMediaPort;
		const realm = artifact.settings.realm;
		if (native && !realm) {
			return { kind: "refused", reason: "internal", error: "the organization has no SIP realm" };
		}
		try {
			if (native) {
				await this.onLegArrived(
					{
						id: request.originateId,
						name: `sipd/${request.fromExtension}`,
						callerNumber: request.fromExtension,
						dialedNumber: request.to,
						context: "internal",
						variables: {
							OPTIMIQ_ORG_ID: request.orgId,
							OPTIMIQ_CALL_DIRECTION: "internal",
							OPTIMIQ_ROUTING_CONTEXT: "internal",
							OPTIMIQ_DIALED_NUMBER: request.to,
							OPTIMIQ_LEG: "a",
						},
					},
					(aggregate) => {
						(this.media as SplitPlaneMediaPort).registerOutboundLeg(request.originateId, {
							orgId: request.orgId,
							callId: aggregate.callId,
						});
					},
					true,
				);
				if (this.registry.byAriChannelId(request.originateId) === undefined) {
					return { kind: "refused", reason: "internal", error: "could not claim the caller leg" };
				}
			}
			await this.media.originate({
				endpoint: plan.endpoint,
				...(native
					? { target: { kind: "aor" as const, aor: `sip:${request.fromExtension}@${realm}` } }
					: {}),
				application: this.env.ARI_APP,
				channelId: request.originateId,
				...(callerIdNumber === undefined
					? {}
					: {
							callerId:
								callerId === callerIdNumber ? callerIdNumber : `"${callerId}" <${callerIdNumber}>`,
						}),
				...(plan.callerIdPresentation === undefined
					? {}
					: { callerIdPresentation: plan.callerIdPresentation }),
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
			if (native) await this.onLegEnded(request.originateId, "USER_NOT_REGISTERED", 20);
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
			legId: this.domainLegId(request.originateId),
			endpoint: plan.endpoint,
		};
	}

	/**
	 * Rings a customer back on behalf of a queue.
	 *
	 * ## Why this is not `placeOriginatedCall` with different arguments
	 *
	 * Click-to-call is an EXTENSION placing a call: it originates towards that extension's own handset
	 * and the person picks up their own phone. A callback has no extension and no handset — the leg it
	 * creates goes OUT, to a customer, and the queue is what it presents. The two share a media
	 * originate and nothing above it, which is why `planQueueCallback` resolves outbound only and why
	 * the subject is its own.
	 *
	 * ## The answered leg walks to the queue, rather than being handed an agent
	 *
	 * `OPTIMIQ_DIALED_NUMBER` is the QUEUE's number, so once the customer answers, the ordinary walk
	 * takes them into the ordinary queue node and the ordinary distribution loop reaches the ordinary
	 * agent. There is no second "connect the agent" path here, and inventing one would be a second
	 * ACD that had to be kept in step with the first.
	 *
	 * ## `relatedCallId` travels on the leg, not on this reply
	 *
	 * A callback is a NEW `call_id` — it happens minutes later, with its own answer, its own trunk and
	 * its own billing, and reusing the queued call's id would make every duration in the ledger a sum
	 * over time the customer was not on the phone. The link is a channel variable so it survives onto
	 * the leg's CDR write, which is the only row that can carry it.
	 */
	private async placeQueueCallbackCall(
		request: QueueCallbackRpcRequest,
	): Promise<OriginatePlacement> {
		const existing = this.registry.byAriChannelId(request.callbackId);
		if (existing !== undefined) {
			// The retry path, on the same terms click-to-call's is: the caller asked for a call to
			// exist and it does. A second originate here would ring the customer twice.
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

		const artifact = await this.routing.get(request.orgId);
		if (artifact === undefined) {
			return {
				kind: "refused",
				reason: "internal",
				error: `no routing artifact for organization ${request.orgId}`,
			};
		}

		const plan = planQueueCallback(artifact, {
			to: request.to,
			...(request.queueNumber === undefined ? {} : { queueNumber: request.queueNumber }),
			...(request.callerIdNumber === undefined ? {} : { callerIdNumber: request.callerIdNumber }),
			...(request.callerIdName === undefined ? {} : { callerIdName: request.callerIdName }),
			now: new Date(),
		});
		if (!plan.ok) {
			return { kind: "refused", reason: plan.reason, error: plan.error };
		}

		// The trunk the matched outbound route selected. `planQueueCallback` answers WHICH NUMBER to
		// dial and which route matched; turning that into an endpoint is this class's, because the
		// dial template is deployment configuration rather than artifact.
		//
		// KNOWN LIMIT, stated rather than hidden: this takes the route's FIRST attempt. Trunk chains,
		// capacity ceilings and `continueOnCauses` failover are the plan walker's, and they need an
		// A-leg to fail over on — a callback has none until the customer answers. A tenant whose first
		// trunk is down gets a deferred callback attempt (which the runner retries) rather than an
		// automatic hop to the second carrier.
		// An INTERNAL callback is dialled as an AOR at the tenant's realm, exactly as the walker dials
		// an extension. The party who waited in the queue was very often an extension, and the
		// trunk-only branch below refused every one of them — a queue that promised a callback to a
		// colleague could never make it.
		const onNet = plan.context === "internal";
		const realm = artifact.settings.realm;
		if (onNet && (realm === undefined || realm === "")) {
			return {
				kind: "refused",
				reason: "internal",
				error: "the organization has no SIP realm to dial an internal callback at",
			};
		}
		const node = plan.planNodeId === undefined ? undefined : artifact.nodes[plan.planNodeId];
		const attempt =
			!onNet && node?.kind === "trunk-dial"
				? [...node.attempts].sort((left, right) => left.order - right.order)[0]
				: undefined;
		if (!onNet && attempt === undefined) {
			return {
				kind: "refused",
				reason: "invalid_target",
				error: `the route matching ${request.to} names no trunk to dial it on`,
			};
		}
		const endpoint = onNet
			? this.env.ENGINE_EXTENSION_DIAL_TEMPLATE.replaceAll("{number}", plan.destination)
			: this.env.ENGINE_TRUNK_DIAL_TEMPLATE.replaceAll("{number}", plan.destination).replaceAll(
					"{trunk}",
					attempt?.name ?? "",
				);

		const callerId = plan.callerIdName ?? plan.callerIdNumber;
		// Where the answered customer is walked to. The queue's number when it has one; its id
		// otherwise, which the walk resolves the same way a dialled number would.
		const dialed = request.queueNumber ?? request.queueId;
		const variables = {
			OPTIMIQ_ORG_ID: request.orgId,
			// The direction the leg actually took: `outbound` over a trunk, `internal` when the
			// party who waited was one of this tenant's own extensions. Calling an on-net
			// callback `outbound` would bill an internal call as a carrier minute.
			OPTIMIQ_CALL_DIRECTION: onNet ? "internal" : "outbound",
			OPTIMIQ_ROUTING_CONTEXT: "internal",
			OPTIMIQ_DIALED_NUMBER: dialed,
			...(request.relatedCallId === undefined
				? {}
				: { [CDR_RELATED_CALL_ID_VARIABLE]: request.relatedCallId }),
		};
		const native = this.media instanceof SplitPlaneMediaPort;
		try {
			if (native) {
				// The split plane refuses to originate on a leg it does not hold — `require("originate",
				// …)` throws "the leg is not registered" — so the leg is filed here exactly as
				// click-to-call files its own. Without it every callback was refused `extension_offline`
				// for a customer who was perfectly reachable.
				await this.onLegArrived(
					{
						id: request.callbackId,
						name: endpoint,
						...(plan.callerIdNumber === undefined ? {} : { callerNumber: plan.callerIdNumber }),
						dialedNumber: dialed,
						context: "internal",
						variables: { ...variables, OPTIMIQ_LEG: "a" },
					},
					(aggregate) => {
						(this.media as SplitPlaneMediaPort).registerOutboundLeg(request.callbackId, {
							orgId: request.orgId,
							callId: aggregate.callId,
						});
					},
					true,
				);
				if (this.registry.byAriChannelId(request.callbackId) === undefined) {
					return {
						kind: "refused",
						reason: "internal",
						error: "could not claim the callback leg",
					};
				}
			}
			await this.media.originate({
				endpoint,
				// The structured target for the SIP edge, exactly as the walker builds it: an AOR at the
				// tenant's realm on net, the trunk row's id plus the number off it. The Asterisk plane
				// ignores it and dials `endpoint`.
				target: onNet
					? { kind: "aor", aor: `sip:${plan.destination}@${realm ?? ""}` }
					: { kind: "trunk", trunkId: attempt?.trunkId ?? "", number: plan.destination },
				application: this.env.ARI_APP,
				channelId: request.callbackId,
				...(plan.callerIdNumber === undefined
					? {}
					: {
							callerId:
								callerId === plan.callerIdNumber
									? plan.callerIdNumber
									: `"${callerId ?? ""}" <${plan.callerIdNumber}>`,
						}),
				...(request.ringTimeoutSeconds === undefined
					? {}
					: { timeoutSeconds: request.ringTimeoutSeconds }),
				variables,
			});
		} catch (error) {
			this.logger.info(
				{
					callbackId: request.callbackId,
					orgId: request.orgId,
					queueId: request.queueId,
					endpoint,
					err: String(error),
				},
				"could not originate a queue callback towards the customer",
			);
			// `extension_offline` is the contract's "the far end could not be reached at all", which is
			// what an unroutable trunk presents as. The runner reads any refusal as one spent attempt.
			return {
				kind: "refused",
				reason: "extension_offline",
				error: `could not reach ${request.to}: ${String(error)}`,
			};
		}

		return {
			kind: "placed",
			callId: callIdForAriChannel(request.callbackId),
			legId: this.domainLegId(request.callbackId),
			endpoint,
		};
	}

	// -------------------------------------------------------------------------------------------
	// The SIP edge's admission path
	// -------------------------------------------------------------------------------------------

	/**
	 * Admits a call arriving on `apps/sipd`, and files it as an ORDINARY A-leg.
	 *
	 * ## The seam, and why it is the same one click-to-call uses
	 *
	 * The whole value of this path is that there is no second one. The leg is filed through
	 * {@link onLegArrived}, which means it gets `attributeCall`'s ladder, the concurrency ceiling, the
	 * `channels` KV claim, `channel.created`, the registry, the routing walk, the plan walker, the
	 * teardown and the CDR — all of it the same code an Asterisk call runs. `plans/sipd-invite-design.md`
	 * §7.1 states the requirement in one sentence: "above the seam, the engine cannot tell the
	 * difference and must not try". A dedicated `admitSipCall` that published its own events and drove
	 * its own state machine would have been quicker to write and would have made every later feature —
	 * follow-me, queues, park, call blocking, time conditions — a thing that works on one plane.
	 *
	 * So this method's entire job is to turn an admission REQUEST into a {@link MediaChannelSnapshot}
	 * that the arrival path already knows how to read, and to answer the questions the arrival path
	 * cannot answer with a REASON rather than by hanging a channel up. A refused INVITE has no channel
	 * to hang up: the reply IS the refusal, and the edge turns it into a SIP status a stranger sees.
	 *
	 * ## The identity decision, stated because it is subtle
	 *
	 * The edge minted `legId` before it asked, for the same reason `mediaAllocateSessionRequestSchema`
	 * makes session ids caller-assigned: the engine must be able to hang up a leg whose admission
	 * reply it never saw. That string becomes the engine's MEDIA CHANNEL ID — the key every registry,
	 * signal, claim and KV entry is keyed by — exactly as `originateId` does for a click-to-call. The
	 * native leg ID is preserved across signalling, media, events and CDRs. Only the call ID is
	 * deterministically derived from the root leg. Asterisk channels retain their separate UUID
	 * mapping because their channel IDs are not necessarily UUIDs.
	 *
	 * ## Idempotency
	 *
	 * On the client-assigned `legId`, exactly as the click-to-call path is on `originateId`. A retry of
	 * an admission whose reply was lost finds a leg this instance is already tracking and is answered
	 * with the ids of the call it already admitted. Without it, a one-second deadline against a busy
	 * engine would file one INVITE as two calls, with two CDR rows and two routing walks racing to
	 * dial the same extension.
	 *
	 * ## The driver gate, which is the cutover gate
	 *
	 * A leg admitted here takes its media from `mediad`: the composite `MediaPort` of §3.2 answers a
	 * SIP INVITE by handing the offer to `rpc.media.v1.allocate-session` and putting the SDP that comes
	 * back into `rpc.sip.v1.answer`. Asterisk cannot serve such a call at all — `apps/sipd` holds no
	 * ARI credential, and there is no Asterisk channel for it to name, so `MediaPort.answer` would be
	 * asked for a channel id that does not exist anywhere. That is the one illegal combination §3.5
	 * names and refuses at boot, and until `ENGINE_SIGNALLING_DRIVER` exists to refuse it there, this
	 * is where it is refused: per call, by name, with the deployment spelled out in the log.
	 *
	 * The reason is `internal`, and it was chosen over the four alternatives on purpose.
	 * `SIP_INVITE_REFUSAL_REASONS` has no `not_supported` — deliberately, because every entry on that
	 * list must become a SIP status a STRANGER sees, and "this deployment is misconfigured" is not
	 * something to explain to a caller. `unattributed` and `unknown_target` are `404`s and would tell
	 * the caller their number does not exist, sending them to check a dial string that is perfectly
	 * correct. `congestion` is a `503` and would make a carrier fail the call over to another engine,
	 * where the identical misconfiguration would refuse it again — a retry storm that hides the cause.
	 * `internal` is a `500`: the caller learns the fault is ours, the carrier does not retry into it,
	 * and the operator gets the log line below, which is the only artefact that can actually fix this.
	 */
	private async placeInvitedCall(request: SipInviteRequest): Promise<SipInviteAdmission> {
		const existing = this.registry.byAriChannelId(request.legId);
		if (existing !== undefined) {
			// The retry path. Answered `admitted` rather than refused: the edge asked whether we would
			// take this call and we have, which is the same outcome by any measure it can act on.
			return {
				kind: "admitted",
				orgId: existing.organizationId,
				callId: existing.callId,
				legId: existing.channelId,
				...(existing.snapshot.profile.context === undefined
					? {}
					: { routingContext: existing.snapshot.profile.context }),
				direction: callDirectionFrom(existing.snapshot.variables.OPTIMIQ_CALL_DIRECTION),
			};
		}

		if (this.draining || !this.registry.isAccepting) {
			// The edge answers this one `503` WITH a `Retry-After`, which is the header that makes a
			// carrier fail over instead of retrying into a pod that is closing.
			return {
				kind: "refused",
				reason: "shutting_down",
				error: "this engine instance is draining",
			};
		}

		if (this.env.ENGINE_MEDIA_DRIVER !== "mediad") {
			this.logger.error(
				{
					legId: request.legId,
					sipdInstanceId: request.sipdInstanceId,
					mediaDriver: this.env.ENGINE_MEDIA_DRIVER,
				},
				"refusing a call from the sip edge: this deployment signals on apps/sipd and serves media " +
					"on Asterisk, which is the one combination plans/sipd-invite-design.md §3.5 refuses. " +
					"apps/sipd holds no ARI credential and there is no Asterisk channel this leg could " +
					"name, so the call would ring and never get audio. Set ENGINE_MEDIA_DRIVER=mediad, or " +
					"point this tenant's phones and DIDs back at Asterisk.",
			);
			return {
				kind: "refused",
				reason: "internal",
				error:
					`this engine serves media on ${this.env.ENGINE_MEDIA_DRIVER} and cannot carry a call ` +
					"signalled by apps/sipd",
			};
		}

		const organizationId = await this.attributeInvitedCall(request);
		if (organizationId === undefined) {
			this.logger.info(
				{ legId: request.legId, dialed: request.to.number, authentication: request.authentication },
				"refusing a call from the sip edge: no credential organization and no did-index entry",
			);
			return {
				kind: "refused",
				reason: "unattributed",
				error: `nothing on this platform owns ${request.to.number}`,
			};
		}

		// Asked HERE and not left to the arrival path, because the arrival path's version hangs a
		// channel up and there is no channel yet — the caller learns this as a `503` on their INVITE
		// instead of as a call that connects and is dropped. Same predicate either way, so a tenant's
		// ceiling means the same thing on both planes.
		if (!(await this.isWithinConcurrencyCeiling(organizationId))) {
			this.logger.info(
				{ legId: request.legId, organizationId },
				"refusing a call from the sip edge: the organization is at its simultaneous-call ceiling",
			);
			return {
				kind: "refused",
				reason: "congestion",
				error: "this organization is at its simultaneous-call ceiling",
			};
		}

		const snapshot = this.invitedChannelSnapshot(request, organizationId);
		await this.onLegArrived(snapshot, (aggregate) => {
			if (this.media instanceof SplitPlaneMediaPort && request.sdpOffer !== undefined) {
				this.media.registerInboundLeg(request.legId, {
					orgId: aggregate.organizationId,
					callId: aggregate.callId,
					sipdInstanceId: request.sipdInstanceId,
					sdpOffer: request.sdpOffer,
				});
			}
		});

		const aggregate = this.registry.byAriChannelId(request.legId);
		if (aggregate === undefined) {
			// The arrival path admitted nothing. On this path that means exactly one thing — the
			// `channels` KV compare-and-set did not name this replica — and it is deliberately NOT
			// reported as `congestion`: a `503` would make a carrier fail the call over, and the
			// instance that WON the claim is already serving it, so the failover would ring the caller a
			// second time for a call that is going through. `internal` is a `500` the edge does not
			// retry, and the winner carries on.
			this.logger.warn(
				{ legId: request.legId, organizationId },
				"the sip edge's call was not admitted locally; another replica holds the channel claim",
			);
			return {
				kind: "refused",
				reason: "internal",
				error: "this engine could not take exclusive ownership of the leg",
			};
		}

		return {
			kind: "admitted",
			orgId: aggregate.organizationId,
			callId: aggregate.callId,
			legId: aggregate.channelId,
			routingContext: aggregate.snapshot.profile.context,
			// Read off the VARIABLE and not off `snapshot.direction`, which is a different fact:
			// `ChannelSnapshot.direction` is the SIGNALLING direction and has only two values, so
			// `internal` maps onto `inbound` there. The edge is being told the CALL direction — what
			// the tenant is billed for and what the plan resolved in — which is the reading every
			// other consumer of this variable already takes.
			direction: callDirectionFrom(aggregate.snapshot.variables.OPTIMIQ_CALL_DIRECTION),
		};
	}

	/**
	 * Which tenant an arriving INVITE belongs to.
	 *
	 * The split `plans/sipd-invite-design.md` §4.2 calls load-bearing: the EDGE owns "is this sender
	 * allowed to send me an INVITE" — a digest against the realm's credentials, or a trunk ACL match —
	 * and the ENGINE owns "whose call is it". So a `orgId` on the request means a digest resolved a
	 * credential and is the strongest signal there is, exactly as `OPTIMIQ_ORG_ID` on a channel is;
	 * everything else goes down the same `did-index` ladder every inbound call already uses, which is
	 * the whole reason that bucket is not organization-scoped.
	 *
	 * Reusing {@link attributeCall} rather than writing a second ladder is not tidiness. The ladder's
	 * ORDER is a security property — the development fallback is last on purpose, so a box with
	 * `ENGINE_DEFAULT_ORGANIZATION_ID` set cannot answer another tenant's DID as its own — and a
	 * second copy of it is a second place for that order to be got wrong.
	 */
	private async attributeInvitedCall(request: SipInviteRequest): Promise<string | undefined> {
		return await this.attributeCall(
			{ id: request.legId, dialedNumber: request.to.number, variables: {} },
			// Passed as a VARIABLE rather than short-circuited above, so the entity-id validation in
			// `resolveOrganizationId` applies to an org the edge sent exactly as it applies to one a
			// dialplan stamped. A malformed uuid from either source must fall through to the index
			// rather than become a tenant.
			request.orgId === undefined ? {} : { OPTIMIQ_ORG_ID: request.orgId },
		);
	}

	/**
	 * The arriving INVITE as the arrival path reads it.
	 *
	 * Every one of the variables `readEngineVariables` looks for is stamped here — the compiler now
	 * says so, see {@link ARRIVAL_VARIABLES} — and that is the point rather than an optimisation. Under this plane there is no media server to read a variable
	 * OFF — `MediadMediaPort` refuses `getVariable` because channel variables are a dialplan concept —
	 * so the snapshot's `variables` map stops being "an OPTIMISATION, never the source of truth"
	 * (`media-event.ts`) and becomes the only truth there is. `plans/sipd-invite-design.md` §3.4 calls
	 * that a strengthening of the contract rather than a violation of it, and it is: the field's rule
	 * is that the engine falls back to reading each one over the port, and here the port would read
	 * the same map.
	 *
	 * `OPTIMIQ_LEG` is stamped `a` explicitly. Absent would work — the check is `=== "b"` — but a
	 * missing variable makes `readEngineVariables` attempt a port read that this driver refuses, once
	 * per call, for a value we already know.
	 *
	 * `name` is `sipd/<instance>` rather than a channel name, because there is no channel and inventing
	 * an Asterisk-looking one would put a fiction on the CDR. What a channel name is FOR on this plane
	 * is telling an operator which process to look in, and that is exactly what this says.
	 */
	private invitedChannelSnapshot(
		request: SipInviteRequest,
		organizationId: string,
	): MediaChannelSnapshot {
		// Narrowed, never widened. The responder has already refused a trunk-authenticated INVITE that
		// asked for a trunk-capable context, so what arrives here is a context the sender may have —
		// and a digest-authenticated one keeps it, which is what lets a desk phone dial out.
		const routingContext = request.routingContext;
		// Exhaustive over `ArrivalVariable` on purpose: a name added to `ARRIVAL_VARIABLES` — which is
		// what `readEngineVariables` reads back — does not compile until it is stamped here. An absent
		// claim stays absent rather than becoming an empty string, so `attestationOf` can still tell
		// "no claim" from "a claim that said nothing"; `definedOnly` drops the holes.
		const variables: Record<ArrivalVariable, string | undefined> = {
			OPTIMIQ_ORG_ID: organizationId,
			// A digest-authenticated INVITE is an extension dialling: `internal`, which takes the
			// internal-then-outbound ladder. A trunk INVITE is a carrier delivering a DID and is
			// resolved against the DID table, which is what `inbound` selects.
			OPTIMIQ_CALL_DIRECTION: request.authentication === "digest" ? "internal" : "inbound",
			OPTIMIQ_ROUTING_CONTEXT: routingContext,
			OPTIMIQ_LEG: "a",
			[SIP_CALL_ID_VARIABLE]: request.sipCallId,
			// The address every later command on this leg is sent to. See `channel-identity.ts`.
			[SIPD_INSTANCE_ID_VARIABLE]: request.sipdInstanceId,
			[REPLACES_LEG_ID_VARIABLE]: request.replacesLegId,
			[DEVICE_ID_VARIABLE]: request.deviceId,
			[SIP_ATTESTATION_VARIABLE]: request.attestation?.level,
			[SIP_VERSTAT_VARIABLE]: request.attestation?.verstat,
			[SIP_ORIGID_VARIABLE]: request.attestation?.origId,
			// Only an originated leg (queue callback, click-to-call) carries one; it arrives stamped.
			[CDR_RELATED_CALL_ID_VARIABLE]: undefined,
		};
		return {
			id: request.legId,
			name: `sipd/${request.sipdInstanceId}`,
			...(request.from.name === undefined ? {} : { callerName: request.from.name }),
			callerNumber: request.from.number,
			dialedNumber: request.to.number,
			context: routingContext,
			variables: definedOnly(variables),
		};
	}

	/**
	 * Whether the sender of an INVITE carrying `Replaces` may take over the dialog it named.
	 *
	 * ## What this can honestly establish, and what it cannot
	 *
	 * The obvious check — "is the sender a party to the call being replaced" — is WRONG here, and
	 * getting that wrong would refuse every legitimate attended transfer there is. RFC 5589 §7 spells
	 * the flow out: A talks to B, B consults C, B REFERs C to A with `Replaces` naming the A↔B dialog,
	 * and **C** sends the INVITE. C was never a party to A↔B. A check for party membership would
	 * therefore reject exactly the case the header exists for.
	 *
	 * What actually authorises C is RFC 3891's own model: the `Replaces` triple — `Call-ID`, `to-tag`
	 * and `from-tag` — is a shared secret. Both tags are random tokens chosen by the two ends, so
	 * knowing all three is evidence that a party to that dialog told you, and the RFC's security
	 * consideration is precisely that a UAS must match all three and must not act on a partial match.
	 * **The process that can do that match is `apps/sipd`,** because it holds the dialog and its tags —
	 * the engine does not, and `channel-identity.ts` records why it never did on the ARI plane either:
	 * Asterisk does not expose a PJSIP session's local and remote tags as readable values at all. So
	 * `replacesLegId` on the request means "the triple matched, exactly, against a dialog on this
	 * instance", and that is a fact only the edge could have produced.
	 *
	 * The engine's half is the half the edge cannot see:
	 *
	 * 1. **A digest-authenticated sender.** A trunk is refused outright. A carrier has no legitimate
	 *    reason to replace a dialog on this platform, and giving an unauthenticated stranger a path
	 *    into an existing conversation is the same toll-fraud boundary §8.3 draws, applied to a header
	 *    instead of a context.
	 * 2. **A leg this instance actually holds**, resolved by leg id and — because the arrival path
	 *    indexes it — falling back to the SIP `Call-ID` the transfer responder already resolves on.
	 *    Nothing on another replica: entitlement is checked where the bridge is.
	 * 3. **The same tenant.** The triple is a secret, but a secret that leaked across an organization
	 *    boundary must still not move a call between tenants.
	 * 4. **`early-only`, honoured.** When the header carried the flag, replacing a CONFIRMED dialog is
	 *    forbidden by RFC 3891 §3, and a UAS that ignored it would let a race resolve into somebody
	 *    being cut out of a conversation they were already having.
	 *
	 * ## Why every failure is a refusal and never a downgrade
	 *
	 * Both alternatives were available and both are worse than `403`. Treating an unverifiable
	 * `Replaces` as permission is a call-hijack primitive. Silently DROPPING it and routing the INVITE
	 * as an ordinary call is worse still, because it looks like it worked: the transfer target rings a
	 * second time, the transferor's consultation leg is never taken out of anything, and the party who
	 * was supposed to be handed over is left holding a call nobody is coming back to. RFC 3891 §3 is
	 * explicit that a UAS which cannot honour the header responds `481`/`501` rather than ignoring it.
	 * Refusing gives the transferring phone an immediate failure it can recover the consultation from.
	 */
	private async authorizeInviteReplaces(
		request: SipInviteRequest,
	): Promise<SipReplacesAuthorization> {
		if (request.authentication !== "digest") {
			return {
				kind: "refused",
				error: "a Replaces is only honoured for a digest-authenticated sender",
			};
		}
		const replaces = request.replaces;
		const replacesLegId = request.replacesLegId;
		if (replaces === undefined || replacesLegId === undefined) {
			return { kind: "refused", error: "the Replaces header did not resolve to a leg at the edge" };
		}

		// Resolved by the edge's leg id ALONE. Falling back to the SIP `Call-ID` index — which the
		// transfer responder does resolve on — was available and is refused here, because it would
		// authorise on strictly LESS evidence than the edge already applied: a `Call-ID` match ignores
		// both tags, and RFC 3891's whole security argument is that all three must match. A second,
		// weaker resolution would make the stronger one decorative.
		const replaced = this.registry.byAriChannelId(replacesLegId);
		if (replaced === undefined || replaced.isTearingDown) {
			return {
				kind: "refused",
				error: "no live leg on this engine holds the dialog that Replaces named",
			};
		}
		if (request.orgId === undefined || replaced.organizationId !== request.orgId) {
			return { kind: "refused", error: "that dialog belongs to another organization" };
		}
		if (replaces.earlyOnly && replaced.isAnswered) {
			// RFC 3891 §3: `early-only` means "replace this only if it has not been answered". The
			// header is how a UAC says "I am completing a transfer of a call that never connected", and
			// honouring it is what stops a lost race from cutting somebody out of a live conversation.
			return {
				kind: "refused",
				error: "the Replaces carried early-only and the dialog it named is already confirmed",
			};
		}

		// The MEDIA channel id, which on this plane is the edge's own leg id — the same string
		// {@link REPLACES_LEG_ID_VARIABLE} carries onto the new leg, so the program that completes the
		// transfer resolves exactly the leg this ladder authorised and never a second candidate.
		return { kind: "authorized", replacedLegId: replaced.ariChannelId };
	}

	/**
	 * Completes an authorised `Replaces`: answer the new leg, put it where the old one was, and end
	 * the old one.
	 *
	 * Detached, exactly as {@link startRoutedProgram} is and for the same reason: it awaits media
	 * events that are delivered through the same handler that started it, so awaiting it from inside
	 * the arrival path would make the call wait for events that cannot be processed until the call
	 * stops waiting.
	 *
	 * ## Why `CallControl.bridge` does the whole job
	 *
	 * The replaced leg is in a bridge with its peer. `bridge` joins the new leg to the PEER's existing
	 * bridge rather than building a second one, so for a moment the bridge has three members and the
	 * conversation never breaks — and then the replaced leg is hung up and leaves it. That ordering is
	 * the feature: hanging the replaced leg up FIRST would tear its bridge down under the peer and
	 * leave the remaining party in silence for as long as the new leg took to arrive, which on a
	 * congested media plane is exactly long enough to hang up.
	 *
	 * `ATTENDED_TRANSFER` is the cause on the replaced leg, so its CDR row says what happened to it
	 * rather than reporting a `NORMAL_CLEARING` indistinguishable from the party simply hanging up.
	 * The edge reports the same thing from its own side as `dialog.terminated{reason: "replaced"}`.
	 */
	private startReplacesProgram(aggregate: ChannelAggregate, replacedLegId: string): void {
		const key = aggregate.ariChannelId;
		const program = this.runReplacesProgram(aggregate, replacedLegId)
			.catch(async (error: unknown) => {
				this.logger.error(
					{ channelId: aggregate.channelId, replacedLegId, err: String(error) },
					"completing a Replaces failed; the call is being torn down",
				);
				await this.hangupQuietly(aggregate.ariChannelId, "NORMAL_TEMPORARY_FAILURE");
			})
			.finally(() => {
				this.walks.delete(key);
			});
		// Tracked as a walk so the drain and the integration suite have the same settlement point they
		// have for a routing walk. It is not a routing walk, but it is exactly as detached as one.
		this.walks.set(key, program);
	}

	private async runReplacesProgram(
		aggregate: ChannelAggregate,
		replacedLegId: string,
	): Promise<void> {
		const replaced = this.controlledLegFor(replacedLegId);
		if (replaced === undefined || replaced.isTearingDown) {
			// Between authorisation and here the replaced call ended — the ordinary race when a
			// transferor's consultation collapses. There is nothing to join, and routing the INVITE as a
			// fresh call now would dial the transfer target a second time.
			this.logger.info(
				{ channelId: aggregate.channelId, replacedLegId },
				"the leg a Replaces named went away before the transfer could complete",
			);
			await this.hangupQuietly(aggregate.ariChannelId, "ORIGINATOR_CANCEL");
			return;
		}
		const peerMediaChannelId = replaced.peerMediaChannelId;
		const peer =
			peerMediaChannelId === undefined ? undefined : this.controlledLegFor(peerMediaChannelId);
		if (peer === undefined) {
			// A dialog with nobody on the other side of it: the replaced leg was in an IVR, a queue or a
			// voicemail box rather than in a conversation. There is no seat to take, and RFC 3891 has
			// nothing to say about replacing a party that is talking to the PBX itself.
			this.logger.info(
				{ channelId: aggregate.channelId, replacedLegId },
				"the leg a Replaces named is not bridged to anybody; nothing to take over",
			);
			await this.hangupQuietly(aggregate.ariChannelId, "NORMAL_TEMPORARY_FAILURE");
			return;
		}

		const answered = await this.execute(aggregate, { verb: "answer" });
		if (answered === undefined || aggregate.isTearingDown) {
			return;
		}

		const leg = this.controlledLegFor(aggregate.ariChannelId);
		if (leg === undefined) {
			return;
		}
		const bridged = await this.control.bridge(leg, { peerLegId: peer.legId });
		if (!bridged.result.ok) {
			this.logger.warn(
				{ channelId: aggregate.channelId, replacedLegId, reason: bridged.result.reason },
				"could not bridge a Replaces into the call it named",
			);
			await this.hangupQuietly(aggregate.ariChannelId, "NORMAL_TEMPORARY_FAILURE");
			return;
		}

		// Last, and only once the new party is already in the bridge. See the method note above.
		await this.hangupQuietly(replaced.mediaChannelId, "ATTENDED_TRANSFER");
		this.logger.info(
			{
				channelId: aggregate.channelId,
				replacedLegId,
				peerLegId: peer.legId,
				bridgeId: bridged.bridgeId,
			},
			"completed an attended transfer arriving as an INVITE with Replaces",
		);
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
		get deviceId(): string | undefined {
			return aggregate.snapshot.variables[DEVICE_ID_VARIABLE];
		},
		get bridgeId(): string | undefined {
			return aggregate.snapshot.bridgeId;
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

/**
 * Queue id → the queue's own dialable number, off the artifact's exact-match table.
 *
 * There is no `queueId -> number` index in the artifact and no number on `QueuePlanNode`, which is
 * why virtual hold went without one: the map is built by scanning the table the same way `parkLots`
 * and `sharedLineFor` scan the nodes, and for the same reason — a second index kept in step with the
 * first is worse than one pass over a table that has one entry per dialable thing in the tenant.
 *
 * A queue reachable on two numbers keeps the FIRST, which is the table's own iteration order and is
 * stable for one artifact. Either number is a correct `from` for the outbound resolve, and picking
 * deterministically is what stops two engines dialling the same callback under two toll classes.
 */
export function queueNumbersOf(artifact: RoutingArtifact): Record<string, string> {
	const numbers: Record<string, string> = {};
	for (const entry of Object.values(artifact.internal.numbers)) {
		if (entry.kind === "queue" && numbers[entry.entityId] === undefined) {
			numbers[entry.entityId] = entry.number;
		}
	}
	return numbers;
}

/**
 * The scheduler as a walk sees it, with the queue's own number folded in.
 *
 * `QueueCallbackSchedulePort.register` is deliberately three arguments — a queue session knows the
 * queue it is in and the plan it promised, and nothing about the tenant's number plan — so the
 * number is supplied HERE, where the artifact is in hand, rather than by widening the ACD plane's
 * view of the world.
 */
export function queueCallbackPort(
	scheduler: QueueCallbackScheduler,
	numbers: Readonly<Record<string, string>> | undefined,
): QueueCallbackSchedulePort {
	return {
		register: (orgId, queueId, plan) => {
			const queueNumber = numbers?.[queueId];
			scheduler.register(orgId, queueId, plan, queueNumber === undefined ? {} : { queueNumber });
		},
	};
}

function definedOnly(values: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

/**
 * One sentence naming why a verb did not run, for the walk's notes.
 *
 * The typed failure carries the useful half — `MediaCommandFailure.detail` is the media plane's own
 * refusal, verbatim, which for `mediad` is a message like `no such prompt: sound:moh/default` that
 * names the exact reference an operator has to go and provide. `Cause.pretty` is the fallback for a
 * defect, where there is no typed failure to read and a stack is better than nothing.
 */
function verbFailureDetail(verb: string, cause: Cause.Cause<VerbFailure>): string {
	const failure = Cause.findErrorOption(cause);
	if (failure._tag === "None") {
		return `the ${verb} verb died: ${Cause.pretty(cause)}`;
	}
	const error = failure.value;
	switch (error._tag) {
		case "MediaCommandFailure":
			return `the media plane refused ${verb}: ${error.detail}`;
		case "VerbNotPermittedFailure":
			return `${verb} was not permitted: ${error.reason}`;
		case "UnsupportedVerbFailure":
			return `this engine does not implement ${error.verb}`;
		default:
			return `the ${verb} verb failed: ${error.message}`;
	}
}

/**
 * The cause every plane-loss teardown files: Q.850 41, "temporary failure".
 *
 * The same code `apps/sipd`'s claim reaper publishes for the identical event and the same one the
 * drain gives a straggler. Not 16: a crash filed as a normal hang-up is an availability incident
 * that cannot be seen in the CDR.
 */
const PLANE_LOSS_HANGUP_CAUSE = "NORMAL_TEMPORARY_FAILURE" as const;

/** A plane this engine's legs depended on, and which is now gone. */
export type PlaneLoss =
	| {
			/** No `mediad` answered the reachability probe, so every media session is dead. */
			readonly plane: "media";
			readonly instanceId?: undefined;
			readonly reason: string;
	  }
	| {
			/** One `sipd` stopped renewing its liveness lease. Its dialogs died with it. */
			readonly plane: "signalling";
			readonly instanceId: string;
			readonly reason: string;
	  };
