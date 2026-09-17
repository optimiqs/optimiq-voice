import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { lastCallerRequestSchema } from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../../auth/public-route.decorator";
import { LastCallerService } from "./last-caller.service";
import type { LastCallerResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.cdr");

/**
 * The `rpc.pbx.v1.last-caller` responder — the other end of `*69`.
 *
 * The first `@MessagePattern` in the CDR area, and it needs no transport of its own: the
 * microservice `registerPbxTransport` connects is application-wide, so declaring this controller in
 * `CdrModule` subscribes the subject at boot. See {@link LastCallerService} for why the read lives
 * in this area rather than beside the feature write.
 *
 * ## Why a malformed request is answered rather than rejected
 *
 * The same reason `voicemail-rpc.controller.ts` gives: the engine and the API are separate
 * deployables on separate release trains, so a payload this release cannot parse is version skew
 * and the person who pays for it is already on the line. `found: false` with a reason lets the
 * engine play "not available" immediately instead of holding the caller through a three-second
 * timeout and then guessing.
 *
 * `@PublicRoute()` because the global session guard is an HTTP concern and there is no session on a
 * broker message.
 */
@Controller()
export class LastCallerRpcController {
	constructor(@Inject(LastCallerService) private readonly lastCaller: LastCallerService) {}

	@PublicRoute()
	@MessagePattern(RPC_SUBJECTS.pbxLastCaller)
	async lookup(@Payload() payload: unknown): Promise<LastCallerResponse> {
		const parsed = lastCallerRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.pbx.v1.last-caller request");
			return { found: false, reason: reason.slice(0, 256) };
		}

		try {
			return await this.lastCaller.lookupForBroker({
				orgId: parsed.data.orgId,
				extensionNumber: parsed.data.extensionNumber,
				withinHours: parsed.data.withinHours,
				...(parsed.data.callId === undefined ? {} : { callId: parsed.data.callId }),
			});
		} catch (error) {
			// The service is built not to throw; this is the backstop that keeps a defect inside it from
			// becoming a broker timeout on a live call.
			logger.error(
				{
					orgId: parsed.data.orgId,
					extensionNumber: parsed.data.extensionNumber,
					error,
				},
				"rpc.pbx.v1.last-caller failed",
			);
			return {
				found: false,
				reason:
					`the last-caller lookup failed: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						256,
					),
			};
		}
	}
}
