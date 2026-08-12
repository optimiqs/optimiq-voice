import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import { LAST_CALLER_RPC, lastCallerResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type { LastCallerLookup, LastCallerResult, LastCallerSource } from "./plan-walker";
import type { ClientProxy } from "@nestjs/microservices";
import type { LastCallerRequest } from "@optimiq-voice/events";

/**
 * `*69` — who rang this extension last, over `rpc.pbx.v1.last-caller`.
 *
 * ## Why the engine does not keep its own "last caller" bucket
 *
 * It sees every inbound leg, so it could. It should not: that bucket would be a second copy of a
 * fact `cdr-db.call_legs` already stores durably, it would be empty after a restart or a rebalance,
 * and it would have to be written on the CALL PATH for a feature somebody presses once a week. The
 * ledger is already indexed on `(organization_id, to_number)` and partitioned by `started_at`, so
 * the answer is one bounded seek in the process that owns it.
 *
 * FreeSWITCH backs `*69` with its own key-value store. This is the same fact, sourced from the
 * record that was going to be written anyway.
 *
 * ## `found: false` covers the failures as well as the empty window
 *
 * The two are the same fact to a caller: there is nobody to dial. `reason` separates them for the
 * log, which is where the difference actually matters — "the ledger is unreachable" is an operator's
 * problem and "nobody called you this week" is not a problem at all.
 */
@Injectable()
export class LastCallerRpcSource implements LastCallerSource {
	private readonly logger = getLogger("engine.features");
	private calls = 0;
	private failures = 0;

	constructor(@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy) {}

	/** Call counters, on the same terms as the mailbox source's: read by the specs, and available
	 * to a health surface that wants to see whether the responder is answering at all. */
	get stats(): { readonly calls: number; readonly failures: number } {
		return { calls: this.calls, failures: this.failures };
	}

	async lookup(request: LastCallerLookup): Promise<LastCallerResult> {
		this.calls += 1;
		const payload: LastCallerRequest = {
			orgId: request.organizationId,
			extensionNumber: request.extensionNumber,
			// The contract's own default. Sent explicitly rather than omitted so the window a call was
			// answered from is visible in a broker trace instead of being a fact only the responder holds.
			withinHours: lastCallerResponseWindowHours,
			...(request.callId === undefined ? {} : { callId: request.callId }),
		};

		try {
			const reply = lastCallerResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(LAST_CALLER_RPC.subject, payload)
						.pipe(timeout(LAST_CALLER_RPC.timeoutMs)),
				),
			);
			if (!reply.found) {
				this.failures += 1;
			}
			return {
				found: reply.found,
				...(reply.callerNumber === undefined ? {} : { callerNumber: reply.callerNumber }),
				...(reply.callerName === undefined ? {} : { callerName: reply.callerName }),
				...(reply.at === undefined ? {} : { at: reply.at }),
				...(reply.reason === undefined ? {} : { reason: reply.reason }),
			};
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{
					organizationId: request.organizationId,
					extensionNumber: request.extensionNumber,
					err: String(error),
				},
				"rpc.pbx.v1.last-caller did not answer; the return call is announced as unavailable",
			);
			return { found: false, reason: "the call ledger service did not answer" };
		}
	}
}

/**
 * One week, which is the contract's own default for `withinHours`.
 *
 * Not an environment knob, and deliberately: the bound exists because `call_legs` is partitioned by
 * time, so widening it is a decision about how much of a billing ledger one star code may scan. A
 * deployment that wants a different window changes the CONTRACT's default, where the reason for the
 * number is written down.
 */
const lastCallerResponseWindowHours = 168;
