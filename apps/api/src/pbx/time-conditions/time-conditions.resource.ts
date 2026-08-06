import { timeCondition, timeConditionRule } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * Time conditions and their ordered rules.
 *
 * A condition has two roles, and the schema keeps them separate so neither field becomes dead
 * configuration: as a **gate** on a route (`route.timeConditionId`) it contributes only its rules
 * and its no-match branch; as a **destination** (`destinationType: "time-condition"`) it
 * contributes its own destination and its no-match destination. Both trios are therefore modelled
 * and both are validated.
 *
 * The rules are a child collection ordered by `ordinal`: the first rule whose predicates ALL match
 * wins, so the order is the semantics, not a display preference.
 */
export const TIME_CONDITION_RESOURCE: PbxResource = {
	kind: "time-condition",
	tableName: "time_condition",
	table: timeCondition,
	searchColumns: [timeCondition.name, timeCondition.timezone],
	orderBy: [timeCondition.name, timeCondition.id],
	enabledColumn: timeCondition.enabled,
	destinations: [
		{ prefix: "", required: true },
		{ prefix: "nomatch", required: false },
	],
	destinationType: "time-condition",
	// `time_condition_id` on both route tables is `on delete set null`, which would silently open
	// a gate that used to be closed. Refusing the delete keeps the tenant's intent explicit.
	scalarReferences: [
		{
			table: "inbound_route",
			kind: "inbound-route",
			column: "time_condition_id",
			nameColumn: "name",
		},
		{
			table: "outbound_route",
			kind: "outbound-route",
			column: "time_condition_id",
			nameColumn: "name",
		},
	],
};

export const TIME_CONDITION_RULE_RESOURCE: PbxChildResource = {
	kind: "time-condition-rule",
	tableName: "time_condition_rule",
	table: timeConditionRule,
	searchColumns: [],
	orderBy: [timeConditionRule.ordinal, timeConditionRule.id],
	ordinalColumn: timeConditionRule.ordinal,
	enabledColumn: timeConditionRule.enabled,
	destinations: [],
	destinationType: null,
	parentColumn: timeConditionRule.timeConditionId,
	parentKind: "time-condition",
	parentTable: timeCondition,
};
