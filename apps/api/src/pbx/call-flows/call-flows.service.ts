import { Inject, Injectable } from "@nestjs/common";
import { nextTimeConditionOverride } from "@optimiq-voice/routing";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { TIME_CONDITION_RESOURCE } from "../time-conditions/time-conditions.resource";
import { CallFlowPresencePublisher } from "./call-flow-presence.publisher";
import { CALL_FLOW_RESOURCE } from "./call-flows.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";
import type { CallFlowMode, TimeConditionOverride } from "@optimiq-voice/pbx-db";

/**
 * Call flows, plus the toggle.
 *
 * The toggle is the ordinary generic `update` with two things around it: it is guarded by
 * `call-flows.toggle` rather than `call-flows.write` (a receptionist's job, not an administrator's),
 * and it writes the busy lamp afterwards. Everything in the middle — the tenant scope, the audit
 * row, compile-on-write, the outbox entry — is the shared repository's, because a mode flip is a
 * routing write like any other and inventing a second write path for it would be inventing a second
 * place for the recompile to be forgotten.
 */
@Injectable()
export class CallFlowsService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(CallFlowPresencePublisher) private readonly presence: CallFlowPresencePublisher,
	) {
		super(runtime, CALL_FLOW_RESOURCE);
	}

	/**
	 * Moves the switch.
	 *
	 * `mode` absent means "the other one", which is what a wallboard button and a handset both want.
	 * The current mode is read first rather than taken from the caller, because a caller that guessed
	 * would flip a flow somebody else had already flipped.
	 */
	async toggle(
		session: AppSession,
		id: string,
		mode: CallFlowMode | undefined,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const current = await this.get(session, id);
		const next: CallFlowMode =
			mode ?? ((current.data.mode as CallFlowMode) === "day" ? "night" : "day");
		const result = await this.update(session, id, { mode: next });

		// After the commit and after the recompile, never before: a lamp that moved for a change that
		// then rolled back is worse than a lamp that lags by a moment.
		await this.presence.publish({
			organizationId: this.organizationId(session),
			presenceKey:
				(result.data.featureCode as string | null) ??
				(result.data.extensionNumber as string | null),
			lit: next === "night",
		});
		return result;
	}
}

/**
 * The time-condition manual override.
 *
 * A service of its own rather than a method on `TimeConditionsService`, and it is worth saying why:
 * the override is guarded by `call-flows.toggle`, not by `time-conditions.write`. Forcing a
 * condition open and flipping a call flow to night are the same act — a human overruling where calls
 * go, right now — and the registry collapses them onto one grant for exactly that reason. Keeping
 * the code beside the call flow rather than beside the time condition is what makes that visible.
 */
@Injectable()
export class TimeConditionOverrideService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(CallFlowPresencePublisher) private readonly presence: CallFlowPresencePublisher,
	) {
		super(runtime, TIME_CONDITION_RESOURCE);
	}

	/**
	 * Sets, or advances, the override.
	 *
	 * Absent means "one step around the ring" — `auto -> forced-match -> forced-no-match -> auto` —
	 * which is what pressing the code on a handset does. A ring rather than a toggle because there
	 * are three states and a two-state toggle cannot reach the third, and it always returns to
	 * obeying the clock, which is the state a tenant should reach by pressing the key again rather
	 * than by finding the admin screen.
	 */
	async setOverride(
		session: AppSession,
		id: string,
		override: TimeConditionOverride | undefined,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const current = await this.get(session, id);
		const next =
			override ?? nextTimeConditionOverride(current.data.override as TimeConditionOverride);
		const result = await this.update(session, id, { override: next });

		await this.presence.publish({
			organizationId: this.organizationId(session),
			presenceKey: result.data.overrideFeatureCode as string | null,
			// Lit means "somebody has taken the clock out of the loop", either way round. A lamp that
			// only lit for `forced-no-match` would leave the more dangerous state — the office forced
			// OPEN over a holiday — invisible on every phone in the building.
			lit: next !== "auto",
		});
		return result;
	}
}
