import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { authzCheckRequestSchema } from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../public-route.decorator";
import { AuthzService, denyAll } from "./authz.service";
import type { AuthzCheckResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.authz");

/**
 * The `rpc.authz.v1.check` responder — the first non-telephony subject this application answers.
 *
 * Registered by the same microservice the four PBX responders are served by: one
 * `app.connectMicroservice` for the whole application, so declaring the controller in a module the
 * container builds is the entire wiring. See `pbx.module.ts` for why it is declared THERE and not in
 * `auth.module.ts` even though it lives here.
 *
 * ## What calls it
 *
 * `*0` supervision. A supervisor dials a colleague's extension from a desk phone, and before the
 * engine attaches a media tap to a live conversation it asks this subject whether that handset's
 * user holds `calls.supervise` in that organization. There is no session on a phone, which is why
 * the contract grew an `extension` subject type and why the number it carries is resolved here
 * rather than trusted — see `authzCheckRequestSchema` in `packages/events`.
 *
 * ## A refusal is ANSWERED, never thrown
 *
 * The rule the PBX responders state, and it bites harder on this one. A Nest `@MessagePattern` that
 * throws sends no reply, and no reply is a timeout at the requester — so a denial and a broker
 * hiccup arrive as the same thing. On a subject whose entire job is to make a denial a DECISION,
 * that is not a degraded answer, it is the wrong answer: the engine's correct behaviour when it
 * cannot reach this responder is to REFUSE the supervision, and it can only distinguish "refuse
 * because I was told no" from "refuse because I heard nothing" if being told no actually arrives.
 * Every path below therefore ends in a reply — including a payload this release cannot parse, since
 * the engine and the API are separate deployables on separate release trains and version skew is a
 * state to answer rather than an impossibility.
 *
 * A malformed request is `allowed: false`, which is also the safe direction: this responder can only
 * ever fail CLOSED.
 *
 * `@PublicRoute()` because the global session guard is an HTTP concern and there is no session on a
 * broker message. The irony of the authorization responder opting out of the authorization guard is
 * worth naming: the guard authenticates a browser session, this subject answers a question ABOUT a
 * principal, and the isolation that protects it is the broker's own allow-list — `config/nats.conf`
 * grants this subject to `apps/api` on the subscribe side and to `apps/engine` on the publish side,
 * and to nothing else.
 */
@Controller()
export class AuthzCheckRpcController {
	constructor(@Inject(AuthzService) private readonly authz: AuthzService) {}

	@PublicRoute()
	@MessagePattern(RPC_SUBJECTS.authzCheck)
	async check(@Payload() payload: unknown): Promise<AuthzCheckResponse> {
		const parsed = authzCheckRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.authz.v1.check request");
			// The permissions are read off the RAW payload so the reply's `missing` still describes what
			// was asked about. A caller that intersects `missing` against its own list has to find its
			// list there, and a request that failed to parse for an unrelated reason — a bad `orgId`,
			// say — usually carried a perfectly readable permission array.
			return denyAll(claimedPermissions(payload), reason);
		}

		try {
			return await this.authz.check(parsed.data);
		} catch (error) {
			// The service is built not to throw; this is the backstop that keeps a defect inside it — or
			// an exhausted connection pool — from becoming a broker timeout at an engine that is holding
			// a supervisor on the line.
			logger.error(
				{
					orgId: parsed.data.orgId,
					subjectType: parsed.data.subject.type,
					permissions: parsed.data.permissions,
					error,
				},
				"rpc.authz.v1.check failed",
			);
			return denyAll(
				parsed.data.permissions,
				`the check could not be completed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/**
 * The permissions a malformed request was probably about.
 *
 * Clamped to the RESPONSE schema's own limits (64 entries, 96 characters each) rather than to the
 * request's, because this list is about to be published as `missing` and a reply that fails its own
 * contract is a reply the requester discards — which lands us back at the timeout this whole file
 * exists to avoid. Anything that is not an array of strings yields an empty list, which is the
 * honest answer to "what was asked?" when the payload did not say.
 */
function claimedPermissions(payload: unknown): readonly string[] {
	const claimed =
		typeof payload === "object" && payload !== null
			? (payload as { readonly permissions?: unknown }).permissions
			: undefined;
	if (!Array.isArray(claimed)) {
		return [];
	}
	return claimed
		.filter((entry): entry is string => typeof entry === "string")
		.slice(0, 64)
		.map((entry) => entry.slice(0, 96));
}
