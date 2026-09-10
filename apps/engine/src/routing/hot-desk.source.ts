import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import { HOT_DESK_RPC, hotDeskResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type { HotDeskChange, HotDeskOutcome, HotDeskPort } from "./plan-walker";
import type { ClientProxy } from "@nestjs/microservices";
import type { HotDeskRequest } from "@optimiq-voice/events";

/**
 * `*31` and `*32` — an agent claiming a shared desk phone, over `rpc.pbx.v1.hot-desk`.
 *
 * The same argument {@link ToggleFeatureRpcPort} makes, applied to one more column that is not the
 * engine's: `device_line.extension_id` lives in `pbx-db`, the rebind has to happen inside the
 * transaction that recompiles the tenant's artifact, and the engine holds no database handle.
 *
 * ## This is the one port that carries a credential
 *
 * `change.pin` is the digits the walker just gathered, and they go on the wire in the clear inside
 * a request the broker's per-subject grant controls. That is why the subject is its own rather than
 * a member of the toggle's, and it is why NOTHING here logs the payload: the warn line below names
 * the organization and the action, and deliberately not the change. A port that logged its request
 * on a timeout would put every agent's PIN in the engine's log the first time the control plane was
 * slow.
 *
 * A failure is an ANSWER rather than an exception, as everywhere else on this path. The stakes are
 * the usual ones with one twist worth naming: a refused LOGIN leaves the agent at a desk that is
 * not theirs, which they will notice; a refused LOGOUT leaves their extension on a desk they are
 * walking away from, which they will not. The expiry in `device_line.hot_desk_expires_at` is what
 * makes the second one recoverable without anybody noticing at all.
 */
@Injectable()
export class HotDeskRpcPort implements HotDeskPort {
	private readonly logger = getLogger("engine.features");
	private calls = 0;
	private failures = 0;

	constructor(@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy) {}

	get stats(): { readonly calls: number; readonly failures: number } {
		return { calls: this.calls, failures: this.failures };
	}

	async apply(change: HotDeskChange): Promise<HotDeskOutcome> {
		this.calls += 1;
		const payload: HotDeskRequest = {
			orgId: change.organizationId,
			action: change.action,
			deviceId: change.deviceId,
			...(change.extensionNumber === undefined ? {} : { extensionNumber: change.extensionNumber }),
			...(change.pin === undefined ? {} : { pin: change.pin }),
			...(change.callId === undefined ? {} : { callId: change.callId }),
		};

		try {
			// Parsed, not trusted, for the reason the extension-feature port gives: a responder on a
			// shared broker is another process on another release.
			const reply = hotDeskResponseSchema.parse(
				await firstValueFrom(
					this.client.send(HOT_DESK_RPC.subject, payload).pipe(timeout(HOT_DESK_RPC.timeoutMs)),
				),
			);
			if (!reply.applied) {
				this.failures += 1;
			}
			return {
				applied: reply.applied,
				...(reply.extensionNumber === undefined ? {} : { extensionNumber: reply.extensionNumber }),
				...(reply.expiresAt === undefined ? {} : { expiresAt: reply.expiresAt }),
				...(reply.reason === undefined ? {} : { reason: reply.reason }),
			};
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{
					organizationId: change.organizationId,
					action: change.action,
					err: String(error),
				},
				"rpc.pbx.v1.hot-desk did not answer; the code is announced as unavailable",
			);
			return { applied: false, reason: "the hot-desk service did not answer" };
		}
	}
}
