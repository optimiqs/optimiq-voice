import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { sipInviteRequestSchema, subjectFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type {
	CallDirection,
	SipInviteRefusalReason,
	SipInviteRequest,
	SipInviteResponse,
} from "@optimiq-voice/events";
import type { Subscription } from "nats";

/**
 * The queue group every engine instance joins.
 *
 * The subject is FLAT, exactly as `rpc.sip.v1.transfer` is and for a stronger version of the same
 * reason: an arriving INVITE belongs to no engine yet, so there is no owner to address and whichever
 * instance answers BECOMES the one holding the call. That makes this responder's shape the
 * `rpc.engine.v1.originate` one rather than the park-handoff one — no `wrong_instance` in the
 * vocabulary, because the question "did the right instance answer" cannot be asked about a call that
 * does not exist yet.
 *
 * The queue group is what makes "any instance" mean "exactly one instance". A plain subscription on
 * three engines would admit one INVITE three times, and the edge would act on whichever reply
 * arrived first while two other engines each held a `channels` claim, a routing walk and a CDR for a
 * call that only rang once.
 */
const SIP_INVITE_QUEUE_GROUP = "optimiq-engine-sip-invite";

/**
 * The routing contexts from which a trunk can be dialled.
 *
 * Not a guess: `ChannelOrchestrator.resolveRoute` branches on exactly these two strings. `outbound`
 * resolves straight against the tenant's outbound routes, and `internal` resolves against the
 * internal plan and then FALLS THROUGH to outbound when nothing matched — which is the feature that
 * lets a desk phone dial a mobile, and is therefore precisely the door an unauthenticated carrier
 * must never be admitted through. Anything else lands on `resolveInbound`, which resolves only
 * against the DID table and can reach nothing but this tenant's own numbers.
 *
 * A set rather than a list of `===` comparisons so that adding a third trunk-capable namespace is one
 * line here and cannot be forgotten at the check below.
 */
const TRUNK_CAPABLE_ROUTING_CONTEXTS: ReadonlySet<string> = new Set(["internal", "outbound"]);

/** What the call path did with an arriving INVITE. A refusal is data, never a throw. */
export type SipInviteAdmission =
	| {
			readonly kind: "admitted";
			/** The tenant the engine resolved. For a trunk INVITE this is what the edge is waiting for. */
			readonly orgId: string;
			/** The engine's call id — the token in `calls.evt.v1.<org>.<callId>.>`. */
			readonly callId: string;
			/**
			 * The engine's own DOMAIN leg id, which is NOT the wire leg id the reply echoes.
			 *
			 * The edge minted a leg id and the engine uses it as the media channel id — the string every
			 * registry, signal and claim is keyed by — exactly as click-to-call uses `originateId`. The
			 * domain leg id is then derived from it by `legIdForAriChannel`, because that derivation is
			 * what makes a leg id survive an engine restart and a failover onto another instance. So this
			 * field is for the log line and for a spec's assertions; the WIRE reply echoes what the edge
			 * sent, per the contract's own note that an echo is what stops a reply landing on the wrong
			 * leg.
			 */
			readonly legId: string;
			/** What the engine actually resolved in, when it narrowed what was asked for. */
			readonly routingContext?: string;
			readonly direction: CallDirection;
	  }
	| {
			readonly kind: "refused";
			readonly reason: SipInviteRefusalReason;
			readonly error: string;
	  };

/**
 * Whether the party sending an INVITE with `Replaces` may take over the dialog it named.
 *
 * A verdict and not a boolean, because "no" and "I cannot tell" must produce the same ANSWER and
 * different LOG LINES: both refuse, and only one of them is a security event.
 */
export type SipReplacesAuthorization =
	| {
			readonly kind: "authorized";
			/** The leg that will be taken out of the call, for the log and for the responder's reply. */
			readonly replacedLegId: string;
	  }
	| { readonly kind: "refused"; readonly error: string };

/**
 * What this responder needs from the call path, and nothing more.
 *
 * Two methods where `SipTransferCallPath` has four and `OriginateCallPath` has one, and the split is
 * the same one those two draw: the responder owns the WIRE (framing, validation, draining, the
 * toll-fraud boundary, the reply shape) and the call path owns the CALL. What is NOT delegated is
 * every check that can be made from the request alone, because those are the refusals a spec must be
 * able to reach without a media server anywhere near it.
 */
export interface SipInviteCallPath {
	/**
	 * Whether this INVITE's sender is entitled to replace the dialog its `Replaces` header named.
	 *
	 * **OPTIONAL, and absent means REFUSE — the opposite of `SipTransferCallPath.isDialableTarget`,
	 * which is an optional courtesy whose absence means "go ahead".** The difference is that this one
	 * is a GATE. An implementation that cannot answer the question has not established entitlement,
	 * and an unestablished entitlement is a refusal by the rule this file exists to enforce.
	 */
	authorizeReplaces?(request: SipInviteRequest): Promise<SipReplacesAuthorization>;
	/** Files the leg and starts its routing walk. Never throws; a failure is a `refused` admission. */
	admit(request: SipInviteRequest): Promise<SipInviteAdmission>;
}

/**
 * `rpc.sip.v1.invite` — the engine answering "will you take this call at all", asked by `apps/sipd`
 * with a `100 Trying` already on the wire and a caller holding a handset.
 *
 * ## Why admission is the one synchronous step
 *
 * A routing walk is not fast. A ring group rings for `ENGINE_DEFAULT_RING_TIMEOUT_SECONDS` and may
 * then fall through to voicemail, so a request-reply that returned the call's OUTCOME would need a
 * sixty-second deadline — and a request-reply with a sixty-second deadline is a subscription wearing
 * one's clothes on a transport with no redelivery. So exactly one step is synchronous and it decides
 * ADMISSION ONLY, answered with the tenant, the call id and the instance that took it. Everything
 * after it is asynchronous: `rpc.sip.v1.ring`, `rpc.sip.v1.answer` and the `sip.evt.v1` family.
 *
 * The precedent is one process away. `apps/sipd`'s own REFER handler sends `202 Accepted` BEFORE its
 * RPC, because RFC 3515 §2.4.2 makes accepting a REFER mean "I will try and I will tell you". An
 * INVITE is the same shape.
 *
 * ## Raw NATS, because the caller is Go
 *
 * The same obligation `SipTransferService` carries. `apps/sipd` marshals the generated
 * `SipInviteRequest` struct and nothing else, so a Nest `@MessagePattern` — which matches on a
 * `pattern` field the Go caller never sends — would leave every INVITE unanswered. And an unanswered
 * INVITE is not a quiet failure: the edge holds an INVITE server transaction until the caller's
 * Timer B, and the caller hears thirty-two seconds of nothing before a `503`.
 *
 * ## The toll-fraud check is the reason this responder exists ON THIS SIDE
 *
 * Everything else here could in principle have been decided at the edge. This could not.
 * `routingContext` is what the EDGE believes it may resolve in; sending it does not make it true, it
 * makes it CHECKABLE by the process that owns the dial plan. `apps/sipd` knows how the sender
 * authenticated — a digest against the realm's credentials, or a match on a trunk ACL — and the
 * engine knows which namespaces can reach a trunk. **An INVITE that authenticated by trunk ACL and
 * asks to resolve in a trunk-capable context is refused `not_permitted`,** which is the same division
 * of labour `rpc.sip.v1.transfer` uses when it puts the "is the referrer on this call" check here
 * because the edge cannot answer it. Asterisk enforced this today by having two dialplan contexts,
 * with the open-relay warning written in the sample configuration; on this plane it is a typed check
 * with a test, which is the upgrade.
 *
 * The check runs BEFORE anything is resolved, deliberately. Resolving reads the tenant's compiled
 * artifact, and doing that for a request that is about to be refused would let an unauthenticated
 * stranger probe a dial plan by timing — the identical ordering argument `SipTransferService` makes
 * for its own target check.
 *
 * ## An unattached call path is a real state, and it is a REFUSAL
 *
 * `ChannelOrchestrator` attaches one from its constructor, so a running engine always has it. What
 * does not is the window before Nest has built the calls module. Answering nothing would cost the
 * edge its whole one-second deadline and leave it to invent a `503` on its own authority; `internal`
 * with the reason spelled out becomes a `500` the operator can read, and — the part that matters —
 * is logged by the edge as a REFUSAL rather than as a timeout, which are two different incidents.
 */
@Injectable()
export class SipInviteService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = getLogger("engine.sip-invite");
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	private subscription: Subscription | undefined;
	private callPath: SipInviteCallPath | undefined;
	private draining = false;
	private served = 0;
	private admitted = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {}

	/** Whether this instance is answering INVITEs, and what it has done with them. */
	get stats(): {
		readonly listening: boolean;
		readonly served: number;
		readonly admitted: number;
	} {
		return {
			listening: this.subscription !== undefined,
			served: this.served,
			admitted: this.admitted,
		};
	}

	/** The subject this instance answers on. Exposed for the log line and for the specs. */
	get subject(): string {
		return subjectFor.sipInviteRpc();
	}

	/**
	 * Registers the call path. Pushed by the orchestrator from its own constructor, exactly as
	 * `SipTransferService.attach` and `OriginateService.attach` are, and for the same reason: pulling
	 * would be a Nest cycle between `NatsModule` and `CallsModule`.
	 */
	attach(callPath: SipInviteCallPath): void {
		this.callPath = callPath;
	}

	onApplicationBootstrap(): void {
		if (this.subscription !== undefined) {
			return;
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			this.logger.warn(
				"the engine has no NATS connection; calls arriving on the sip edge will not be admitted " +
					"by this instance",
			);
			return;
		}

		const subject = this.subject;
		this.subscription = connection.subscribe(subject, { queue: SIP_INVITE_QUEUE_GROUP });
		const subscription = this.subscription;

		void (async () => {
			for await (const message of subscription) {
				// Sequential, as with every other responder on this connection. Admission is a tenant
				// lookup and a claim write, both bounded, and the alternative — admitting concurrently
				// off one loop — would let a slow `did-index` read accumulate half-admitted calls nobody
				// is waiting for, on the one path an attacker controls the rate of.
				const reply = await this.answer(message.data);
				if (message.reply === undefined) {
					this.logger.warn({ subject }, "an invite arrived with no reply subject");
					continue;
				}
				message.respond(this.encoder.encode(JSON.stringify(reply)));
				this.served += 1;
				if (reply.ok) {
					this.admitted += 1;
				}
			}
			if (!this.draining) {
				this.logger.warn({ subject }, "the sip invite subscription ended unexpectedly");
			}
		})();

		this.logger.info(
			{ subject, queue: SIP_INVITE_QUEUE_GROUP, instanceId: this.env.ENGINE_INSTANCE_ID },
			"admitting calls arriving on the sip edge",
		);
	}

	onApplicationShutdown(): void {
		this.draining = true;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
	}

	// -------------------------------------------------------------------------------------------

	/** Decodes one request and produces the reply. NEVER throws — a throw would end the loop. */
	private async answer(data: Uint8Array): Promise<SipInviteResponse> {
		let request: SipInviteRequest;
		try {
			request = sipInviteRequestSchema.parse(JSON.parse(this.decoder.decode(data)) as unknown);
		} catch (error) {
			// No leg id to echo, because the bytes that would have carried one are the bytes that did
			// not parse. The edge maps this to `400 Bad Request` and the caller learns their INVITE was
			// malformed rather than that we are down.
			return this.refuse("", "bad_request", String(error));
		}

		if (this.draining) {
			// `shutting_down` and not `congestion`, and the difference is on the wire: the edge answers
			// this one with `503` plus a `Retry-After`, and that header is what makes a carrier fail
			// OVER to another route instead of retrying into a pod that is closing.
			return this.refuse(request.legId, "shutting_down", "this engine instance is draining");
		}

		const callPath = this.callPath;
		if (callPath === undefined) {
			return this.refuse(
				request.legId,
				"internal",
				"this engine has no call path attached yet, so it cannot admit a call",
			);
		}

		// The toll-fraud boundary, checked before anything is resolved. See the class note.
		if (
			request.authentication === "trunk-acl" &&
			TRUNK_CAPABLE_ROUTING_CONTEXTS.has(request.routingContext)
		) {
			this.logger.warn(
				{
					legId: request.legId,
					sourceAddress: request.sourceAddress,
					trunkId: request.trunkId,
					routingContext: request.routingContext,
					dialed: request.to.number,
				},
				"refusing a trunk-authenticated INVITE that asked to resolve in a trunk-capable context",
			);
			return this.refuse(
				request.legId,
				"not_permitted",
				`a trunk-acl INVITE may not resolve in the ${request.routingContext} context`,
			);
		}

		if (request.replaces !== undefined) {
			const verdict = await this.authorizeReplaces(callPath, request);
			if (verdict !== undefined) {
				return verdict;
			}
		}

		let admission: SipInviteAdmission;
		try {
			admission = await callPath.admit(request);
		} catch (error) {
			// The call path documents that it does not throw. This is the defect path, and it is a
			// refusal rather than a rethrow because the loop above must survive it: one bad INVITE must
			// not stop this instance answering every later one.
			this.logger.error(
				{ legId: request.legId, orgId: request.orgId, err: String(error) },
				"the sip invite call path threw",
			);
			return this.refuse(request.legId, "internal", String(error));
		}

		if (admission.kind === "refused") {
			this.logger.info(
				{
					legId: request.legId,
					orgId: request.orgId,
					dialed: request.to.number,
					authentication: request.authentication,
					reason: admission.reason,
				},
				"refused an arriving call",
			);
			return this.refuse(request.legId, admission.reason, admission.error);
		}

		this.logger.info(
			{
				legId: request.legId,
				engineLegId: admission.legId,
				orgId: admission.orgId,
				callId: admission.callId,
				from: request.from.number,
				dialed: request.to.number,
				authentication: request.authentication,
				sipCallId: request.sipCallId,
			},
			"admitted a call arriving on the sip edge",
		);
		return {
			ok: true,
			// The WIRE leg id, echoed. See `SipInviteAdmission.legId` for why it is not the engine's.
			legId: request.legId,
			orgId: admission.orgId,
			callId: admission.callId,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			...(admission.routingContext === undefined
				? {}
				: { routingContext: admission.routingContext }),
			direction: admission.direction,
		};
	}

	/**
	 * The RFC 3891 `Replaces` gate.
	 *
	 * ## Why a refusal is the only safe default, and what the two wrong answers cost
	 *
	 * A `Replaces` says "put me into that call and take that dialog out of it". Two things about it
	 * are true at once: the EDGE authenticated the sender and can see that it holds the named dialog,
	 * and the edge cannot see who is a PARTY to the call that dialog belongs to — the engine holds the
	 * bridge, the peer and the tenant. So the authorization question is the engine's, for exactly the
	 * reason `sipTransferRequestSchema` gives for putting "is the referrer on this call" here, and the
	 * contract says so in as many words: "present is not permission".
	 *
	 * There were two tempting wrong answers.
	 *
	 * **Downgrading to "allow".** An attended transfer completes by REPLACING a dialog: the party that
	 * gets replaced is hung up and the party on the other side of it is handed to somebody new. A
	 * `Replaces` honoured without checking entitlement is therefore a way for any authenticated
	 * extension that can guess a `Call-ID` and two tags to insert itself into a conversation it is not
	 * on, and to eject the person who was. That is a call-hijack primitive, and it is worse than the
	 * REFER equivalent this codebase already refuses, because a REFER at least moves a call the
	 * referrer was on.
	 *
	 * **Silently dropping the `Replaces` and treating it as an ordinary call.** Strictly worse than
	 * refusing, and it is the failure that would actually ship, because it LOOKS like it works. The
	 * new INVITE gets routed as a fresh call, the transferor's consultation leg is never taken out of
	 * anything, and the user who pressed TRANSFER is left holding a call they believe they handed off
	 * while the transferee rings a second time. Two live legs, one abandoned party, and nothing in the
	 * logs that says a transfer was attempted. RFC 3891 §3 is explicit that a UAS which cannot honour
	 * the header must respond `481` or `501` rather than ignore it — an implementation that ignores it
	 * is not a lenient one, it is a broken one.
	 *
	 * So: `not_permitted` — `403 Forbidden` on the wire — whenever entitlement cannot be ESTABLISHED,
	 * which includes the case where nothing on this instance can even ask the question. The refusal is
	 * honest at the caller too: the transferring phone learns immediately that the transfer failed and
	 * can recover the consultation, which is exactly what a `403` to a `Replaces` INVITE means.
	 *
	 * @returns the refusal to send, or `undefined` when the request may proceed to admission.
	 */
	private async authorizeReplaces(
		callPath: SipInviteCallPath,
		request: SipInviteRequest,
	): Promise<SipInviteResponse | undefined> {
		if (callPath.authorizeReplaces === undefined) {
			return this.refuse(
				request.legId,
				"not_permitted",
				"this engine cannot establish entitlement to replace a dialog, and an unestablished " +
					"entitlement is a refusal",
			);
		}
		if (request.replacesLegId === undefined) {
			// The edge resolved the triple against its own dialogs and found nothing, or did not look.
			// Either way the engine has no leg to check anybody against — and re-deriving one from the
			// `Call-ID` would be answering a question about a dialog whose owner already said it does
			// not hold it.
			return this.refuse(
				request.legId,
				"not_permitted",
				"the Replaces header named a dialog the sip edge could not resolve to a leg",
			);
		}

		let verdict: SipReplacesAuthorization;
		try {
			verdict = await callPath.authorizeReplaces(request);
		} catch (error) {
			this.logger.error(
				{ legId: request.legId, replacesLegId: request.replacesLegId, err: String(error) },
				"authorising a Replaces threw",
			);
			// `internal` and not `not_permitted`: the difference between "we decided no" and "we could
			// not decide" is the difference between a policy the operator wrote and a bug they need to
			// see, and flattening the second into the first is how a defect hides behind a `403`.
			return this.refuse(request.legId, "internal", String(error));
		}

		if (verdict.kind === "refused") {
			this.logger.warn(
				{
					legId: request.legId,
					replacesLegId: request.replacesLegId,
					replacesCallId: request.replaces?.callId,
					from: request.from.number,
					authentication: request.authentication,
				},
				"refusing an INVITE with Replaces: entitlement to the named dialog was not established",
			);
			return this.refuse(request.legId, "not_permitted", verdict.error);
		}

		this.logger.info(
			{ legId: request.legId, replacedLegId: verdict.replacedLegId, from: request.from.number },
			"authorised an INVITE with Replaces",
		);
		return undefined;
	}

	private refuse(legId: string, reason: SipInviteRefusalReason, error: string): SipInviteResponse {
		return {
			ok: false,
			legId,
			// Present on a refusal too, and the contract says so: the edge logs which engine declined,
			// and on a queue-grouped subject that is the only way an operator learns WHICH replica is
			// refusing every call in the fleet.
			instanceId: this.env.ENGINE_INSTANCE_ID,
			reason,
			error: error.slice(0, 512),
		};
	}
}
