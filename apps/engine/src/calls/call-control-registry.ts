import { Injectable } from "@nestjs/common";
import type { CallControlPort, ControlledLeg } from "./call-control";

/**
 * The owner of the call-control seam.
 *
 * ## Why this class exists at all
 *
 * The same cycle {@link import("../verbs/dtmf-registry").DtmfRegistry} and
 * {@link import("../routing/call-signals").CallSignalBus} both exist to break, one layer up.
 *
 * The verb executor has to be able to hold, park and transfer a call. Every one of those needs the
 * leg registry, the routing artifact and the event publisher — which is to say, the orchestrator.
 * But the orchestrator is BUILT from the executor's runtime: it dispatches verbs. Injecting the
 * orchestrator into the executor's layer would be a Nest cycle, and the `forwardRef` that resolves
 * it would hide a real design problem rather than solve one.
 *
 * So the binding gets its own owner. The executor's runtime is constructed with this registry and
 * reads it LAZILY, on each dispatch; the orchestrator registers itself when Nest builds it. Neither
 * depends on the other, and the order they are constructed in stops mattering.
 *
 * ## An unbound registry is a real state, not an error
 *
 * `ENGINE_ROUTING_ENABLED=false`, a spec that only exercises `play`, and the instant between the
 * runtime factory running and the orchestrator's constructor finishing are all deployments in which
 * nothing is bound. The executor answers a call-control verb in that state with the same typed
 * failure it gives an unimplemented one — which is honest — rather than throwing on a null.
 */

/** What the executor needs in order to act on a leg it only knows by media-server id. */
export interface CallControlBinding {
	readonly port: CallControlPort;
	/** The leg with this media id, or `undefined` when this process is not handling it. */
	legFor(mediaChannelId: string): ControlledLeg | undefined;
}

@Injectable()
export class CallControlRegistry {
	private binding: CallControlBinding | undefined;

	/** Whether call control is available. `/healthz` and the specs read it. */
	get isBound(): boolean {
		return this.binding !== undefined;
	}

	/** Publishes the binding. Called once, by the orchestrator, as Nest constructs it. */
	register(binding: CallControlBinding): void {
		this.binding = binding;
	}

	/** The binding, or `undefined` when nothing has registered one. Read on every dispatch. */
	get current(): CallControlBinding | undefined {
		return this.binding;
	}

	/** Drops the binding. Used by specs. */
	clear(): void {
		this.binding = undefined;
	}
}
