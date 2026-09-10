import { Injectable } from "@nestjs/common";
import { headers } from "nats";
import { QUEUE_CALLBACK_RPC, queueCallbackResponseSchema, subjectFor } from "@optimiq-voice/events";
import { createEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";
import type {
	QueueCallbackDialer,
	QueueCallbackPlacement,
	QueueCallbackRequest,
} from "./queue-callback";
import type { QueueCallbackRpcRequest } from "@optimiq-voice/events";

/**
 * Virtual hold's dialler, over `rpc.engine.v1.queue-callback`.
 *
 * ## Why a request onto the fleet and not a direct call into this instance's orchestrator
 *
 * Because the sweep and the CHANNEL are two different resources. A queue's callback runner ticks on
 * whichever instance happens to hold the queue's cursor; the channel has to be created wherever
 * there is room to create one. Going through the subject means the queue group picks that instance,
 * which is the same answer click-to-call gets and for the same reason — and it means a single-node
 * deployment behaves identically, since the request comes straight back to this process.
 *
 * It is also what keeps this out of `apps/engine/src/calls`: the ACD plane asks for a call in one
 * sentence and does not learn how a channel is made.
 *
 * ## It never throws, which is the runner's contract and matters more here than usual
 *
 * `QueueCallbackDialer` documents that a dial answers rather than throws, because a throw would
 * abandon the sweep with the token still marked due and NO attempt recorded — an unbounded retry
 * loop against one unreachable handset. So every failure below, including a broker that is not
 * there and a reply that does not parse, becomes a `refused` with a reason the tenant can read.
 *
 * A timeout is refused as `internal` rather than being retried here. The retry is the TOKEN's — it
 * has an attempt budget and a delay, and a second layer of retries underneath that budget would
 * spend three attempts in the time the tenant configured for one.
 */
@Injectable()
export class QueueCallbackDialerService implements QueueCallbackDialer {
	private readonly logger = getLogger("engine.queue-callback");
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	constructor(private readonly jetstream: JetStreamService) {}

	async place(request: QueueCallbackRequest): Promise<QueueCallbackPlacement> {
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			return { kind: "refused", reason: "the engine has no NATS connection" };
		}

		const wire: QueueCallbackRpcRequest = {
			orgId: request.orgId,
			// Minted per ATTEMPT, not per token: `callbackId` becomes the media channel's id, and a
			// second attempt that reused the first one's would be answered idempotently with the ids
			// of the call that already failed — a retry that never rings.
			callbackId: createEntityId(),
			queueId: request.queueId,
			to: request.callerNumber,
			ringTimeoutSeconds: request.ringTimeoutSeconds,
			...(request.queueNumber === undefined ? {} : { queueNumber: request.queueNumber }),
			...(request.callerIdNumber === undefined ? {} : { callerIdNumber: request.callerIdNumber }),
			...(request.callerIdName === undefined ? {} : { callerIdName: request.callerIdName }),
			...(request.relatedCallId === undefined ? {} : { relatedCallId: request.relatedCallId }),
		};

		let reply: { data: Uint8Array };
		try {
			reply = await connection.request(
				subjectFor.engineQueueCallbackRpc(),
				this.encoder.encode(JSON.stringify(wire)),
				{ timeout: QUEUE_CALLBACK_RPC.timeoutMs, headers: headers() },
			);
		} catch (error) {
			this.logger.warn(
				{ orgId: request.orgId, queueId: request.queueId, err: String(error) },
				"no engine answered a queue callback",
			);
			return { kind: "refused", reason: "internal" };
		}

		const parsed = queueCallbackResponseSchema.safeParse(
			JSON.parse(this.decoder.decode(reply.data)) as unknown,
		);
		if (!parsed.success) {
			// A reply this instance cannot read is NOT evidence that nothing was placed — the far side
			// may well have rung the customer. It is still one spent attempt, which is the honest
			// reading: the alternative, treating it as no attempt, rings that customer forever.
			this.logger.warn(
				{ orgId: request.orgId, queueId: request.queueId, err: String(parsed.error) },
				"a queue callback reply did not match the contract",
			);
			return { kind: "refused", reason: "internal" };
		}
		if (!parsed.data.ok || parsed.data.callId === undefined) {
			return { kind: "refused", reason: parsed.data.reason ?? "internal" };
		}
		return { kind: "placed", callId: parsed.data.callId };
	}
}
