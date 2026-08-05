import { Inject, Injectable } from "@nestjs/common";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { makeCdrLegWriteEvent, validateEvent } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { isDtmfDigit } from "@optimiq-voice/telephony";
import { CallEventPublisher } from "../nats/call-event-publisher.service";
import { JetStreamService } from "../nats/jetstream.service";
import { CALLS_EFFECT_RUNTIME, ENGINE_ENV, MEDIA_PORT } from "../nats/nats.tokens";
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
import type { VerbChannelContext, VerbExecutorRuntime } from "../verbs/verb-executor";
import type { CallDirection, LegSide } from "@optimiq-voice/events";
import type { AriChannel, AriEvent } from "@optimiq-voice/media-ari";
import type { CallerProfile, HangupCause, Verb } from "@optimiq-voice/telephony";

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
 * ## What it does NOT do
 *
 * Routing. There is no inbound-route lookup, no IVR, no dial. That is P3's routing executor. The
 * P2 program is deliberately trivial (`ringing` → `answer` → optional announcement) so that the
 * event chain, the state machines, the KV mirror and the CDR can be proven end to end before
 * anything interesting is layered on top.
 */
@Injectable()
export class ChannelOrchestrator {
	private readonly logger = getLogger("engine.calls");
	private readonly registry = new ChannelRegistry();
	private draining = false;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		@Inject(MEDIA_PORT) private readonly media: MediaPort,
		@Inject(CALLS_EFFECT_RUNTIME) private readonly runtime: VerbExecutorRuntime,
		private readonly dtmf: DtmfRegistry,
		private readonly events: CallEventPublisher,
		private readonly jetstream: JetStreamService,
	) {}

	/** Live legs this instance is handling. `/healthz` and the drain both read it. */
	get activeChannelCount(): number {
		return this.registry.size;
	}

	get isDraining(): boolean {
		return this.draining;
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
			default:
				// Every other ARI event is real information the engine does not act on yet
				// (bridges, playbacks, recordings, Dial progress). They land in P3 with the feature
				// runtimes that need them.
				return;
		}
	}

	// -------------------------------------------------------------------------------------------
	// Call entry
	// -------------------------------------------------------------------------------------------

	private async onStasisStart(channel: AriChannel): Promise<void> {
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
		await this.runInboundProgram(aggregate);
	}

	/**
	 * The P2 inbound program, part one: alert, then answer.
	 *
	 * Trivial on purpose — it is a probe that the whole chain works, not a product. P3's routing
	 * executor replaces this method with a compiled routing artifact, and the verb executor
	 * underneath it does not change.
	 */
	private async runInboundProgram(aggregate: ChannelAggregate): Promise<void> {
		for (const verb of [{ verb: "ringing" }, { verb: "answer" }] satisfies Verb[]) {
			const executed = await this.execute(aggregate, verb);
			if (!executed || aggregate.isTearingDown) {
				return;
			}
		}
	}

	/**
	 * Part two: whatever needs a media path.
	 *
	 * Separate from {@link runInboundProgram} because `answer` is a REQUEST, not a state: the ARI
	 * call returns as soon as Asterisk has accepted it, and the channel only becomes `Up` — and the
	 * leg only gains a media path — when the far end's `200 OK` has been exchanged, which arrives
	 * as a later `ChannelStateChange`. Playing audio in the same loop as `answer` means playing it
	 * at a leg that has not answered yet, which the verb guard correctly refuses.
	 */
	private async runAnsweredProgram(aggregate: ChannelAggregate): Promise<void> {
		const announcement = this.env.ENGINE_INBOUND_ANNOUNCEMENT;
		if (announcement === undefined || aggregate.isTearingDown) {
			return;
		}
		await this.execute(aggregate, { verb: "play", media: announcement });
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
	 */
	private async execute(aggregate: ChannelAggregate, verb: Verb): Promise<boolean> {
		const context: VerbChannelContext = {
			mediaChannelId: aggregate.ariChannelId,
			channelId: aggregate.channelId,
			isTearingDown: aggregate.isTearingDown,
			hasMediaPath: aggregate.isAnswered,
		};

		const exit = await this.runtime.runPromiseExit((executor) => executor.dispatch(context, verb));
		if (Exit.isSuccess(exit)) {
			return true;
		}

		this.logger.warn(
			{ verb: verb.verb, channelId: aggregate.channelId, cause: Cause.pretty(exit.cause) },
			"verb execution failed",
		);
		return false;
	}

	// -------------------------------------------------------------------------------------------
	// Progress
	// -------------------------------------------------------------------------------------------

	private async onChannelStateChange(channel: AriChannel): Promise<void> {
		const aggregate = this.registry.byAriChannelId(channel.id);
		if (aggregate === undefined || aggregate.isTearingDown) {
			return;
		}

		const nextCallState = callStateFromAriChannelState(channel.state);
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
			const data = buildCdrLegWrite({
				snapshot: aggregate.snapshot,
				leg: "a",
				direction: callDirectionFrom(aggregate.snapshot.variables.OPTIMIQ_CALL_DIRECTION),
				hangupCause: input.cause,
				hangupCauseCode: input.causeCode,
				hangupSide: input.side,
				endedAt: input.endedAt,
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
		const names = ["OPTIMIQ_ORG_ID", "OPTIMIQ_CALL_DIRECTION", "OPTIMIQ_ROUTING_CONTEXT"];
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
