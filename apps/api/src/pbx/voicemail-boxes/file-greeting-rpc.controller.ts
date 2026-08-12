import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import {
	fileGreetingRequestSchema,
	voicemailGreetingKindSchema,
} from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../../auth/public-route.decorator";
import { FileGreetingService } from "./file-greeting.service";
import type { FileGreetingResponse, VoicemailGreetingKind } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The `rpc.pbx.v1.file-greeting` responder — the other end of `*99`.
 *
 * Registered by the same microservice `voicemail-rpc.controller.ts` and
 * `extension-feature-rpc.controller.ts` are served by: one `app.connectMicroservice` for the whole
 * application, so declaring the controller in `PbxModule` is the entire wiring. No transport change
 * was needed to add this subject, which is what that design was chosen for.
 *
 * ## The second WRITE the engine makes, and the first that moves audio
 *
 * `rpc.pbx.v1.extension-feature` changes a column; this files a row and copies an object into the
 * media library. Both treat what the engine sends as a CLAIM rather than as an identity — the
 * mailbox number here, the extension number there — and for the same reason: a request on a shared
 * broker proves only that something reached the broker. This one carries a second claim the feature
 * subject has no equivalent of, an OBJECT KEY, and {@link FileGreetingService} explains what is
 * checked about it and why that check cannot live up here.
 *
 * ## A refusal is answered, never thrown
 *
 * The engine turns `applied: false` into the "not available" announcement and `applied: true` into
 * the confirmation. A timeout gives it neither, and the cost of that is higher here than anywhere
 * else on this backbone: somebody has just recorded thirty seconds of their voice, and silence is
 * what they will take for success — until the first caller reaches the mailbox and hears the
 * deployment's default announcement instead. Every path below therefore ends in a reply, including
 * a payload this release cannot parse, because the engine and the API are separate deployables on
 * separate release trains and version skew is a state to answer rather than an impossibility.
 *
 * `@PublicRoute()` because the global session guard is an HTTP concern and there is no session on a
 * broker message.
 */
@Controller()
export class FileGreetingRpcController {
	constructor(@Inject(FileGreetingService) private readonly greetings: FileGreetingService) {}

	@PublicRoute()
	@MessagePattern(RPC_SUBJECTS.pbxFileGreeting)
	async file(@Payload() payload: unknown): Promise<FileGreetingResponse> {
		const parsed = fileGreetingRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.pbx.v1.file-greeting request");
			return refuse(kindOf(payload), reason);
		}

		try {
			return await this.greetings.fileForBroker({
				orgId: parsed.data.orgId,
				voicemailBoxId: parsed.data.voicemailBoxId,
				mailboxNumber: parsed.data.mailboxNumber,
				greetingId: parsed.data.greetingId,
				kind: parsed.data.kind,
				objectKey: parsed.data.objectKey,
				durationMs: parsed.data.durationMs,
				...(parsed.data.recordingId === undefined ? {} : { recordingId: parsed.data.recordingId }),
				...(parsed.data.callId === undefined ? {} : { callId: parsed.data.callId }),
			});
		} catch (error) {
			// The service is built not to throw; this is the backstop that keeps a defect inside it from
			// becoming a broker timeout on a live call.
			logger.error(
				{
					orgId: parsed.data.orgId,
					voicemailBoxId: parsed.data.voicemailBoxId,
					greetingId: parsed.data.greetingId,
					error,
				},
				"rpc.pbx.v1.file-greeting failed",
			);
			return refuse(
				parsed.data.kind,
				`the greeting could not be filed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/**
 * The slot a malformed request was probably about.
 *
 * Read off the raw payload rather than defaulted, on the same terms as the feature responder's
 * `featureOf`: the reply's `kind` is what a support log correlates against the star code somebody
 * pressed, and a skewed release sending a slot this one does not know should show up in the log as
 * whatever it sent rather than as `unavailable`.
 */
function kindOf(payload: unknown): VoicemailGreetingKind {
	const claimed =
		typeof payload === "object" && payload !== null
			? (payload as { readonly kind?: unknown }).kind
			: undefined;
	const parsed = voicemailGreetingKindSchema.safeParse(claimed);
	return parsed.success ? parsed.data : "unavailable";
}

/** Every refusal carries `applied: false` AND `active: false`: nothing was filed. */
function refuse(kind: VoicemailGreetingKind, reason: string): FileGreetingResponse {
	return { applied: false, kind, active: false, reason: reason.slice(0, 256) };
}
