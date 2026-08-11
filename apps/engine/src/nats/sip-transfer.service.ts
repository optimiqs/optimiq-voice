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
	/** The orchestrator's own index. `CallControlBinding.legFor`, unchanged. */
	legFor(mediaChannelId: string): ControlledLeg | undefined;
	/** `CallControlPort.transfer`, unchanged. This responder adds no transfer semantics of its own. */
	transfer(leg: ControlledLeg, request: TransferRequest): Promise<CallControlResult>;
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
 * ## The one thing that is NOT wired, and why it is a refusal rather than a stub
 *
 * Resolving a SIP `Call-ID` onto a live channel is impossible in this engine today. Nothing records
 * it: the ARI driver reads four channel variables (`ENGINE_CHANNEL_VARIABLES`) and none of them is
 * the `Call-ID`, `CallerProfile` has no field for it, and `channelCreatedDataSchema.sipCallId` — the
 * one place in the contract where it appears — is optional and never populated. So
 * {@link SipTransferCallPath.resolveDialog} has no implementation in `apps/engine/src/calls`, and
 * until it does, every well-formed request is answered `correlation_unavailable`.
 *
 * That is deliberately a REFUSAL and not a silence and not a success. A silence costs the edge its
 * whole deadline and tells it nothing; a pretend success would have `apps/sipd` send the phone
 * `SIP/2.0 200 OK` in the NOTIFY sipfrag for a transfer that never happened, which is the worst of
 * the three — the user watches the call stay exactly where it was while their handset says it moved.
 * A named refusal makes the transfer key fail visibly, and names the missing piece in the log.
 *
 * Everything above and below that one call is real and exercised: framing, validation, the
 * attended-transfer refusal, the tenant and participation checks, the delegation to `transfer`, and
 * the reply shape. Attaching a resolver is the whole remaining change.
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
	 *
	 * Nothing calls this today. See the class note.
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

		// Checked before anything is resolved, because the answer does not depend on the dialog: this
		// engine cannot join two dialogs it never brokered, whichever call the Call-ID names.
		if (request.kind === "attended" || request.replaces !== undefined) {
			return this.refuse(
				request.sipCallId,
				"attended_unsupported",
				"this engine cannot honour a Replaces from a consultation it did not broker",
			);
		}

		const callPath = this.callPath;
		if (callPath === undefined) {
			return this.refuse(
				request.sipCallId,
				"correlation_unavailable",
				"this engine does not index SIP Call-IDs, so it cannot find the call a REFER names",
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
