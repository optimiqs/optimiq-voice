import { Inject, Injectable } from "@nestjs/common";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { getLogger } from "@optimiq-voice/logging";
import { eq, extension } from "@optimiq-voice/pbx-db";
import { serviceActor } from "../shared/audit-log";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { EXTENSION_RESOURCE } from "./extensions.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { ExtensionFeature, ExtensionFeatureResponse } from "@optimiq-voice/events/schemas";
import type { FollowMeConfig, PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * A handset changing its OWN forwarding, do-not-disturb or follow-me — the write behind `*72`,
 * `*74`, `*76`, `*78` and `*21`.
 *
 * ## The claim is resolved, never trusted
 *
 * `extensionNumber` arrives from the engine, which knows it because the call came from that phone.
 * That is authentication of the same strength as the desk the phone sits on, and it is exactly what
 * `*97` accepts — but it is not authorization, and a request on a shared broker proves only that
 * something reached the broker. So the number is resolved to a ROW inside `withTenantScope(orgId)`
 * before anything is written, and a number that is not an enabled extension of that organization is
 * refused. RLS is the filter, as it is everywhere else in this area; there is no `organization_id`
 * predicate here for the reason `pbx.repository.ts` states.
 *
 * ## Why the write goes back through the repository
 *
 * `affectsRouting("extension")` is TRUE: the compiler resolves `forward_all_enabled` and its four
 * siblings into `forwardAllNodeId`, `busyNodeId` and `noAnswerNodeId` at compile time, so a column
 * written without a recompile is a `*72` the engine cannot see. `PbxRepository.update` already does
 * the whole sequence — guard, write, ledger row, compile-on-write in the SAME transaction, publish
 * after the commit — and an unsound artifact rolls the column back with it. Reimplementing that
 * here would be a second write path to a routing input, which is the one thing this area does not
 * have and should not gain.
 *
 * The cost is a second transaction: the claim is resolved in one and the write happens in another.
 * That is safe rather than merely tolerable, because `update` re-reads the row under RLS by id and
 * answers `PbxEntityNotFoundFailure` if it has gone — the window cannot produce a write against a
 * row this organization does not own, only a refusal.
 *
 * ## Nothing throws at the caller
 *
 * Every refusal is `applied: false` with a reason, and the engine turns that into the unavailable
 * announcement. A timeout would be far worse than a refusal: the caller would hear nothing, assume
 * forwarding is on, and the person who rings them afterwards would be the one who finds out it is
 * not. See `EXTENSION_FEATURE_RPC` in `packages/events`.
 */
@Injectable()
export class ExtensionFeatureService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(PBX_EFFECT_RUNTIME) private readonly runtime: PbxRepositoryRuntime,
	) {}

	/**
	 * Applies one feature change and answers with the state the row holds afterwards.
	 *
	 * @throws never. A caller is listening to silence while this runs.
	 */
	async applyForBroker(request: {
		readonly orgId: string;
		readonly extensionNumber: string;
		readonly feature: ExtensionFeature;
		readonly enabled: boolean;
		readonly destination?: string;
		readonly callId?: string;
	}): Promise<ExtensionFeatureResponse> {
		const row = await this.resolveClaim(request.orgId, request.extensionNumber);
		if (row === undefined) {
			// One refusal for "no such number" and for "the extension is disabled", because the two are
			// the same fact to the person holding the handset and telling them apart over a phone line
			// would be a way to enumerate a tenant's extensions.
			return refuse(
				request.feature,
				false,
				`no enabled extension ${request.extensionNumber} in this organization`,
			);
		}

		const planned = plan(request.feature, request.enabled, row, request.destination);
		if (planned.kind === "refused") {
			return refuse(request.feature, planned.enabled, planned.reason, planned.destination);
		}

		try {
			const updated = await runEffect(this.runtime, (repository) =>
				repository.update(
					request.orgId,
					EXTENSION_RESOURCE,
					row.id,
					planned.values,
					// A service principal, not a user: nobody was logged in, somebody pressed `*72` on a
					// phone. The ledger says which extension it was through `resource_ref`.
					serviceActor("engine.feature-code"),
				),
			);
			// Read off the row the write RETURNED, not off the request that asked for it: the reply is
			// what the handset hears confirmed, and it has to describe the database.
			const state = stateOf(request.feature, updated.row);
			return {
				applied: true,
				feature: request.feature,
				enabled: state.enabled,
				...(state.destination === undefined ? {} : { destination: state.destination }),
			};
		} catch (error) {
			// Includes a 422 from compile-on-write: an artifact the change would make unsound is a
			// refusal, and the transaction has already rolled the column back. The caller hears the
			// unavailable announcement rather than a confirmation for a change that did not survive.
			logger.error(
				{
					orgId: request.orgId,
					extensionId: row.id,
					feature: request.feature,
					callId: request.callId,
					error,
				},
				"rpc.pbx.v1.extension-feature could not be applied",
			);
			const unchanged = stateOf(request.feature, row);
			return refuse(
				request.feature,
				unchanged.enabled,
				`the change could not be applied: ${error instanceof Error ? error.message : String(error)}`,
				unchanged.destination,
			);
		}
	}

	/**
	 * The extension behind the claimed number, or `undefined`.
	 *
	 * `enabled` is part of the question rather than a field to check afterwards: a disabled extension
	 * is not in the compiled artifact at all, so writing its forwarding flag would recompile a tenant
	 * for a row no call can reach.
	 */
	private async resolveClaim(
		organizationId: string,
		extensionNumber: string,
	): Promise<ExtensionFeatureRow | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({
					id: extension.id,
					number: extension.number,
					enabled: extension.enabled,
					doNotDisturb: extension.doNotDisturb,
					forwardAllEnabled: extension.forwardAllEnabled,
					forwardAllDestination: extension.forwardAllDestination,
					forwardBusyEnabled: extension.forwardBusyEnabled,
					forwardBusyDestination: extension.forwardBusyDestination,
					forwardNoAnswerEnabled: extension.forwardNoAnswerEnabled,
					forwardNoAnswerDestination: extension.forwardNoAnswerDestination,
					followMe: extension.followMe,
				})
				.from(extension)
				.where(eq(extension.number, extensionNumber))
				.limit(1);
			const row = rows[0];
			return row === undefined || !row.enabled ? undefined : row;
		});
	}
}

