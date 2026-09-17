import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import { EXTENSION_FEATURE_RPC, extensionFeatureResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type {
	ExtensionFeatureChange,
	ExtensionFeatureOutcome,
	ExtensionFeaturePort,
} from "./plan-walker";
import type { ClientProxy } from "@nestjs/microservices";
import type { ExtensionFeatureRequest } from "@optimiq-voice/events";

/**
 * `*72`, `*74`, `*76`, `*78` and `*21` — a handset changing its own state, over
 * `rpc.pbx.v1.extension-feature`.
 *
 * ## Why this is an RPC and the only WRITE the engine makes
 *
 * `extension.forward_all_enabled` and its four siblings live in `pbx-db`, which the API owns and the
 * engine holds no handle on. They are also routing INPUTS: the compiler resolves them into
 * `forwardAllNodeId`, `busyNodeId` and `noAnswerNodeId`, so a column written without a recompile is
 * a `*72` the engine cannot see. Both facts point at the same place — ask the process that owns the
 * row and recompiles when it changes.
 *
 * ## The deadline comes from the contract, not from the environment
 *
 * Every other RPC client here reads a `ENGINE_*_RPC_TIMEOUT_MS`. This one uses
 * `EXTENSION_FEATURE_RPC.timeoutMs`, because the five seconds are not a deployment preference: the
 * responder recompiles the tenant's whole routing artifact inside the write's transaction, and a
 * deployment that shortened the budget would be a deployment where every `*72` on a large tenant
 * announces failure for a change that then lands anyway. A knob whose only correct value is the
 * contract's is a knob that can only be set wrong.
 *
 * ## A failure is an ANSWER, never an exception the walker has to catch
 *
 * `applied: false` is what the walk turns into the "not available" announcement, so a timeout, a
 * missing responder and a refusal all collapse to the same shape here. The alternative — throwing —
 * would put the "did anything happen?" question in two places, and the one on the call path would
 * be the one that got it wrong.
 */
@Injectable()
export class ExtensionFeatureRpcPort implements ExtensionFeaturePort {
	private readonly logger = getLogger("engine.features");
	private calls = 0;
	private failures = 0;

	constructor(@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy) {}

	/** Call counters, on the same terms as the mailbox source's: read by the specs, and available
	 * to a health surface that wants to see whether the responder is answering at all. */
	get stats(): { readonly calls: number; readonly failures: number } {
		return { calls: this.calls, failures: this.failures };
	}

	async apply(change: ExtensionFeatureChange): Promise<ExtensionFeatureOutcome> {
		this.calls += 1;
		const payload: ExtensionFeatureRequest = {
			orgId: change.organizationId,
			extensionNumber: change.extensionNumber,
			feature: change.feature,
			enabled: change.enabled,
			...(change.destination === undefined ? {} : { destination: change.destination }),
			...(change.callId === undefined ? {} : { callId: change.callId }),
		};

		try {
			// Parsed, not trusted: a responder on a shared broker is another process on another release,
			// and a malformed reply must become "not available" rather than a confirmation tone played
			// for a field that was not there.
			const reply = extensionFeatureResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(EXTENSION_FEATURE_RPC.subject, payload)
						.pipe(timeout(EXTENSION_FEATURE_RPC.timeoutMs)),
				),
			);
			if (!reply.applied) {
				this.failures += 1;
			}
			return {
				applied: reply.applied,
				enabled: reply.enabled,
				...(reply.destination === undefined ? {} : { destination: reply.destination }),
				...(reply.reason === undefined ? {} : { reason: reply.reason }),
			};
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{
					organizationId: change.organizationId,
					extensionNumber: change.extensionNumber,
					feature: change.feature,
					err: String(error),
				},
				"rpc.pbx.v1.extension-feature did not answer; the change is announced as unavailable",
			);
			return {
				applied: false,
				// `false` rather than "what it was": nothing came back, so the only honest claim is that
				// this call changed nothing. The walk announces rather than reading this field.
				enabled: false,
				reason: "the feature service did not answer",
			};
		}
	}
}
