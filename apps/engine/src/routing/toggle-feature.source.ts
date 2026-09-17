import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import { TOGGLE_FEATURE_RPC, toggleFeatureResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type { ToggleFeatureChange, ToggleFeatureOutcome, ToggleFeaturePort } from "./plan-walker";
import type { ClientProxy } from "@nestjs/microservices";
import type { ToggleFeatureRequest } from "@optimiq-voice/events";

/**
 * `*65` and `*64` — a handset flipping something for the whole organization, over
 * `rpc.pbx.v1.toggle-feature`.
 *
 * The same argument {@link ExtensionFeatureRpcPort} makes, applied to two columns that are not on an
 * extension: `call_flow.mode` and `time_condition.override` live in `pbx-db`, they are routing
 * INPUTS the compiler folds into the artifact, and the engine holds no database handle. So the only
 * place the write can happen is the process that owns the row and recompiles when it changes.
 *
 * The deadline comes from the contract for the same reason, and a failure is an ANSWER rather than
 * an exception for the same reason — with more at stake, because the person who pressed the
 * night-mode key and heard silence would leave the office believing it was closed.
 */
@Injectable()
export class ToggleFeatureRpcPort implements ToggleFeaturePort {
	private readonly logger = getLogger("engine.features");
	private calls = 0;
	private failures = 0;

	constructor(@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy) {}

	get stats(): { readonly calls: number; readonly failures: number } {
		return { calls: this.calls, failures: this.failures };
	}

	async toggle(change: ToggleFeatureChange): Promise<ToggleFeatureOutcome> {
		this.calls += 1;
		const payload: ToggleFeatureRequest = {
			orgId: change.organizationId,
			target: change.target,
			...(change.callFlowId === undefined ? {} : { callFlowId: change.callFlowId }),
			...(change.timeConditionId === undefined ? {} : { timeConditionId: change.timeConditionId }),
			...(change.extensionNumber === undefined ? {} : { extensionNumber: change.extensionNumber }),
			...(change.callId === undefined ? {} : { callId: change.callId }),
		};

		try {
			// Parsed, not trusted, for the reason the extension-feature port gives: a responder on a
			// shared broker is another process on another release.
			const reply = toggleFeatureResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(TOGGLE_FEATURE_RPC.subject, payload)
						.pipe(timeout(TOGGLE_FEATURE_RPC.timeoutMs)),
				),
			);
			if (!reply.applied) {
				this.failures += 1;
			}
			return {
				applied: reply.applied,
				...(reply.state === undefined ? {} : { state: reply.state }),
				...(reply.reason === undefined ? {} : { reason: reply.reason }),
			};
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{
					organizationId: change.organizationId,
					target: change.target,
					err: String(error),
				},
				"rpc.pbx.v1.toggle-feature did not answer; the toggle is announced as unavailable",
			);
			return { applied: false, reason: "the toggle service did not answer" };
		}
	}
}