/**
 * The columns a feature change reads and writes. Deliberately not the whole row.
 *
 * A type alias rather than an `interface` on purpose: only the alias carries an implicit index
 * signature, which is what lets {@link stateOf} read a projected row and a repository row through
 * one signature instead of a cast between them.
 */
export type ExtensionFeatureRow = {
	readonly id: string;
	readonly number: string;
	readonly enabled: boolean;
	readonly doNotDisturb: boolean;
	readonly forwardAllEnabled: boolean;
	readonly forwardAllDestination: string | null;
	readonly forwardBusyEnabled: boolean;
	readonly forwardBusyDestination: string | null;
	readonly forwardNoAnswerEnabled: boolean;
	readonly forwardNoAnswerDestination: string | null;
	readonly followMe: FollowMeConfig | null;
};

/** Which flag/destination pair a forwarding feature owns. */
const FORWARD_COLUMNS = {
	"forward-all": { flag: "forwardAllEnabled", destination: "forwardAllDestination" },
	"forward-busy": { flag: "forwardBusyEnabled", destination: "forwardBusyDestination" },
	"forward-no-answer": {
		flag: "forwardNoAnswerEnabled",
		destination: "forwardNoAnswerDestination",
	},
} as const satisfies Partial<
	Record<
		ExtensionFeature,
		{ readonly flag: keyof ExtensionFeatureRow; readonly destination: keyof ExtensionFeatureRow }
	>
>;

type ForwardFeature = keyof typeof FORWARD_COLUMNS;

function isForward(feature: ExtensionFeature): feature is ForwardFeature {
	return feature in FORWARD_COLUMNS;
}

type PlannedWrite =
	| { readonly kind: "write"; readonly values: Record<string, unknown> }
	| {
			readonly kind: "refused";
			readonly reason: string;
			/** The state as it STILL stands, so the reply describes the row rather than the request. */
			readonly enabled: boolean;
			readonly destination?: string;
	  };

