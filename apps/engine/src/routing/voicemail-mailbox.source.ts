import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import { VOICEMAIL_LIST_RPC, voicemailListResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ENGINE_ENV, ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type {
	VoicemailListing,
	VoicemailListingMessage,
	VoicemailListingRequest,
	VoicemailMailboxSource,
} from "./plan-walker";
import type { ClientProxy } from "@nestjs/microservices";
import type { VoicemailListRequest } from "@optimiq-voice/events";

/**
 * Reading a mailbox for the `*97` menu, over `rpc.voicemail.v1.list`.
 *
 * ## Why this is an RPC and not a KV read
 *
 * `voicemail_message` rows are the control plane's: they are written by the consumer of
 * `voicemail.message.left`, mutated by folder moves and deletes from the web UI, and read by an
 * engine that holds no database handle and must not grow one. A KV projection would be a second
 * copy of those rows with its own staleness, invalidated by a stream the engine would then also
 * have to consume — for a read that happens once per `*97` press. Request-reply asks the process
 * that owns the rows, at the moment somebody is listening.
 *
 * ## Nobody answers this yet
 *
 * The API-side responder is a named follow-up. Until it exists every call here times out, and that
 * is a state this class is built around rather than one it discovers: a failure returns
 * `found: false` with a reason, the menu announces the mailbox as unavailable, and the call ends.
 * It never returns an empty list for an unreachable mailbox, because "you have no messages" told to
 * somebody who has nine is a worse outcome than any error message.
 *
 * ## The reply is validated, not trusted
 *
 * `voicemailListResponseSchema.parse` runs on every reply for the same reason
 * `routing-artifact.source.ts` parses its artifact: a responder on a shared broker is another
 * process on another release, and a malformed reply must fail as "unreadable mailbox" rather than
 * as a walk that dereferences `undefined` halfway through somebody's messages.
 */
@Injectable()
export class VoicemailMailboxRpcSource implements VoicemailMailboxSource {
	private readonly logger = getLogger("engine.voicemail");
	private calls = 0;
	private failures = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy,
	) {}

	/** Counters `/healthz` and the specs read. */
	get stats(): { readonly calls: number; readonly failures: number } {
		return { calls: this.calls, failures: this.failures };
	}

	async list(request: VoicemailListingRequest): Promise<VoicemailListing> {
		this.calls += 1;
		const payload: VoicemailListRequest = {
			orgId: request.organizationId,
			voicemailBoxId: request.voicemailBoxId,
			mailboxNumber: request.mailboxNumber,
			folder: "new",
			limit: 20,
			...(request.callId === undefined ? {} : { callId: request.callId }),
		};

		try {
			const reply = voicemailListResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(VOICEMAIL_LIST_RPC.subject, payload)
						.pipe(timeout(this.env.ENGINE_VOICEMAIL_RPC_TIMEOUT_MS)),
				),
			);
			if (!reply.found) {
				this.failures += 1;
				return {
					found: false,
					messages: [],
					...(reply.reason === undefined ? {} : { reason: reply.reason }),
				};
			}
			return { found: true, messages: reply.messages.map(toListingMessage) };
		} catch (error) {
			this.failures += 1;
			// `warn`, not `error`: with no responder deployed this is the expected path, and an error
			// per `*97` press would train an operator to ignore the log line that will matter once
			// the responder exists and starts genuinely failing.
			this.logger.warn(
				{
					organizationId: request.organizationId,
					voicemailBoxId: request.voicemailBoxId,
					err: String(error),
				},
				"rpc.voicemail.v1.list did not answer; the mailbox is announced as unavailable",
			);
			return { found: false, messages: [], reason: "the mailbox service did not answer" };
		}
	}
}

function toListingMessage(message: {
	messageId: string;
	objectKey: string;
	durationMs: number;
	receivedAt: string;
	callerIdNumber?: string;
	callerIdName?: string;
}): VoicemailListingMessage {
	return {
		messageId: message.messageId,
		// The object key becomes a domain `MediaRef` here rather than in the contract, so the RPC
		// stays a description of the ROWS and the media vocabulary stays the engine's.
		media: `object://${message.objectKey.replace(/^\/+/, "")}`,
		durationMs: message.durationMs,
		receivedAt: message.receivedAt,
		...(message.callerIdNumber === undefined ? {} : { callerIdNumber: message.callerIdNumber }),
		...(message.callerIdName === undefined ? {} : { callerIdName: message.callerIdName }),
	};
}
