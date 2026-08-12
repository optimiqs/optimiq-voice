import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * Number-translation rulesets — reusable, named digit manipulation.
 *
 * # What already exists, and what this adds
 *
 * `outbound_route` already carries `strip_digits` / `prepend_digits`, and
 * `packages/routing/src/patterns.ts` already applies them with an underflow guard and a dialable
 * prepend allow-list. That mechanism is INLINE and stays exactly as it is: "this route strips the 9
 * people dial for an outside line" is a fact about that route and belongs on it.
 *
 * What upstream's "Number translations" adds is the SHARED layer — a named, ordered list of
 * regex/replace pairs that several gateways and several routes point at, so "how this tenant writes
 * a number on the wire" is edited once. Duplicating it as inline rules on nine routes is how a
 * tenant ends up with eight routes normalised and one not, discovered on the day the ninth carrier
 * rejects a call.
 *
 * So: two mechanisms, one composed after the other, neither replacing the other.
 *
 * # Composition order, and why it is that way round
 *
 * **Outbound** (`outbound_route.translation_ruleset_id`): the route's own `strip`/`prepend` runs
 * FIRST, then the ruleset. The inline pair is the tenant's local dialling habit — stripping the `9`,
 * adding the `1` — and it turns what somebody's fingers did into the number they meant. The ruleset
 * is the normalisation of that number for the wire, and it must see the real number rather than a
 * `9`-prefixed one. Putting the ruleset first would make every ruleset have to know about every
 * route's outside-line prefix, which is precisely the coupling the shared layer exists to remove.
 * This matches upstream, where a route's dialplan condition does its own capture-and-rewrite and the
 * gateway's translation is applied afterwards, closest to the wire.
 *
 * **Inbound** (`trunk.inbound_translation_ruleset_id`): the ruleset runs FIRST and alone, against
 * the caller id arriving from the carrier. There is nothing to compose with — a trunk has no inline
 * manipulation — and the whole point is to turn one carrier's `0044…` and another's `+44…` into the
 * same string before any inbound route, call-block rule or CDR row ever sees it.
 *
 * # Rules are rows, and they are regex-only
 *
 * `match_kind` is deliberately absent. A translation rule is a *rewrite*, and the only match kind
 * that can express a rewrite is a regex with capture groups — `exact` and `prefix` have no way to
 * say "keep the last ten digits". A prefix-shaped rule is a regex with a `^`, which is one concept
 * instead of two, and it keeps this table from growing the four-way `matchKind` switch the ROUTE
 * tables need for a genuinely different reason (they are matching, not rewriting).
 */

export const translationRuleset = pgTable.withRLS(
	"translation_ruleset",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		description: text("description"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("translation_ruleset_organization_name_key").on(table.organizationId, table.name),
		index("translation_ruleset_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("translation_ruleset"),
	],
);

/**
 * One rewrite in a ruleset.
 *
 * Rules are applied in `ordinal` order and every matching rule fires — this is a pipeline, not a
 * first-match table. That is upstream's behaviour and it is the useful one: "strip the international
 * prefix" and "add the plus" are two steps of one normalisation, and a first-match reading would run
 * only the first of them and leave the tenant wondering which half applied.
 *
 * A rule that does not match is a no-op, not a failure. The compiler reports an unmatchable regex
 * (one that cannot be compiled at all) as an error, and a ruleset none of whose rules can ever fire
 * as a warning, for the same reason it does with routes: a ruleset is normally built one rule at a
 * time and half-built configuration must still compile.
 */
export const translationRule = pgTable.withRLS(
	"translation_rule",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		translationRulesetId: uuidEntityId("translation_ruleset_id")
			.notNull()
			.references(() => translationRuleset.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		label: text("label"),
		/** JavaScript regex source, unanchored unless the tenant anchors it. Capture groups feed `replacement`. */
		matchPattern: text("match_pattern").notNull(),
		/**
		 * The replacement, with `$1`-style back-references to `match_pattern`'s capture groups.
		 *
		 * Restricted at compile time to dialable characters plus back-references — the same
		 * `[0-9+*#]` allow-list `applyDigitManipulation` enforces on `prepend_digits`, and for exactly
		 * the same reason: a replacement that could emit `@`, `;` or a space is a route that can
		 * inject SIP syntax into a request URI. An empty string is legal and means "delete the match",
		 * which is how a strip rule is written.
		 */
		replacement: text("replacement").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("translation_rule_ruleset_ordinal_key").on(
			table.organizationId,
			table.translationRulesetId,
			table.ordinal,
		),
		index("translation_rule_organization_ruleset_idx").on(
			table.organizationId,
			table.translationRulesetId,
		),
		tenantIsolationPolicy("translation_rule"),
	],
);
