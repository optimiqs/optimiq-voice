import { Inject, Injectable } from "@nestjs/common";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { makeCdrLegWriteEvent, validateEvent } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { resolveInbound, resolveInternal, resolveOutbound } from "@optimiq-voice/routing";
import { isDtmfDigit } from "@optimiq-voice/telephony";
import { CallEventPublisher } from "../nats/call-event-publisher.service";
import { JetStreamService } from "../nats/jetstream.service";
import { CALLS_EFFECT_RUNTIME, ENGINE_ENV, MEDIA_PORT } from "../nats/nats.tokens";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "../routing/call-signals";
import { PlanWalker } from "../routing/plan-walker";
import { RoutingArtifactSource } from "../routing/routing-artifact.source";
import { dtmfEventFrom } from "../verbs/dtmf-inbox";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import {
	callDirectionFrom,
	callStateFromAriChannelState,
	dialStringOr,
	hangupCauseFromAri,
	hangupSideFor,
} from "./ari-mapping";
import { buildCdrLegWrite } from "./cdr-leg";
import { ChannelAggregate } from "./channel-aggregate";
import { callIdForAriChannel, legIdForAriChannel, resolveOrganizationId } from "./channel-identity";
import { ChannelRegistry } from "./channel-registry";
import type { MediaPort } from "../ari/media-port";
import type { EngineEnv } from "../config/engine-env";
import type { PlanWalkerSettings, WalkerChannel } from "../routing/plan-walker";
import type { VerbChannelContext, VerbExecutorRuntime } from "../verbs/verb-executor";
import type { CallDirection, CallEvent, LegSide } from "@optimiq-voice/events";
import type { AriChannel, AriEvent } from "@optimiq-voice/media-ari";
import type { ResolvedRoute, RoutingArtifact } from "@optimiq-voice/routing";
import type { CallerProfile, HangupCause, Verb, VerbResult } from "@optimiq-voice/telephony";

/** Channel variables the routing walk writes back, so the KV mirror carries the decision too. */
const DESTINATION_TYPE_VARIABLE = "OPTIMIQ_DESTINATION_TYPE";
const DESTINATION_REF_VARIABLE = "OPTIMIQ_DESTINATION_REF";

/**
 * The channel orchestrator — the engine's core.
 *
 * ## What it does, in one sentence
 *
 * Turns ARI events into domain state transitions, publishes the resulting facts on NATS, mirrors
 * live state into KV, and emits one CDR per finished leg.
 *
 * ## The invariants it exists to hold
 *
 * 1. **Every state move is guarded.** `assertChannelTransition` runs before the write, inside
 *    {@link ChannelAggregate}. An impossible transition throws rather than corrupting the
 *    snapshot other instances will read out of KV.
 * 2. **The hangup cause is fixed once.** The first cause wins; a later `ChannelDestroyed` cannot
 *    overwrite it. That is what makes the per-leg CDR reproducible from the event stream.
 * 3. **A call with no resolvable organization is REJECTED, never guessed.** Filing a call under
 *    the wrong tenant is both a billing error and an isolation breach, and both are silent.
 * 4. **Nothing here throws into the ARI socket.** A handler that throws inside a WebSocket
 *    callback is an unhandled rejection that takes the process — and therefore every live call —
 *    down. Failures are logged and, where they are the call's problem, the call is hung up.
 *
 * ## Routing
 *
 * Since P3 there IS routing: `RoutingArtifactSource` supplies the organization's compiled artifact,
 * `packages/routing`'s resolvers turn the call's facts into an `ExecutionPlan`, and
 * {@link PlanWalker} executes it. This class stays the owner of channel STATE and of the event
 * stream; it does not know what a ring group is.
 *
 * The walk runs DETACHED (see {@link runRoutedProgram}). It has to: an IVR that waits ten seconds
 * for a digit is waiting on ARI events that arrive through this same handler, so awaiting the walk
 * inside `StasisStart` would deadlock the call against itself.
 *
 * ## Two kinds of channel
 *
 * A `StasisStart` is either a NEW inbound call or a leg the plan walker originated. They are told
 * apart by {@link CallSignalBus}: the walker subscribes to a leg's key before it originates, so a
 * watched key means "this is ours, do not file it as a new call". Getting that backwards would file
 * every B-leg as an inbound call with its own CDR.
 */
