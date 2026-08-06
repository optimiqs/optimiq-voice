import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { voicemailListRequestSchema } from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../../auth/public-route.decorator";
import { VoicemailMessagesService } from "./voicemail-messages.service";
import type { BrokerListReply } from "./voicemail-messages.service";

const logger = getLogger("api.pbx");

/**
 * The `rpc.voicemail.v1.list` responder — the other end of the engine's `*97` menu.
 *
 * Registered by the SAME microservice `routing-rpc.controller.ts` is served by:
 * `registerPbxTransport` calls `app.connectMicroservice` once for the whole application, so every
 * `@MessagePattern` in a controller this module declares is subscribed at boot. No transport
 * change was needed to add this subject, which is the property that design was chosen for.
 *
 * ## Why validate, and why answer rather than throw
 *
 * The engine and the API are separate deployables on separate release trains, so a payload that
 * does not satisfy `voicemailListRequestSchema` is a version skew, not an impossibility. It is
 * answered with `found: false` and a reason: the caller is ALREADY CONNECTED and listening, so a
 * rejected reply the engine can turn into "this mailbox is unavailable" beats a timeout it has to
 * guess about while somebody hears silence. The engine's client is built for exactly that answer.
 *
 * ## Authorization: the subject is not the boundary here
 *
 * `routing-rpc.controller.ts` can say "reaching this subject requires credentials for this
 * cluster, which is the trust level every `rpc.*` subject assumes", because a routing resolve
 * returns a tenant's own configuration keyed by the `orgId` in the request — a hostile `orgId` can
 * only ever see its own, probably empty, configuration.
 *
 * That argument does NOT carry over to a mailbox, and `packages/events` says so in the request
 * schema: `mailboxNumber` "MUST be treated as a claim to be checked against the box, not as
 * authorisation". A broker request is not authorization. So the responder makes the cross-check —
 * the box is loaded under `withTenantScope(orgId)` and its own `mailboxNumber` must equal the one
 * claimed — and refuses otherwise. See `VoicemailMessagesService.listForBroker`; the check lives
 * with the query so it cannot be skipped by a second caller.
 *
 * `@PublicRoute()` because the global session guard is an HTTP concern and there is no session on
 * a broker message.
 */
@Controller()
export class VoicemailRpcController {
	constructor(
		@Inject(VoicemailMessagesService) private readonly messages: VoicemailMessagesService,
	) {}

	@PublicRoute()
	@MessagePattern(RPC_SUBJECTS.voicemailList)
	async list(@Payload() payload: unknown): Promise<BrokerListReply> {
		const parsed = voicemailListRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.voicemail.v1.list request");
			return refuse(reason);
		}

		try {
			return await this.messages.listForBroker({
				orgId: parsed.data.orgId,
				voicemailBoxId: parsed.data.voicemailBoxId,
				mailboxNumber: parsed.data.mailboxNumber,
				folder: parsed.data.folder,
				limit: parsed.data.limit,
			});
		} catch (error) {
			// A failure must not become a broker-level timeout: the caller is connected and waiting.
			logger.error(
				{
					orgId: parsed.data.orgId,
					voicemailBoxId: parsed.data.voicemailBoxId,
					error,
				},
				"rpc.voicemail.v1.list failed",
			);
			return refuse(
				`voicemail listing failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/**
 * Every refusal carries `found: false` AND an empty list.
 *
 * Never an empty list with `found: true`: the engine turns the first into "this mailbox is
 * unavailable" and the second into "you have no messages", and telling somebody who has nine
 * messages that they have none is the failure mode this contract was written to prevent.
 */
function refuse(reason: string): BrokerListReply {
	return {
		found: false,
		messages: [],
		total: 0,
		newCount: 0,
		savedCount: 0,
		reason: reason.slice(0, 256),
	};
}
