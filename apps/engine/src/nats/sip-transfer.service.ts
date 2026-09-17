import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { sipTransferRequestSchema, subjectFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { CallControlResult, ControlledLeg, TransferRequest } from "../calls/call-control";
import type { EngineEnv } from "../config/engine-env";
import type {
	SipTransferRequest,
	SipTransferResponse,
	SipTransferRefusalReason,
} from "@optimiq-voice/events";
import type { Subscription } from "nats";

/**
 * The queue group every engine instance joins.
 *
 * Unlike `rpc.engine.v1.park-handoff`, this subject is FLAT — `apps/sipd` has no idea which engine
 * holds a given call, and nothing in the taxonomy tells it. A queue group is therefore the only
 * arrangement that produces exactly one reply: a plain subscription on N instances would answer one
 * request N times and the edge would act on whichever arrived first, which is not necessarily the
 * one that knows anything.
 *
 * The cost is stated plainly in `SIP_TRANSFER_REFUSAL_REASONS.wrong_instance`: with more than one
 * engine, the instance the broker picks may not be the one holding the leg, and it cannot currently
 * tell that apart from a call that has ended. Closing that needs a dialog directory in KV, the same
 * shape as `park-claims`. Named in the contract, not built here.
 */
const SIP_TRANSFER_QUEUE_GROUP = "optimiq-engine-sip-transfer";

/**
 * What this responder needs from the call path, and nothing more.
 *
 * Three methods rather than a reference to `CallControl` or to `ChannelOrchestrator`, for two
 * reasons. The narrow one: a spec can supply all three in ten lines and drive every refusal branch
 * without a media server. The load-bearing one: `apps/engine/src/calls` is a separate concern with
 * its own owner, and a responder that reached into it would couple the broker surface to the shape
 * of the orchestrator's private registry.
 *
 * {@link resolveDialog} is the half that does not exist yet — see the class note.
 */
export interface SipTransferCallPath {
	/**
	 * Resolve the SIP dialog a REFER arrived in onto the media channel carrying it, or `undefined`
	 * when this instance holds no such call.
	 *
	 * The request carries the SIP `Call-ID` and the dialog tags verbatim, because that is genuinely
	 * all the SIP edge has: it is a registrar, not a B2BUA, and it is not in the media path.
	 */
	resolveDialog(request: SipTransferRequest): Promise<string | undefined>;
	/**
	 * Resolve the dialog a `Replaces` NAMED — the consultation the transferor is holding — onto the
	 * media channel carrying it.
	 *
	 * Separate from {@link resolveDialog} because it answers about a different call, and OPTIONAL
	 * because a call path that cannot resolve one is a call path that cannot honour an attended
	 * transfer at all: absent, every `Replaces` is still refused `attended_unsupported`, which is
	 * what this responder did before either of these existed.
	 */
	resolveReplacedDialog?(request: SipTransferRequest): Promise<string | undefined>;
	/** The orchestrator's own index. `CallControlBinding.legFor`, unchanged. */
	legFor(mediaChannelId: string): ControlledLeg | undefined;
	/**
	 * Whether `destination` resolves to something dialable in this leg's tenant plan.
	 *
	 * Asked BEFORE the transfer, which is the whole point. A blind transfer is destructive by
	 * construction: `CallControl` hangs the transferor up and re-routes the transferee, so a
	 * destination that turns out to match nothing costs the caller their call and reports
	 * `transfer_failed` for what is really a typo on a keypad. Resolving first turns that into
	 * `unknown_target` with both parties still talking to each other.
	 *
	 * Optional because it is an authorisation-adjacent nicety and not the contract: an implementation
	 * that cannot cheaply resolve a plan may omit it, and every such transfer is then attempted and
	 * refused after the fact, exactly as it was before this existed.
	 */
	isDialableTarget?(leg: ControlledLeg, destination: string): Promise<boolean>;
	/** `CallControlPort.transfer`, unchanged. This responder adds no transfer semantics of its own. */
	transfer(leg: ControlledLeg, request: TransferRequest): Promise<CallControlResult>;
	/**
	 * `CallControlPort.completeAttendedRefer` — join the two calls the transferor is holding.
	 *
	 * Optional for the same reason {@link resolveReplacedDialog} is, and the two travel together: a
	 * call path that supplies one and not the other cannot complete an attended transfer either, and
	 * is answered `attended_unsupported` exactly as an unattached one is.
	 */
	completeAttendedTransfer?(
		transferor: ControlledLeg,
		consultation: ControlledLeg,
		destination: string,
	): Promise<CallControlResult>;
}

/**
 * `rpc.sip.v1.transfer` — the engine answering a desk phone's REFER, relayed by `apps/sipd`.
 *
 * ## Why the engine needs this at all
 *
 * `CallControl.transfer` already exists and already does both kinds. What it lacks is a way to be
 * ASKED by a telephone: it is driven by mid-call DTMF feature codes, which reach the engine because
 * the engine is in the media path. A REFER does not — it is signalling, and signalling terminates at
 * the SIP edge. This class is the other end of the wire the edge needs, and it deliberately
 * implements no transfer logic: it authorises, then delegates.
 *
 * ## Raw NATS, because the caller is Go
 *
 * The same obligation as `rpc.media.v1.*` with the languages reversed. `apps/sipd` marshals the
 * generated `SipTransferRequest` struct and nothing else, so a Nest `@MessagePattern` — which
 * matches on a `pattern` field the Go caller never sends — would leave every REFER unanswered and
 * every desk phone's transfer key timing out. Served on `JetStreamService.rawConnection`, exactly as
 * `ParkHandoffService` is.
 *
 * ## An unattached call path is still a real state
 *
 * `ChannelOrchestrator` attaches one from its constructor, so a running engine always has it. What
 * does NOT is the window before Nest has built the calls module, and any deployment where the media
 * driver cannot read a `Call-ID` at all. Both answer `correlation_unavailable`, which is deliberately
 * a REFUSAL and not a silence and not a success: a silence costs the edge its whole deadline and
 * tells it nothing, and a pretend success would have `apps/sipd` send the phone `SIP/2.0 200 OK` in
 * the NOTIFY sipfrag for a transfer that never happened — the user watches the call stay exactly
 * where it was while their handset says it moved. A named refusal fails the transfer key visibly.
 *
 * ## `wrong_instance` is still reserved
 *
 * The orchestrator's index is per-process, so an instance that answers a REFER for a call another
 * instance holds looks up nothing and says `unknown_dialog` — the same thing it says for a call that
 * ended. Telling the two apart needs a dialog directory in KV, the same shape as `park-claims`, and
 * that is not built here. On a single-engine deployment the two are the same answer; on several, a
 * desk phone's transfer key is best-effort until the directory exists.
 */
@Injectable()
export class SipTransferService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = getLogger("engine.sip-transfer");
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	private subscription: Subscription | undefined;
	private callPath: SipTransferCallPath | undefined;
	private draining = false;
	private served = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {}

	/** Whether this instance is answering REFERs, and how many it has answered. */
	get stats(): { readonly listening: boolean; readonly served: number } {
		return { listening: this.subscription !== undefined, served: this.served };
	}

	/** The subject this instance answers on. Exposed for the log line and for the specs. */
	get subject(): string {
		return subjectFor.sipTransferRpc();
	}

	/**
	 * Registers the call path. Modelled on `ParkHandoffService.setHandler`, and for the same reason:
	 * the orchestrator constructs itself long after this provider does, so it pushes rather than this
	 * class pulling — which would be a Nest cycle between `NatsModule` and `CallsModule`.
	 */
	attach(callPath: SipTransferCallPath): void {
		this.callPath = callPath;
	}

	onApplicationBootstrap(): void {
		if (this.subscription !== undefined) {
			return;
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			this.logger.warn(
				"the engine has no NATS connection; desk-phone transfer keys will not work on this instance",
			);
			return;
		}

		const subject = this.subject;
		this.subscription = connection.subscribe(subject, { queue: SIP_TRANSFER_QUEUE_GROUP });
		const subscription = this.subscription;

		void (async () => {
			for await (const message of subscription) {
				// Sequential, as with park handoffs: a REFER moves a call, and two of them interleaved
				// on one leg is a race whose cost is a caller bridged to the wrong person.
				const reply = await this.answer(message.data);
				if (message.reply === undefined) {
					this.logger.warn({ subject }, "a sip transfer arrived with no reply subject");
					continue;
				}
				message.respond(this.encoder.encode(JSON.stringify(reply)));
				this.served += 1;
			}
			if (!this.draining) {
				this.logger.warn({ subject }, "the sip transfer subscription ended unexpectedly");
			}
		})();

		this.logger.info(
			{ subject, queue: SIP_TRANSFER_QUEUE_GROUP, instanceId: this.env.ENGINE_INSTANCE_ID },
			"answering sip transfers relayed from the sip edge",
		);
	}

	onApplicationShutdown(): void {
		this.draining = true;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
	}

	// -------------------------------------------------------------------------------------------

	/** Decodes one request and produces the reply. NEVER throws — a throw would end the loop. */
	private async answer(data: Uint8Array): Promise<SipTransferResponse> {
		let request: SipTransferRequest;
		try {
			request = sipTransferRequestSchema.parse(JSON.parse(this.decoder.decode(data)) as unknown);
		} catch (error) {
			return this.refuse("", "bad_request", String(error));
		}

		if (this.draining) {
			return this.refuse(request.sipCallId, "shutting_down", "this engine instance is draining");
		}

		const attended = request.kind === "attended" || request.replaces !== undefined;
		if (attended && request.replaces === undefined) {
			// RFC 3891 is the whole of what makes an attended transfer nameable. A REFER that says it
			// is attended and carries no `Replaces` names no consultation, so there is nothing to join
			// and nothing to guess.
			return this.refuse(
				request.sipCallId,
				"bad_request",
				"an attended transfer carried no Replaces, so it names no consultation",
			);
		}

		const callPath = this.callPath;
		if (callPath === undefined) {
			return this.refuse(
				request.sipCallId,
				"correlation_unavailable",
				"no call path is attached to this instance, so it cannot look a SIP Call-ID up at all",
			);
		}
		// Checked before anything is resolved, because the answer does not depend on the dialog: a
		// call path that cannot resolve a `Replaces` cannot honour one, whichever call it names.
		if (
			attended &&
			(callPath.resolveReplacedDialog === undefined ||
				callPath.completeAttendedTransfer === undefined)
		) {
			return this.refuse(
				request.sipCallId,
				"attended_unsupported",
				"this call path cannot join the two dialogs a Replaces names",
			);
		}

		let mediaChannelId: string | undefined;
		try {
			mediaChannelId = await callPath.resolveDialog(request);
		} catch (error) {
			this.logger.error({ err: String(error) }, "resolving a sip dialog threw");
			return this.refuse(request.sipCallId, "internal", String(error));
		}
		if (mediaChannelId === undefined) {
			return this.refuse(
				request.sipCallId,
				"unknown_dialog",
				"no live call on this instance matches that Call-ID",
			);
		}

		const leg = callPath.legFor(mediaChannelId);
		if (leg === undefined || leg.isTearingDown) {
			return this.refuse(
				request.sipCallId,
				"channel_gone",
				"the leg went away between resolving the dialog and moving it",
			);
		}

		// The tenant, then the person. `orgId` is trustworthy — the edge took it from the credential
		// the digest exchange resolved — but the Call-ID is a string the phone chose, so a resolution
		// that lands in another tenant is a cross-tenant reach and not a mistake.
		if (leg.organizationId !== request.orgId) {
			return this.refuse(
				request.sipCallId,
				"not_permitted",
				"that call belongs to another organization",
			);
		}
		if (!isReferrerOnLeg(leg, request.referredBy.username)) {
			return this.refuse(
				request.sipCallId,
				"not_permitted",
				"the referrer is not a party to that call",
				leg,
			);
		}

		if (attended) {
			return await this.completeAttended(request, callPath, leg);
		}

		// Last, after the leg is known to be ours and the referrer's: resolving a destination reads the
		// tenant's compiled artifact, and doing that for a Call-ID that turned out to belong to
		// somebody else would let an unauthorised request probe another tenant's dial plan by timing.
		if (callPath.isDialableTarget !== undefined) {
			let dialable: boolean;
			try {
				dialable = await callPath.isDialableTarget(leg, request.target.user);
			} catch (error) {
				this.logger.error({ err: String(error) }, "resolving a sip transfer target threw");
				return this.refuse(request.sipCallId, "internal", String(error), leg);
			}
			if (!dialable) {
				return this.refuse(
					request.sipCallId,
					"unknown_target",
					`nothing in this organization's plan answers ${request.target.user}`,
					leg,
				);
			}
		}

		let result: CallControlResult;
		try {
			// Blind, and only blind: the attended path returned above. No `context` — `CallControl`
			// defaults it to the internal routing namespace, which is the toll-fraud boundary and not
			// something a request off the SIP edge may choose.
			result = await callPath.transfer(leg, { kind: "blind", destination: request.target.user });
		} catch (error) {
			this.logger.error({ err: String(error) }, "a sip transfer threw");
			return this.refuse(request.sipCallId, "internal", String(error), leg);
		}

		if (!result.ok) {
			return this.refuse(request.sipCallId, "transfer_failed", result.reason, leg);
		}

		this.logger.info(
			{
				sipCallId: request.sipCallId,
				legId: leg.legId,
				destination: request.target.user,
				referredBy: request.referredBy.username,
			},
			"transferred a call on a desk phone's REFER",
		);
		return {
			ok: true,
			sipCallId: request.sipCallId,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			legId: leg.legId,
			callId: leg.callId,
			destination: request.target.user,
		};
	}

	/**
	 * The attended half: resolve the consultation the `Replaces` named, authorise it on its own
	 * terms, and ask the call path to join the two calls.
	 *
	 * ## What authorises this, given the engine cannot match the tags
	 *
	 * RFC 3891's model is that the `Replaces` triple is a shared secret, and the process that can
	 * match all three is `apps/sipd` — the engine indexes a `Call-ID` and nothing else, which
	 * `authorizeInviteReplaces` in the orchestrator says at length. On THIS path the engine does not
	 * need the triple, because it has something stronger: the REFER was digest-authenticated at the
	 * edge, and the referrer is checked to be a party to BOTH calls — the one being transferred and
	 * the consultation being handed over. A phone that guessed a `Call-ID` it is not on is refused by
	 * that check, tags or no tags.
	 *
	 * `isDialableTarget` is deliberately NOT consulted. A blind transfer dials the `Refer-To` and a
	 * destination that resolves to nothing costs the caller their call; here the target is already
	 * answered and talking, so the dial plan has no say in whether the two may be joined, and asking
	 * it would refuse a legitimate transfer to anything that is reachable but not dialable.
	 */
	private async completeAttended(
		request: SipTransferRequest,
		callPath: SipTransferCallPath,
		leg: ControlledLeg,
	): Promise<SipTransferResponse> {
		const replaces = request.replaces;
		const resolveReplaced = callPath.resolveReplacedDialog;
		const complete = callPath.completeAttendedTransfer;
		if (replaces === undefined || resolveReplaced === undefined || complete === undefined) {
			// Unreachable: `answer` refuses both of these before it gets here. Narrowed rather than
			// asserted, because an assertion on this path would end the subscription loop.
			return this.refuse(request.sipCallId, "attended_unsupported", "no attended transfer path");
		}

		let consultationMediaChannelId: string | undefined;
		try {
			consultationMediaChannelId = await resolveReplaced(request);
		} catch (error) {
			this.logger.error({ err: String(error) }, "resolving a replaced sip dialog threw");
			return this.refuse(request.sipCallId, "internal", String(error), leg);
		}
		if (consultationMediaChannelId === undefined) {
			return this.refuse(
				request.sipCallId,
				"unknown_dialog",
				"no live call on this instance matches the Call-ID the Replaces named",
				leg,
			);
		}

		const consultation = callPath.legFor(consultationMediaChannelId);
		if (consultation === undefined || consultation.isTearingDown) {
			// The ordinary race: the consulted party hung up between the phone sending the REFER and
			// this request being served. The original call is untouched, and the phone can consult
			// again.
			return this.refuse(
				request.sipCallId,
				"channel_gone",
				"the consultation ended before the transfer could be completed",
				leg,
			);
		}
		if (consultation.organizationId !== request.orgId) {
			return this.refuse(
				request.sipCallId,
				"not_permitted",
				"the consultation belongs to another organization",
				leg,
			);
		}
		if (!isReferrerOnLeg(consultation, request.referredBy.username)) {
			return this.refuse(
				request.sipCallId,
				"not_permitted",
				"the referrer is not a party to the consultation",
				leg,
			);
		}
		if (replaces.earlyOnly && consultation.isAnswered) {
			// RFC 3891 §3. The same rule the INVITE path honours, and for the same reason: a phone
			// that said "only if it has not connected" must not have a confirmed call replaced by a
			// race it lost.
			return this.refuse(
				request.sipCallId,
				"not_permitted",
				"the Replaces carried early-only and the dialog it named is already confirmed",
				leg,
			);
		}

		let result: CallControlResult;
		try {
			result = await complete(leg, consultation, request.target.user);
		} catch (error) {
			this.logger.error({ err: String(error) }, "an attended sip transfer threw");
			return this.refuse(request.sipCallId, "internal", String(error), leg);
		}
		if (!result.ok) {
			// Every refusal from the call path leaves both calls up. `transfer_failed` is the reason
			// the edge turns into a failing NOTIFY, which is what puts the transferring phone back in
			// charge of a consultation it is still on.
			return this.refuse(request.sipCallId, "transfer_failed", result.reason, leg);
		}

		this.logger.info(
			{
				sipCallId: request.sipCallId,
				legId: leg.legId,
				consultationLegId: consultation.legId,
				destination: request.target.user,
				referredBy: request.referredBy.username,
			},
			"completed an attended transfer on a phone's REFER with Replaces",
		);
		return {
			ok: true,
			sipCallId: request.sipCallId,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			legId: leg.legId,
			callId: leg.callId,
			destination: request.target.user,
		};
	}

	private refuse(
		sipCallId: string,
		reason: SipTransferRefusalReason,
		error: string,
		leg?: ControlledLeg,
	): SipTransferResponse {
		return {
			ok: false,
			sipCallId,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			...(leg === undefined ? {} : { legId: leg.legId, callId: leg.callId }),
			reason,
			error,
		};
	}
}

/**
 * Whether the authenticated referrer is actually on this leg.
 *
 * Both directions count, and they are different fields. A call the extension PLACED carries its
 * number as the caller id; a call it ANSWERED is a B-leg dialled TO it, so its number is the
 * destination. Checking only one of the two would refuse every transfer in one direction, which is
 * exactly half of them.
 *
 * This is a coarse check by design. It is a guard against a phone naming somebody else's `Call-ID`,
 * not an identity system — the identity was established by the digest exchange at the edge, and this
 * only asks whether that identity has any business with this leg.
 */
function isReferrerOnLeg(leg: ControlledLeg, username: string): boolean {
	return leg.callerIdNumber === username || leg.destinationNumber === username;
}
