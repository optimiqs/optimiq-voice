import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import {
	extensionFeatureRequestSchema,
	extensionFeatureSchema,
} from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../../auth/public-route.decorator";
import { ExtensionFeatureService } from "./extension-feature.service";
import type { ExtensionFeature, ExtensionFeatureResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The `rpc.pbx.v1.extension-feature` responder — the other end of `*72`, `*74`, `*76`, `*78`, `*21`.
 *
 * Registered by the same microservice `voicemail-rpc.controller.ts` is served by: one
 * `app.connectMicroservice` for the whole application, so declaring the controller in `PbxModule`
 * is the entire wiring. No transport change was needed to add this subject, which is what that
 * design was chosen for.
 *
 * ## The only WRITE the engine makes
 *
 * Every other subject the engine calls is a read, and the difference matters here: a hostile
 * `orgId` on a routing resolve can only ever see its own (probably empty) configuration, whereas a
 * hostile `extensionNumber` on THIS subject would be a write to somebody else's phone if the number
 * were trusted. It is not — {@link ExtensionFeatureService.applyForBroker} resolves it to a row
 * inside the tenant scope first, and the check lives with the write so a second caller cannot skip
 * it.
 *
 * ## A refusal is answered, never thrown
 *
 * The engine turns `applied: false` into the "not available" announcement and `applied: true` into
 * the confirmation tone. A timeout gives it neither, so a caller who has just switched forwarding on
 * hears silence and walks away believing it worked. Every path below therefore ends in a reply,
 * including a payload this release cannot parse — the engine and the API are separate deployables on
 * separate release trains, so version skew is a state to answer rather than an impossibility.
 *
 * `@PublicRoute()` because the global session guard is an HTTP concern and there is no session on a
 * broker message.
 */
@Controller()
export class ExtensionFeatureRpcController {
	constructor(
		@Inject(ExtensionFeatureService) private readonly features: ExtensionFeatureService,
	) {}

	@PublicRoute()
	@MessagePattern(RPC_SUBJECTS.pbxExtensionFeature)
	async apply(@Payload() payload: unknown): Promise<ExtensionFeatureResponse> {
		const parsed = extensionFeatureRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.pbx.v1.extension-feature request");
			// `forward-all` is the fallback FEATURE only because the reply must name one and the request
			// did not survive parsing. `applied: false` is the part the caller acts on.
			return refuse(featureOf(payload), reason);
		}

		try {
			return await this.features.applyForBroker({
				orgId: parsed.data.orgId,
				extensionNumber: parsed.data.extensionNumber,
				feature: parsed.data.feature,
				enabled: parsed.data.enabled,
				...(parsed.data.destination === undefined ? {} : { destination: parsed.data.destination }),
				...(parsed.data.callId === undefined ? {} : { callId: parsed.data.callId }),
			});
		} catch (error) {
			// The service is built not to throw; this is the backstop that keeps a defect inside it from
			// becoming a broker timeout on a live call.
			logger.error(
				{
					orgId: parsed.data.orgId,
					extensionNumber: parsed.data.extensionNumber,
					feature: parsed.data.feature,
					error,
				},
				"rpc.pbx.v1.extension-feature failed",
			);
			return refuse(
				parsed.data.feature,
				`the feature change failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/**
 * The feature a malformed request was probably about.
 *
 * Read off the raw payload rather than defaulted, because the reply's `feature` is what a support
 * log correlates against the star code somebody pressed — and a skewed release that sends a feature
 * this one does not know should show up as that feature in the log, not as `forward-all`.
 */
function featureOf(payload: unknown): ExtensionFeature {
	const claimed =
		typeof payload === "object" && payload !== null
			? (payload as { readonly feature?: unknown }).feature
			: undefined;
	const parsed = extensionFeatureSchema.safeParse(claimed);
	return parsed.success ? parsed.data : "forward-all";
}

/** Every refusal carries `applied: false` AND `enabled: false`: nothing was written. */
function refuse(feature: ExtensionFeature, reason: string): ExtensionFeatureResponse {
	return { applied: false, feature, enabled: false, reason: reason.slice(0, 256) };
}
