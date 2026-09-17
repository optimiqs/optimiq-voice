import { Inject, Injectable } from "@nestjs/common";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { getLogger } from "@optimiq-voice/logging";
import { callFlow, eq, timeCondition } from "@optimiq-voice/pbx-db";
import { nextTimeConditionOverride } from "@optimiq-voice/routing";
import { serviceActor } from "../shared/audit-log";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { TIME_CONDITION_RESOURCE } from "../time-conditions/time-conditions.resource";
import { CallFlowPresencePublisher } from "./call-flow-presence.publisher";
import { CALL_FLOW_RESOURCE } from "./call-flows.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { ToggleFeatureRequest, ToggleFeatureResponse } from "@optimiq-voice/events/schemas";
import type { CallFlowMode, PbxDatabaseClient, TimeConditionOverride } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The two star codes that flip something for the WHOLE organization — `*65` on a call flow and
 * `*64` on a time condition — as the engine asks for them.
 *
 * ## Why it is not `ExtensionFeatureService`
 *
 * That one changes a column on the caller's own extension, so its whole security argument is
 * "resolve the claimed number to a row this organization owns and write it". Here the caller's
 * number decides nothing: the entity is named in the request, and pressing the key puts every
 * inbound call in the tenant onto a different branch. The two therefore have different subjects and
 * different broker grants, and folding them together would make "may divert my own calls" and "may
 * put the whole company into night mode" one permission.
 *
 * ## Neither call carries the value to set
 *
 * A handset has one button, so both are a CYCLE — a flow flips, a condition rings
 * `auto → forced-match → forced-no-match → auto`. That is the same reading the HTTP endpoints
 * already give an empty body (`CallFlowsService.toggle`, `TimeConditionOverrideService.setOverride`),
 * deliberately: a star code and a receptionist's button must not disagree about what a toggle means.
 *
 * The current value is read in its own transaction and the write happens in another, exactly as
 * `applyForBroker` does, and it is safe for the same reason: `PbxRepository.update` re-reads the row
 * under RLS by id, so the window can produce a refusal but never a write against a row this
 * organization does not own. The worst case is two people pressing the key at the same moment and
 * one of them cycling from a state the other had already left — which is what pressing a physical
 * switch twice does too.
 *
 * ## The write goes through the repository, and the lamp moves after it
 *
 * `affectsRouting("call_flow")` and `affectsRouting("time_condition")` are both true: the compiler
 * folds `mode` and `override` into the artifact, so a column written without a recompile is a night
 * mode the engine cannot see. And the BLF publish happens after the commit for the reason
 * `CallFlowsService.toggle` gives — a lamp that moved for a change that then rolled back is worse
 * than a lamp that lags by a moment.
 *
 * @throws never. A caller is listening to silence while this runs.
 */
@Injectable()
export class ToggleFeatureService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(PBX_EFFECT_RUNTIME) private readonly runtime: PbxRepositoryRuntime,
		@Inject(CallFlowPresencePublisher) private readonly presence: CallFlowPresencePublisher,
	) {}

	async toggleForBroker(request: ToggleFeatureRequest): Promise<ToggleFeatureResponse> {
		if (request.target === "call-flow") {
			return request.callFlowId === undefined
				? refuse("call-flow", "the request named no call flow")
				: await this.toggleCallFlow(request.orgId, request.callFlowId, request.callId);
		}
		return request.timeConditionId === undefined
			? refuse("time-condition", "the request named no time condition")
			: await this.cycleOverride(request.orgId, request.timeConditionId, request.callId);
	}

	private async toggleCallFlow(
		orgId: string,
		callFlowId: string,
		callId: string | undefined,
	): Promise<ToggleFeatureResponse> {
		const current = await this.database.withTenantScope(orgId, async (transaction) => {
			const rows = await transaction
				.select({
					id: callFlow.id,
					mode: callFlow.mode,
					enabled: callFlow.enabled,
					featureCode: callFlow.featureCode,
					extensionNumber: callFlow.extensionNumber,
				})
				.from(callFlow)
				.where(eq(callFlow.id, callFlowId))
				.limit(1);
			const row = rows[0];
			return row === undefined || !row.enabled ? undefined : row;
		});
		if (current === undefined) {
			// One refusal for "no such flow" and for "the flow is disabled": both are the same fact to
			// the person holding the handset, and telling them apart over a phone line would be a way
			// to enumerate a tenant's configuration.
			return refuse("call-flow", "no enabled call flow with that id in this organization");
		}

		const next: CallFlowMode = current.mode === "day" ? "night" : "day";
		try {
			await runEffect(this.runtime, (repository) =>
				repository.update(
					orgId,
					CALL_FLOW_RESOURCE,
					current.id,
					{ mode: next },
					// A service principal, not a user: nobody was logged in, somebody pressed `*65` on a
					// phone. The ledger says which flow through `resource_ref`.
					serviceActor("engine.feature-code"),
				),
			);
		} catch (error) {
			logger.error(
				{ orgId, callFlowId, callId, error },
				"rpc.pbx.v1.toggle-feature could not flip a call flow",
			);
			return refuse("call-flow", describe(error), current.mode);
		}

		await this.presence.publish({
			organizationId: orgId,
			presenceKey: current.featureCode ?? current.extensionNumber,
			lit: next === "night",
		});
		return { applied: true, target: "call-flow", state: next };
	}

	private async cycleOverride(
		orgId: string,
		timeConditionId: string,
		callId: string | undefined,
	): Promise<ToggleFeatureResponse> {
		const current = await this.database.withTenantScope(orgId, async (transaction) => {
			const rows = await transaction
				.select({
					id: timeCondition.id,
					override: timeCondition.override,
					enabled: timeCondition.enabled,
					overrideFeatureCode: timeCondition.overrideFeatureCode,
				})
				.from(timeCondition)
				.where(eq(timeCondition.id, timeConditionId))
				.limit(1);
			const row = rows[0];
			return row === undefined || !row.enabled ? undefined : row;
		});
		if (current === undefined) {
			return refuse(
				"time-condition",
				"no enabled time condition with that id in this organization",
			);
		}

		const next = nextTimeConditionOverride(current.override as TimeConditionOverride);
		try {
			await runEffect(this.runtime, (repository) =>
				repository.update(
					orgId,
					TIME_CONDITION_RESOURCE,
					current.id,
					{ override: next },
					serviceActor("engine.feature-code"),
				),
			);
		} catch (error) {
			logger.error(
				{ orgId, timeConditionId, callId, error },
				"rpc.pbx.v1.toggle-feature could not cycle a time-condition override",
			);
			return refuse("time-condition", describe(error), current.override ?? undefined);
		}

		await this.presence.publish({
			organizationId: orgId,
			presenceKey: current.overrideFeatureCode,
			// Lit means "somebody has taken the clock out of the loop", either way round — the same
			// reading `setOverride` gives, so a lamp does not depend on which surface flipped it.
			lit: next !== "auto",
		});
		return { applied: true, target: "time-condition", state: next };
	}
}

function refuse(
	target: ToggleFeatureResponse["target"],
	reason: string,
	state?: string,
): ToggleFeatureResponse {
	return { applied: false, target, reason, ...(state === undefined ? {} : { state }) };
}

function describe(error: unknown): string {
	return `the change could not be applied: ${error instanceof Error ? error.message : String(error)}`;
}
