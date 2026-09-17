import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import { AUTHORIZE_OUTBOUND_RPC, authorizeOutboundResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type {
	TollFraudGuardPort,
	TollFraudGuardRequest,
	TollFraudGuardVerdict,
} from "./toll-fraud-guard";
import type { ClientProxy } from "@nestjs/microservices";
import type { AuthorizeOutboundRequest } from "@optimiq-voice/events";

/**
 * The spend/velocity/geo gate, answered by the API over `rpc.pbx.v1.authorize-outbound`.
 *
 * ## Why an RPC and not a local check
 *
 * Two of the three inputs live where the engine cannot reach them. The ceilings are on `orgLimit`'s
 * neighbours in `pbx-db`, the rolling counters are rows in `shared_rate_window`, and the
 * "has this tenant ever called this country" fact is a row this very call is about to write — so
 * the decision has to happen inside a transaction on that database. The engine holds no handle on
 * it, by design, exactly as it does not for `extension-feature`.
 *
 * ## It FAILS OPEN, and that is the argument worth reading
 *
 * A timeout, a missing responder, a malformed reply: all of them allow the call. The reasoning is
 * the same one the deadline is set from — this sits between the dial-plan walk and the first INVITE,
 * on the caller's silence — and the failure being guarded against is a database that is unwell. An
 * API outage that also barred every international call for every tenant would convert a degraded
 * control plane into a total outbound outage, which is a strictly worse incident than the one this
 * gate exists to make less likely. A refusal is a DECISION and only ever arrives as `allowed: false`.
 *
 * The counters are the reason this is honest rather than merely convenient: they are incremented by
 * the responder, so a call allowed by a failure is also a call the ceiling never counted. That is a
 * bounded overshoot for the duration of the fault, not a hole an attacker can hold open — a
 * responder that is answering is a responder that is counting.
 */
@Injectable()
export class TollFraudGuardRpcPort implements TollFraudGuardPort {
	private readonly logger = getLogger("engine.toll-fraud");
	private calls = 0;
	private refusals = 0;
	private failures = 0;

	constructor(@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy) {}

	/** Counters, on the same terms as the other RPC ports': read by the specs and by health. */
	get stats(): {
		readonly calls: number;
		readonly refusals: number;
		readonly failures: number;
	} {
		return { calls: this.calls, refusals: this.refusals, failures: this.failures };
	}

	async authorize(request: TollFraudGuardRequest): Promise<TollFraudGuardVerdict> {
		this.calls += 1;
		const payload: AuthorizeOutboundRequest = {
			orgId: request.organizationId,
			...(request.extensionNumber === undefined
				? {}
				: { extensionNumber: request.extensionNumber }),
			dialedNumber: request.dialedNumber,
			// The engine's clock, so a delayed request is still judged against the instant the CALL
			// happened. Only the off-hours window reads it.
			at: new Date(request.now).toISOString(),
		};

		try {
			// Parsed, not trusted: the responder is another process on another release, and a
			// malformed reply must become "allow" rather than a refusal nobody can explain.
			const reply = authorizeOutboundResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(AUTHORIZE_OUTBOUND_RPC.subject, payload)
						.pipe(timeout(AUTHORIZE_OUTBOUND_RPC.timeoutMs)),
				),
			);
			if (reply.allowed) {
				return { kind: "allow" };
			}
			this.refusals += 1;
			return {
				kind: "refuse",
				reason: reply.reason ?? "TOLL_FRAUD_REFUSED",
				detail: reply.detail ?? "this call was refused by the organization's fraud controls",
			};
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{
					organizationId: request.organizationId,
					dialedNumber: request.dialedNumber,
					err: String(error),
				},
				"rpc.pbx.v1.authorize-outbound did not answer; the call proceeds unchecked",
			);
			return { kind: "allow" };
		}
	}
}
