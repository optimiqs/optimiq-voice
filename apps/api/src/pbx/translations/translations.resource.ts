import { translationRule, translationRuleset } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * Number-translation rulesets — the reusable half of digit manipulation.
 *
 * ## Two referring tables, neither of them a destination
 *
 * A ruleset is not somewhere a call goes; it is a rewrite applied on the way. So `destinationType`
 * is `null` and the reverse scan is `scalarReferences` over the two foreign keys that name one: an
 * outbound route's `translation_ruleset_id` and a trunk's `inbound_translation_ruleset_id`.
 * Refusing the delete rather than letting the columns null out is the same call `pin-sets` makes and
 * for a weaker reason — a lost normalisation is cosmetics on the wire rather than a gate removed —
 * but the failure mode is identical: a change that appears to succeed and quietly stops doing
 * something, discovered when a carrier rejects a call.
 */
export const TRANSLATION_RULESET_RESOURCE: PbxResource = {
	kind: "translation-ruleset",
	tableName: "translation_ruleset",
	table: translationRuleset,
	searchColumns: [translationRuleset.name, translationRuleset.description],
	orderBy: [translationRuleset.name, translationRuleset.id],
	enabledColumn: translationRuleset.enabled,
	destinations: [],
	destinationType: null,
	scalarReferences: [
		{
			table: "outbound_route",
			kind: "outbound-route",
			column: "translation_ruleset_id",
			nameColumn: "name",
		},
		{
			table: "trunk",
			kind: "trunk",
			column: "inbound_translation_ruleset_id",
			nameColumn: "name",
		},
	],
};

/**
 * One rewrite.
 *
 * `ordinalColumn` because the rules are a PIPELINE — every matching rule fires, each seeing the last
 * one's output — so the order is the whole semantics rather than a display preference. "Strip the
 * international prefix" before "add the plus" produces a number; the other way round produces
 * nonsense.
 */
export const TRANSLATION_RULE_RESOURCE: PbxChildResource = {
	kind: "translation-rule",
	tableName: "translation_rule",
	table: translationRule,
	searchColumns: [translationRule.label, translationRule.matchPattern],
	orderBy: [translationRule.ordinal, translationRule.id],
	ordinalColumn: translationRule.ordinal,
	enabledColumn: translationRule.enabled,
	destinations: [],
	destinationType: null,
	parentColumn: translationRule.translationRulesetId,
	parentKind: "translation-ruleset",
	parentTable: translationRuleset,
};
