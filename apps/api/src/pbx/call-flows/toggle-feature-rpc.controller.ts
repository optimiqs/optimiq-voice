import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { toggleFeatureRequestSchema } from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../../auth/public-route.decorator";
import { ToggleFeatureService } from "./toggle-feature.service";
import type { ToggleFeatureResponse, ToggleFeatureTarget } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The `rpc.pbx.v1.toggle-feature` responder — the other end of `*65` and `*64`.
 *
 * The same shape as `ExtensionFeatureRpcController`, for the same reasons: it rides the one
 * microservice the application already connects, so declaring it in `PbxModule` is the whole wiring;
 * `@PublicRoute()` because a broker message carries no session; and every path ends in a REPLY,
 * including a payload this release cannot parse, because the engine and the API are separate
 * deployables and version skew is a state to answer rather than an impossibility.
 *
 * The difference is what the reply means to the caller. `applied: false` is the "not available"
 * announcement, and a TIMEOUT is silence — so a receptionist who pressed the night-mode key would
 * walk away believing the office was closed. That is the failure this responder exists to make
 * impossible.
 */
@Controller()
export class ToggleFeatureRpcController {
	constructor(@Inject(ToggleFeatureService) private readonly toggles: ToggleFeatureService) {}

	@PublicRoute()
	@MessagePattern(RPC_SUBJECTS.pbxToggleFeature)
	async toggle(@Payload() payload: unknown): Promise<ToggleFeatureResponse> {
		const parsed = toggleFeatureRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.pbx.v1.toggle-feature request");
			return { applied: false, target: targetOf(payload), reason };
		}

		try {
			return await this.toggles.toggleForBroker(parsed.data);
		} catch (error) {
			// The service is built not to throw; this is the backstop that keeps a defect inside it from
			// becoming a broker timeout on a live call.
			logger.error(
				{ orgId: parsed.data.orgId, target: parsed.data.target, error },
				"rpc.pbx.v1.toggle-feature failed",
			);
			return {
				applied: false,
				target: parsed.data.target,
				reason: `the toggle failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}

/**
 * The target a malformed request was probably about.
 *
 * Read off the raw payload rather than defaulted, for the reason `featureOf` gives one file over: a
 * support log correlates the reply's `target` against the star code somebody pressed, and a skewed
 * release sending a target this one does not know should show up as an unreadable request rather
 * than as a call flow.
 */
function targetOf(payload: unknown): ToggleFeatureTarget {
	const claimed =
		typeof payload === "object" && payload !== null
			? (payload as { readonly target?: unknown }).target
			: undefined;
	return claimed === "time-condition" ? "time-condition" : "call-flow";
}
