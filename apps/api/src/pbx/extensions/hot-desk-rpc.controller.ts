import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { hotDeskRequestSchema } from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../../auth/public-route.decorator";
import { HotDeskService } from "./hot-desk.service";
import type { HotDeskAction, HotDeskResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The `rpc.pbx.v1.hot-desk` responder — the other end of `*31` and `*32`.
 *
 * The same shape as {@link ToggleFeatureRpcController}, for the same three reasons: it rides the one
 * microservice the application already connects, so declaring it in `PbxModule` is the whole wiring;
 * `@PublicRoute()` because a broker message carries no session; and every path ends in a REPLY,
 * including a payload this release cannot parse, because the engine and the API are separate
 * deployables and version skew is a state to answer rather than an impossibility.
 *
 * It lives beside the extensions rather than with the call flows because that is what it acts on —
 * a device line's binding to an extension, and the extension's own PIN set. `ToggleFeatureService`
 * is the TEMPLATE, not the neighbour.
 *
 * The one thing this file must never do is log the request. `HotDeskRequest.pin` is a live
 * credential, and a responder that logged its payload on a parse failure would put every agent's
 * PIN in the control plane's log the first time an engine sent a field this release does not know.
 * So the malformed-request line names the ISSUE PATHS and nothing else.
 */
@Controller()
export class HotDeskRpcController {
	constructor(@Inject(HotDeskService) private readonly hotDesk: HotDeskService) {}

	@PublicRoute()
	@MessagePattern(RPC_SUBJECTS.pbxHotDesk)
	async apply(@Payload() payload: unknown): Promise<HotDeskResponse> {
		const parsed = hotDeskRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.pbx.v1.hot-desk request");
			return { applied: false, action: actionOf(payload), reason };
		}

		try {
			return await this.hotDesk.applyForBroker(parsed.data);
		} catch (error) {
			// The service is built not to throw; this is the backstop that keeps a defect inside it from
			// becoming a broker timeout on a live call. The error is logged WITHOUT the request, for the
			// reason above.
			logger.error(
				{ orgId: parsed.data.orgId, action: parsed.data.action, error },
				"rpc.pbx.v1.hot-desk failed",
			);
			return {
				applied: false,
				action: parsed.data.action,
				reason: `the rebind failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}

/**
 * The action a malformed request was probably about.
 *
 * Read off the raw payload rather than defaulted to `login`, because the two are not equally safe
 * to guess: a support log that read "login refused" for what was actually a logout would send
 * somebody looking at a PIN set over a request that never carried a PIN.
 */
function actionOf(payload: unknown): HotDeskAction {
	const claimed =
		typeof payload === "object" && payload !== null
			? (payload as { readonly action?: unknown }).action
			: undefined;
	return claimed === "logout" ? "logout" : "login";
}