/**
 * What to write, or why nothing will be.
 *
 * A pure function over the row and the request, so every rule below is testable without a database
 * and none of them can be applied twice by two callers.
 *
 * **`enabled: false` never clears the destination.** The columns are a flag/destination pair for
 * exactly that reason (`extensions-schema.ts`): switching forwarding off and losing the number the
 * user configured would make a bare `*72` a re-typing exercise rather than the toggle every phone
 * system in the industry has trained people to expect.
 *
 * **A forward with nowhere to go is refused.** Turning `forward_all_enabled` on beside a NULL
 * destination compiles to `unresolvable-forward` and produces an extension whose calls go nowhere —
 * a phone that stops ringing and gives no signal that it has. Better a caller who hears "not
 * available" and dials `*72<number>`.
 */
function plan(
	feature: ExtensionFeature,
	enabled: boolean,
	row: ExtensionFeatureRow,
	destination: string | undefined,
): PlannedWrite {
	if (feature === "do-not-disturb") {
		// `destination` is ignored rather than refused: the schema already says the field is
		// meaningless here, and a `*78` that failed because the engine sent a stray argument would be
		// a refusal the user cannot act on.
		return { kind: "write", values: { doNotDisturb: enabled } };
	}

	if (feature === "follow-me") {
		const ladder = row.followMe;
		if (enabled && (ladder === null || ladder.targets.length === 0)) {
			// A ladder REPLACES the plain dial (`FollowMePlan` in `packages/routing`), so switching an
			// empty one on does not add hops — it removes the desk phone. The hops are configured from
			// the admin UI; `*21` only flips the switch, which is what the contract says.
			return {
				kind: "refused",
				reason: "this extension has no follow-me destinations to ring",
				enabled: false,
			};
		}
		const next: FollowMeConfig = { ...(ladder ?? { targets: [] }), enabled };
		return { kind: "write", values: { followMe: next } };
	}

	if (!isForward(feature)) {
		// Unreachable: `extensionFeatureSchema` is closed and every member is handled above. Kept as a
		// refusal rather than a throw so a contract that grows a member degrades into an announcement
		// instead of a broker timeout.
		return { kind: "refused", reason: `unsupported feature ${String(feature)}`, enabled: false };
	}

	const columns = FORWARD_COLUMNS[feature];
	const stored = stateOf(feature, row).destination;
	if (!enabled) {
		return {
			kind: "write",
			values: { [columns.flag]: false },
		};
	}

	const target = destination?.trim();
	const next = target === undefined || target === "" ? stored : target;
	if (next === undefined || next === "") {
		return {
			kind: "refused",
			reason: "no forwarding destination was sent and none is stored",
			enabled: false,
		};
	}
	return {
		kind: "write",
		// The sent destination OVERWRITES the stored one: a user who dials `*72<number>` has just
		// named where their calls go, and honouring the old number would send them somewhere else
		// while playing the confirmation tone.
		values: { [columns.flag]: true, [columns.destination]: next },
	};
}

/**
 * One feature's state, read out of a row by column NAME.
 *
 * Takes the loose shape both callers actually hold — the typed projection this service selects, and
 * the whole `Record<string, unknown>` the repository's `returning()` hands back — rather than
 * casting one into the other. A cast between them would compile and would be wrong the day the
 * repository changes what it returns; reading the two columns the feature owns cannot be.
 */
function stateOf(
	feature: ExtensionFeature,
	row: Readonly<Record<string, unknown>>,
): { readonly enabled: boolean; readonly destination?: string } {
	if (feature === "do-not-disturb") {
		return { enabled: row.doNotDisturb === true };
	}
	if (feature === "follow-me") {
		const ladder = row.followMe;
		return {
			enabled:
				typeof ladder === "object" &&
				ladder !== null &&
				(ladder as { readonly enabled?: unknown }).enabled === true,
		};
	}
	if (!isForward(feature)) {
		return { enabled: false };
	}
	const columns = FORWARD_COLUMNS[feature];
	const destination = row[columns.destination];
	return {
		enabled: row[columns.flag] === true,
		...(typeof destination === "string" && destination !== "" ? { destination } : {}),
	};
}

function refuse(
	feature: ExtensionFeature,
	enabled: boolean,
	reason: string,
	destination?: string,
): ExtensionFeatureResponse {
	return {
		applied: false,
		feature,
		enabled,
		...(destination === undefined ? {} : { destination }),
		reason: reason.slice(0, 256),
	};
}