@Injectable()
export class ChannelOrchestrator {
	private readonly logger = getLogger("engine.calls");
	private readonly registry = new ChannelRegistry();
	/** Detached routing walks, so the drain and the integration suite can await settlement. */
	private readonly walks = new Map<string, Promise<void>>();
	private draining = false;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		@Inject(MEDIA_PORT) private readonly media: MediaPort,
		@Inject(CALLS_EFFECT_RUNTIME) private readonly runtime: VerbExecutorRuntime,
		private readonly dtmf: DtmfRegistry,
		private readonly events: CallEventPublisher,
		private readonly jetstream: JetStreamService,
		private readonly routing: RoutingArtifactSource,
		private readonly signals: CallSignalBus,
	) {}

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

	/**
	 * The single entry point for ARI events.
	 *
	 * Never throws: the caller is a WebSocket message callback (see invariant 4). Returns a promise
	 * so the integration suite can await settlement; the socket itself does not await it, because
	 * blocking the event loop on one channel's work would delay every other channel's events.
	 */
	async handleEvent(event: AriEvent): Promise<void> {
		try {
			await this.dispatch(event);
		} catch (error) {
			this.logger.error(
				{ type: event.type, err: String(error) },
				"unhandled failure while processing an ARI event",
			);
		}
	}

	private async dispatch(event: AriEvent): Promise<void> {
		switch (event.type) {
			case "StasisStart":
				await this.onStasisStart(event.channel);
				return;
			case "ChannelStateChange":
				await this.onChannelStateChange(event.channel);
				return;
			case "ChannelDtmfReceived":
				await this.onDtmf(event.channel, event.digit, event.durationMs);
				return;
			case "ChannelHangupRequest":
				this.onHangupRequest(event.channel, event.cause);
				return;
			case "StasisEnd":
				this.onStasisEnd(event.channel);
				return;
			case "ChannelDestroyed":
				await this.onChannelDestroyed(event.channel, event.cause);
				return;
			case "ChannelVarset":
				this.onVarset(event.channel, event.variable, event.value);
				return;
			case "RecordingStarted":
				this.signals.emit(recordingSignalKey(event.recording.name), {
					kind: "recording-started",
				});
				return;
			case "RecordingFinished":
				this.signals.emit(recordingSignalKey(event.recording.name), {
					kind: "recording-finished",
					durationMs: Math.round((event.recording.duration ?? 0) * 1_000),
				});
				return;
			case "RecordingFailed":
				this.signals.emit(recordingSignalKey(event.recording.name), {
					kind: "recording-failed",
					reason: event.recording.cause ?? "unknown",
				});
				return;
			default:
				// Every other ARI event is real information the engine does not act on yet
				// (bridge membership, playback progress, Dial state). The walker gets what it needs
				// from the channel events above.
				return;
		}
	}

	// -------------------------------------------------------------------------------------------
	// Call entry
	// -------------------------------------------------------------------------------------------

	private async onStasisStart(channel: AriChannel): Promise<void> {
		if (this.signals.isWatched(legSignalKey(channel.id))) {
			// A leg the plan walker originated has reached the application. It is NOT a new inbound
			// call: filing it as one would give the callee's own leg a `channel.created`, an
			// organization lookup it has no variables for, and a second CDR for one call.
			this.signals.emit(legSignalKey(channel.id), { kind: "entered" });
			return;
		}

		if (this.registry.byAriChannelId(channel.id) !== undefined) {
			// A masquerade (attended transfer completing, a pickup) can re-deliver `StasisStart`
			// for a channel already being tracked. Re-creating the aggregate would reset its state
			// machine and lose the answer instant.
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
			// dial resolves on the FIRST signal it gets, and when `ChannelStateChange`→`Up` beats
			// `StasisStart` the walker has already unsubscribed by the time this arrives. That
			// window is small, real, and the failure it produces is the worst kind — the callee's
			// own leg filed as a second inbound call, resolved against the DID table it was never
			// dialled on, and given a CDR of its own.
			this.logger.debug(
				{ ariChannelId: channel.id, exten: channel.dialplan?.exten },
				"a leg this engine originated reached the application",
			);
			this.signals.emit(legSignalKey(channel.id), { kind: "entered" });
			return;
		}

		const organizationId = resolveOrganizationId(
			variables,
			this.env.ENGINE_DEFAULT_ORGANIZATION_ID,
		);

		if (organizationId === undefined) {
			// Invariant 3. `INVALID_PROFILE` is the honest cause: the call reached us without the
			// routing context that says who it belongs to.
			this.logger.error(
				{ ariChannelId: channel.id, exten: channel.dialplan?.exten },
				"rejecting a call with no resolvable organization (set OPTIMIQ_ORG_ID in the dialplan)",
			);
			await this.hangupQuietly(channel.id, "INVALID_PROFILE");
			return;
		}

		const direction = callDirectionFrom(variables.OPTIMIQ_CALL_DIRECTION);
		const aggregate = ChannelAggregate.create({
			ariChannelId: channel.id,
			channelId: legIdForAriChannel(channel.id),
			callId: callIdForAriChannel(channel.id),
			organizationId,
			direction,
			leg: "a",
			profile: profileFrom(channel, variables.OPTIMIQ_ROUTING_CONTEXT),
			variables: definedOnly(variables),
			createdAt: Date.now(),
		});

		this.registry.add(aggregate);

		// Explicitly subscribe to this leg's events. The engine's socket is narrow on purpose
		// (`ARI_SUBSCRIBE_ALL=false`), and a narrow subscription stops the moment a channel leaves
		// the application — which is precisely when teardown starts. Without this, a call the
		// ENGINE ends emits `StasisEnd` and then nothing: no `channel.hangup`, no
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
					number: dialStringOr(channel.caller?.number),
					...(channel.caller?.name === undefined || channel.caller.name === ""
						? {}
						: { name: channel.caller.name }),
				},
				to: { number: dialStringOr(channel.dialplan?.exten) },
				...(channel.dialplan?.context === undefined || channel.dialplan.context === ""
					? {}
					: { routingContext: channel.dialplan.context }),
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
	 * Separate from {@link runUnroutedProgram} because `answer` is a REQUEST, not a state: the ARI
	 * call returns as soon as Asterisk has accepted it, and the channel only becomes `Up` — and the
	 * leg only gains a media path — when the far end's `200 OK` has been exchanged, which arrives
	 * as a later `ChannelStateChange`. Playing audio in the same loop as `answer` means playing it
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
	 * Detached is not a shortcut, it is a requirement: the walk awaits ARI events (a B-leg
	 * answering, a digit arriving) that are delivered through this same handler. Awaiting the walk
	 * from inside `StasisStart` would make the call wait for events that cannot be processed until
	 * the call stops waiting.
	 */
	private startRoutedProgram(aggregate: ChannelAggregate, channel: AriChannel): void {
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
	private async runRoutedProgram(aggregate: ChannelAggregate, channel: AriChannel): Promise<void> {
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

		const walker = new PlanWalker({
			media: this.media,
			signals: this.signals,
			channel: walkerChannelFor(aggregate),
			execute: (verb) => this.execute(aggregate, verb),
			publish: (type, data) => this.publishCallEvent(aggregate, type, data),
			settings: this.walkerSettings(),
			peerLegId: legIdForAriChannel,
			log: (message, detail) => {
				this.logger.info({ channelId: aggregate.channelId, ...detail }, message);
			},
		});

		const outcome = await walker.walk({
			plan: route.plan,
			timeConditions: artifact.timeConditions,
			now: new Date(),
			...(route.dialedNumber === undefined ? {} : { dialedNumber: route.dialedNumber }),
			...(route.callerIdNumber === undefined ? {} : { callerIdNumber: route.callerIdNumber }),
			...(route.callerIdName === undefined ? {} : { callerIdName: route.callerIdName }),
			...(route.featureArgument === undefined ? {} : { featureArgument: route.featureArgument }),
		});

		if (outcome.destination !== undefined) {
			// Written as channel variables so the KV mirror carries them too: a failover that picks
			// this leg up from another instance must be able to write the same CDR.
			aggregate.setVariable(DESTINATION_TYPE_VARIABLE, outcome.destination.destinationType);
			if (outcome.destination.destinationRef !== undefined) {
				aggregate.setVariable(DESTINATION_REF_VARIABLE, outcome.destination.destinationRef);
			}
			await this.jetstream.putChannel(aggregate.snapshot);
		}

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
		channel: AriChannel,
	): ResolvedRoute {
		const now = new Date();
		const dialed = dialStringOr(channel.dialplan?.exten);
		const caller = channel.caller?.number?.trim();
		const callerName = channel.caller?.name?.trim();
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
			recordingFormat: this.env.ENGINE_RECORDING_FORMAT,
			voicemailGreeting: this.env.ENGINE_VOICEMAIL_GREETING,
			unavailableAnnouncement: this.env.ENGINE_UNAVAILABLE_ANNOUNCEMENT,
			mediaRefs: {
				promptPrefix: this.env.ENGINE_PROMPT_MEDIA_PREFIX,
				fallbackMedia: this.env.ENGINE_UNAVAILABLE_ANNOUNCEMENT,
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
			// it back. Asterisk answers a locally-initiated `DELETE /channels/{id}` with a
			// `ChannelHangupRequest` carrying its own generic code, and `markHangup` is first-wins —
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

	private async onChannelStateChange(channel: AriChannel): Promise<void> {
		const nextCallState = callStateFromAriChannelState(channel.state);
		const aggregate = this.registry.byAriChannelId(channel.id);

		if (aggregate === undefined) {
			// Not one of this instance's A-legs. If a walk is waiting on it, it is a leg that walk
			// originated and this is the answer it is waiting for.
			this.emitLegProgress(channel.id, nextCallState);
			return;
		}

		// The A-leg's own progress is published on the bus too, because `ensureAnswered` in the
		// walker waits for exactly this: `answer` is a request and `Up` is the confirmation.
		this.emitLegProgress(channel.id, nextCallState);

		if (aggregate.isTearingDown) {
			return;
		}

		if (nextCallState === undefined || !aggregate.tryCallStateTo(nextCallState)) {
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
			await this.events.publish("channel.answered", {
				orgId: aggregate.organizationId,
				callId: aggregate.callId,
				data: { legId: aggregate.channelId },
			});
		}

		await this.jetstream.putChannel(aggregate.snapshot);

		// After the mirror, so a failover that happens mid-announcement sees an answered leg.
		if (justAnswered) {
			await this.runAnsweredProgram(aggregate);
		}
	}

	private async onDtmf(channel: AriChannel, digit: string, durationMs: number): Promise<void> {
		const aggregate = this.registry.byAriChannelId(channel.id);
		if (aggregate === undefined) {
			return;
		}
		if (!isDtmfDigit(digit.toUpperCase())) {
			this.logger.warn({ digit, channelId: aggregate.channelId }, "ignoring a non-DTMF symbol");
			return;
		}

		const event = dtmfEventFrom({ digit: digit.toUpperCase(), durationMs });
		this.dtmf.forChannel(aggregate.channelId).push(event);

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
	private emitLegProgress(ariChannelId: string, callState: string | undefined): void {
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

	private onVarset(channel: AriChannel | undefined, variable: string, value: string): void {
		if (channel === undefined) {
			return;
		}
		const aggregate = this.registry.byAriChannelId(channel.id);
		if (aggregate === undefined || !variable.startsWith("OPTIMIQ_")) {
			return;
		}
		aggregate.setVariable(variable, value);
	}

	// -------------------------------------------------------------------------------------------
	// Teardown
	// -------------------------------------------------------------------------------------------

	/**
	 * The far end asked to hang up. Fixes the cause NOW, while it is known — `ChannelDestroyed`
	 * arrives later and, for a locally-initiated teardown, with a less specific code.
	 */
	private onHangupRequest(channel: AriChannel, ariCause: number | undefined): void {
		const aggregate = this.registry.byAriChannelId(channel.id);
		if (aggregate === undefined) {
			return;
		}
		aggregate.markHangup({
			cause: hangupCauseFromAri(ariCause ?? 16),
			at: Date.now(),
			initiatedByEngine: false,
		});
	}

	/** The channel left the Stasis application. Teardown has begun; no further verbs will run. */
	private onStasisEnd(channel: AriChannel): void {
		const aggregate = this.registry.byAriChannelId(channel.id);
		if (aggregate === undefined) {
			return;
		}
		this.dtmf.release(aggregate.channelId);
	}

	/**
	 * The leg is gone. Publishes the terminal event pair and the CDR, then clears the KV mirror.
	 *
	 * The order is load-bearing: `channel.hangup` (why it ended) before `channel.destroyed` (that
	 * it ended) before `cdr.leg.write` (what it cost), and the KV entry is only cleared once the
	 * CDR has been acknowledged — an entry that outlives its call is recoverable, a CDR that was
	 * never written is revenue.
	 */
	private async onChannelDestroyed(channel: AriChannel, ariCause: number): Promise<void> {
		// Emitted FIRST and unconditionally: a walk waiting on this leg — whether it is one it
		// originated or the A-leg it is answering — must be released before anything slow runs,
		// or a dial sits on its own ring timeout for a leg that is already gone.
		this.signals.emit(legSignalKey(channel.id), {
			kind: "ended",
			cause: hangupCauseFromAri(ariCause),
			causeCode: ariCause,
		});

		const aggregate = this.registry.byAriChannelId(channel.id);
		if (aggregate === undefined) {
			return;
		}

		const at = Date.now();
		aggregate.markHangup({
			cause: hangupCauseFromAri(ariCause),
			at,
			initiatedByEngine: false,
		});

		this.dtmf.release(aggregate.channelId);

		aggregate.tryTransitionTo("hangup");
		aggregate.tryCallStateTo("hangup");

		const cause = aggregate.hangupCause ?? "NORMAL_UNSPECIFIED";
		const side = hangupSideFor({ leg: "a", initiatedByEngine: aggregate.wasHungUpByEngine });

		await this.events.publish("channel.hangup", {
			orgId: aggregate.organizationId,
			callId: aggregate.callId,
			data: {
				legId: aggregate.channelId,
				cause,
				// The RAW ARI code, not the code of the named cause: an unnamed Q.850 point maps to
				// `NORMAL_UNSPECIFIED` but its number is the only evidence of what really happened.
				causeCode: ariCause,
				side,
			},
		});

		aggregate.transitionTo("reporting");

		const endedAt = aggregate.snapshot.hangupAt ?? at;
		await this.events.publish("channel.destroyed", {
			orgId: aggregate.organizationId,
			callId: aggregate.callId,
			data: {
				legId: aggregate.channelId,
				durationMs: Math.max(0, endedAt - aggregate.snapshot.createdAt),
			},
		});

		await this.writeCdr(aggregate, { cause, causeCode: ariCause, side, endedAt });

		aggregate.transitionTo("destroyed");
		await this.jetstream.deleteChannel(aggregate.snapshot);
		this.registry.remove(aggregate);
	}

	private async writeCdr(
		aggregate: ChannelAggregate,
		input: {
			readonly cause: HangupCause;
			readonly causeCode: number;
			readonly side: ReturnType<typeof hangupSideFor>;
			readonly endedAt: number;
		},
	): Promise<void> {
		try {
			// The destination the routing walk reached, mirrored onto the leg as channel variables
			// so it survives a failover. Absent means the leg was never routed, and the CDR says
			// `unknown` rather than inventing one.
			const destinationType = aggregate.snapshot.variables[DESTINATION_TYPE_VARIABLE];
			const destinationRef = aggregate.snapshot.variables[DESTINATION_REF_VARIABLE];
			const data = buildCdrLegWrite({
				snapshot: aggregate.snapshot,
				leg: "a",
				direction: callDirectionFrom(aggregate.snapshot.variables.OPTIMIQ_CALL_DIRECTION),
				hangupCause: input.cause,
				hangupCauseCode: input.causeCode,
				hangupSide: input.side,
				endedAt: input.endedAt,
				...(destinationType === undefined ? {} : { destinationType }),
				...(destinationRef === undefined ? {} : { destinationRef }),
			});
			const envelope = makeCdrLegWriteEvent({
				orgId: aggregate.organizationId,
				source: "engine",
				data,
			});
			validateEvent(envelope.subject, envelope);
			await this.jetstream.publishCdrLeg(envelope);
		} catch (error) {
			// Logged at ERROR and deliberately not rethrown: the leg is already gone, so there is
			// nothing to fail. This is the line an operator alerts on — a missing CDR is revenue.
			this.logger.error(
				{ channelId: aggregate.channelId, callId: aggregate.callId, err: String(error) },
				"failed to publish the CDR for a finished leg",
			);
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
		this.registry.closeForNewCalls();
		// Every walk is waiting on a signal that will never come once the calls are gone. Dropping
		// the waiters lets the timers fire and the walks settle instead of holding the drain open.
		this.signals.clear();

		const deadline = Date.now() + timeoutMs;
		while (this.registry.size > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}

		const stragglers = this.registry.all;
		if (stragglers.length === 0) {
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
	}

	// -------------------------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------------------------

	/** Hangs a channel up without letting a media-server failure become the caller's problem. */
	private async hangupQuietly(ariChannelId: string, cause: HangupCause): Promise<void> {
		try {
			await this.media.hangup(ariChannelId, cause);
		} catch (error) {
			this.logger.warn({ ariChannelId, cause, err: String(error) }, "failed to hang up a channel");
		}
	}

	/** Reads the engine's channel variables in one pass. Absent variables come back `undefined`. */
	private async readEngineVariables(
		channel: AriChannel,
	): Promise<Record<string, string | undefined>> {
		const fromEvent = channel.channelvars ?? {};
		const names = [
			"OPTIMIQ_ORG_ID",
			"OPTIMIQ_CALL_DIRECTION",
			"OPTIMIQ_ROUTING_CONTEXT",
			// Marks a leg the engine originated. Read here rather than guessed from the dialplan,
			// because it is the only thing that is true of every originated leg and of nothing else.
			"OPTIMIQ_LEG",
		];
		const entries = await Promise.all(
			names.map(async (name) => {
				// `channelvars` is only populated when Asterisk is configured to export variables
				// with every event, so it is an optimisation, never the source of truth.
				const inline = fromEvent[name];
				if (inline !== undefined && inline !== "") {
					return [name, inline] as const;
				}
				try {
					return [name, await this.media.getVariable(channel.id, name)] as const;
				} catch {
					return [name, undefined] as const;
				}
			}),
		);
		return Object.fromEntries(entries);
	}
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
function profileFrom(channel: AriChannel, routingContext: string | undefined): CallerProfile {
	return {
		callerIdName: emptyToUndefined(channel.caller?.name),
		callerIdNumber: emptyToUndefined(channel.caller?.number),
		ani: emptyToUndefined(channel.caller?.number),
		destinationNumber: dialStringOr(channel.dialplan?.exten),
		context: routingContext ?? emptyToUndefined(channel.dialplan?.context) ?? "default",
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
