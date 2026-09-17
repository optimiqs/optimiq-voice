import {
	boolean,
	char,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantCompositeForeignKey, tenantIsolationPolicy } from "../tenant";
import { extension } from "./extensions-schema";

/**
 * Spend and velocity controls on international calling, and the evidence they are enforced from.
 *
 * # Why toll classes are not enough, given that toll classes exist
 *
 * `extension.toll_class` already answers "may this extension reach an international route at all",
 * and the compiler enforces it (`packages/routing/src/compile.ts`, `OUTGOING_CALL_BARRED`). That is
 * a STATIC grant: a class the extension either holds or does not, decided once when the extension
 * is created and never again. Every real toll-fraud incident happens to an extension that legally
 * holds `international` — a compromised handset, a stolen SIP password, an insider — and walks out
 * through a permission somebody deliberately granted.
 *
 * So this is the other axis: not "may you", but "how much, how fast, and to where". A class is
 * a door; these are the meter and the geo-fence behind it. They are separate tables from
 * `org_limit` for the same reason: `org_limit` is a commercial quota an owner sets against what the
 * tenant BOUGHT, and this is a security control an administrator sets against what the tenant would
 * never do. Collapsing them would make raising a sales quota also widen a fraud window.
 *
 * # Four tables, and what each one is for
 *
 * - {@link tollFraudPolicy} — one row per organization: the ceilings, the geo lists and the two
 *   holds. Absent means no controls, which is what every tenant carries until somebody sets one.
 * - {@link extensionTollFraudOverride} — one optional row per extension, every field nullable,
 *   NULL meaning "inherit". A call centre's international desk needs a higher ceiling than the
 *   warehouse phone, and the alternative — one org-wide number set to the highest legitimate user —
 *   is a ceiling that protects nobody.
 * - the rolling-window usage the ceilings are compared against, which is NOT a table of this
 *   area's own: it is {@link sharedRateWindow} in `rate-window-schema.ts`, described below.
 * - {@link tollFraudCountrySeen} — which countries this organization has already been observed
 *   calling, so the FIRST call to a new one can be held.
 *
 * # The counters are a TABLE, deliberately, and not a per-process map
 *
 * `apps/engine/src/routing/originate-rate-limit.ts` is a per-process heap and says so in its own
 * header: three replicas allow three times the rate. That is an acceptable shape for a burst
 * limiter whose job is to stop one runaway loop; it is the wrong shape entirely for a spend cap,
 * because an attacker's traffic is spread across every replica by the same load balancer that
 * spreads everyone else's, and a cap that multiplies by the replica count is a cap that was
 * budgeted wrong by an amount nobody wrote down.
 *
 * So the window is a ROW — {@link sharedRateWindow}, keyed by `(organization, scope, key,
 * window_start)` and incremented with `insert … on conflict do update set count = count + excluded`.
 * That is atomic in PostgreSQL without a transaction of our own and without a read-modify-write:
 * concurrent increments serialise on the row lock the upsert already takes, so N replicas produce
 * the same total as one. The cost is a write per completed international leg, which is the same
 * order as the CDR row that leg already produces.
 *
 * It is a SHARED table and not one of this area's, because a spend cap is not the only thing on
 * this platform that needs a counter N replicas agree on, and a second one would be the same three
 * columns under a different name. The scope token (`intl-minutes`, `intl-calls`) is what keeps the
 * tenants of that table apart.
 *
 * NATS KV was the alternative and is not used, for one reason: a compare-and-set on a revision is a
 * RETRY loop under contention, and the contention here is exactly proportional to the attack. A
 * limiter whose cost rises with the thing it is limiting is a limiter that fails open when it
 * matters. The row lock queues instead of spinning.
 *
 * Concurrency is the exception and is NOT stored here: simultaneous international calls are live
 * state the engines hold, the same fact `org_limit.max_concurrent_calls` is enforced from, and a
 * number this table invented would be wrong the moment it was read. The decision function takes it
 * as an argument.
 */

/** How long a counter row covers. Two windows, because two ceilings are expressed against them. */
export const TOLL_FRAUD_WINDOW_KINDS = ["hour", "day"] as const;
export type TollFraudWindowKind = (typeof TOLL_FRAUD_WINDOW_KINDS)[number];

/**
 * What the anomaly detector found. Stored nowhere — this is the vocabulary the `security.evt.v1`
 * event and the audit row share, restated here because the columns that reference it are here.
 */
export const TOLL_FRAUD_SIGNAL_KINDS = [
	"international-minutes-spike",
	"high-risk-prefix",
	"short-call-burst",
	"registration-source-spread",
] as const;
export type TollFraudSignalKind = (typeof TOLL_FRAUD_SIGNAL_KINDS)[number];

/**
 * The organization's fraud policy. One row, every ceiling nullable, NULL meaning "no ceiling".
 *
 * Nullable rather than defaulted for the reason `org_limit` gives at length: this table arrives
 * after tenants exist, and a number in a column would silently start refusing calls for every
 * organization already running. A tenant with no row at all is unconstrained too — the decision
 * function reads an absent policy as an allow — so creating the row is what starts the enforcement
 * rather than what the enforcement depends on.
 */
export const tollFraudPolicy = pgTable.withRLS(
	"toll_fraud_policy",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/**
		 * The master switch, so an administrator can lift every control at once during an incident
		 * without losing the numbers they were tuned to.
		 *
		 * Defaults to `true`, which is safe precisely because every ceiling defaults to NULL: a row
		 * created with no fields set enforces nothing, and the switch only becomes meaningful once
		 * somebody has set something for it to switch off.
		 */
		enabled: boolean("enabled").notNull().default(true),
		/** Simultaneous international legs. Supplied by the engine; see the header. */
		maxConcurrentInternationalCalls: integer("max_concurrent_international_calls"),
		/** Whole minutes of international talk time in a rolling hour. */
		maxInternationalMinutesPerHour: integer("max_international_minutes_per_hour"),
		/** The same over a rolling day. Both may be set; the tighter one refuses first. */
		maxInternationalMinutesPerDay: integer("max_international_minutes_per_day"),
		/**
		 * ISO-3166 alpha-2 codes this organization may call, as a JSON array of strings.
		 *
		 * An ALLOW list and a DENY list rather than one signed list, because they answer different
		 * questions and a tenant almost always wants exactly one of them. A manufacturer with three
		 * overseas plants writes an allow list of three and is finished. A consultancy that calls
		 * everywhere except the half-dozen destinations that appear on every revenue-share fraud
		 * advisory writes a deny list. Made to express both, the allow list wins when both are set:
		 * a destination that is not on an allow list is refused whatever the deny list says, which is
		 * the fail-closed reading.
		 *
		 * NULL is "no list", which is not the same as an empty array — an empty ALLOW list would
		 * refuse every international call, and a tenant who cleared the field did not mean that. The
		 * decision function treats an empty array as absent for exactly that reason.
		 *
		 * `jsonb` rather than `text[]`: every other list-shaped column in this schema is jsonb, the
		 * lists are read whole and never queried into, and a dozen two-character strings is not a
		 * size where the representation matters.
		 */
		allowedCountries: jsonb("allowed_countries").$type<readonly string[]>(),
		/** The complement. See {@link tollFraudPolicy.allowedCountries} for why both exist. */
		deniedCountries: jsonb("denied_countries").$type<readonly string[]>(),
		/**
		 * Hold the first call this organization has ever made to a given country.
		 *
		 * The single highest-yield control on this table, and the cheapest: fraud revenue comes from
		 * destinations the victim has no business relationship with, so "we have never called
		 * Latvia before" is a near-perfect discriminator on the first call and worthless on the
		 * hundredth. It is a HOLD, not a ban — the refusal names itself, an administrator adds the
		 * country to the allow list or the seen table, and the second attempt goes through — because
		 * a permanent ban on every new destination is a control the tenant switches off in week two.
		 */
		holdFirstCallToNewCountry: boolean("hold_first_call_to_new_country").notNull().default(false),
		/**
		 * Refuse international calls outside business hours.
		 *
		 * The other classic: the compromised handset dials at 03:00 local because that is when
		 * nobody is looking, and an office that has never placed an overseas call after 19:00 loses
		 * nothing by saying so. The window is stored as two minute-of-day offsets and a zone rather
		 * than as a cron or a time range, because the only question ever asked of it is "is now
		 * inside it", and a window that WRAPS midnight (20:00 → 07:00, which is the shape everybody
		 * actually wants) is one comparison in that representation and a special case in every
		 * other.
		 */
		offHoursInternationalLock: boolean("off_hours_international_lock").notNull().default(false),
		/** Minutes since local midnight at which the lock begins. Default 20:00. */
		offHoursStartMinute: integer("off_hours_start_minute").notNull().default(1_200),
		/** Minutes since local midnight at which it ends. Default 07:00, so the window wraps. */
		offHoursEndMinute: integer("off_hours_end_minute").notNull().default(420),
		/**
		 * The IANA zone the two offsets are read in. NULL falls back to the organization's
		 * `defaultTimezone` setting, which is what the routing compiler already resolves for time
		 * conditions — restated as a column only so a tenant whose offices are not in their default
		 * zone can say so without moving every time condition.
		 */
		offHoursTimezone: text("off_hours_timezone"),
		/**
		 * Whether a fraud signal from the anomaly detector suspends the extension's outbound calling
		 * on its own, or only raises the event.
		 *
		 * Defaults to `false`, and that default is a judgement rather than caution: an automatic
		 * suspension is a phone that stops working, the detector runs on an hour of CDR and therefore
		 * on heuristics, and a false positive at 09:00 on a Monday is worse for most tenants than an
		 * hour of fraud. A tenant who has decided otherwise turns it on and gets it immediately.
		 */
		autoSuspendOnSignal: boolean("auto_suspend_on_signal").notNull().default(false),
		...auditTimestampColumns(),
	},
	(table) => [
		// One row per organization, in the shape `org_limit` uses: a unique index rather than making
		// `organization_id` the primary key, because every table here has a uuid `id` and the RLS
		// preflight asserts it.
		uniqueIndex("toll_fraud_policy_organization_key").on(table.organizationId),
		index("toll_fraud_policy_organization_idx").on(table.organizationId),
		tenantIsolationPolicy("toll_fraud_policy"),
	],
);

/**
 * One extension's departures from the organization policy. Every field nullable; NULL inherits.
 *
 * Three-valued on purpose. `NULL` is "whatever the org says", a number is "this instead", and
 * `0` — which is a legal value for every ceiling here — is "none at all", which is how a single
 * extension is locked down without touching anybody else's. That third reading is the one an
 * override exists for: the compromised phone is disabled by writing a zero, not by editing the
 * org-wide policy every other extension depends on.
 */
export const extensionTollFraudOverride = pgTable.withRLS(
	"extension_toll_fraud_override",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		extensionId: uuidEntityId("extension_id").notNull(),
		/**
		 * Lift every control for this extension.
		 *
		 * `false` here beats an enabled org policy, which is the only direction that makes sense: an
		 * override that could ENABLE controls the organization has switched off would make the org's
		 * master switch a lie.
		 */
		enabled: boolean("enabled"),
		maxConcurrentInternationalCalls: integer("max_concurrent_international_calls"),
		maxInternationalMinutesPerHour: integer("max_international_minutes_per_hour"),
		maxInternationalMinutesPerDay: integer("max_international_minutes_per_day"),
		allowedCountries: jsonb("allowed_countries").$type<readonly string[]>(),
		deniedCountries: jsonb("denied_countries").$type<readonly string[]>(),
		holdFirstCallToNewCountry: boolean("hold_first_call_to_new_country"),
		offHoursInternationalLock: boolean("off_hours_international_lock"),
		/**
		 * Outbound calling suspended for this extension, by the detector or by an administrator.
		 *
		 * It lives on the OVERRIDE rather than on `extension` because a suspension is a fraud
		 * control with a fraud control's lifecycle — set by the detector, cleared by whoever
		 * investigates — and putting it on the extension row would put it on the screen where
		 * somebody edits a display name, one careless PATCH away from being cleared by accident.
		 */
		outboundSuspended: boolean("outbound_suspended").notNull().default(false),
		/** Why, in one line, so the administrator who finds the phone dead knows what happened. */
		suspendedReason: text("suspended_reason"),
		suspendedAt: utcTimestamp("suspended_at"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("extension_toll_fraud_override_extension_key").on(
			table.organizationId,
			table.extensionId,
		),
		index("extension_toll_fraud_override_organization_idx").on(table.organizationId),
		tenantCompositeForeignKey({
			name: "extension_toll_fraud_override_extension_fk",
			columns: [table.organizationId, table.extensionId],
			foreignColumns: [extension.organizationId, extension.id],
		}),
		tenantIsolationPolicy("extension_toll_fraud_override"),
	],
);

/**
 * Every destination country this organization has been observed calling.
 *
 * The state behind {@link tollFraudPolicy.holdFirstCallToNewCountry}, and the reason that control
 * can be switched on for an existing tenant without holding their entire dial plan on day one: the
 * table is populated by the same path that increments the counters, so a tenant who turns the hold
 * on after a month of normal traffic already has their real destinations in it.
 *
 * A tenant with NO rows here and the hold enabled is the awkward case and is handled where the
 * decision is made rather than here: the first call to the first country would otherwise be refused
 * for every tenant on the day they enable it. `toll-fraud.policy.ts` reads an empty seen-set as
 * "nothing learned yet" and allows, recording the country; the hold begins from the second country
 * onward. That is stated at the function so it can be tested, not buried in a column comment.
 */
export const tollFraudCountrySeen = pgTable.withRLS(
	"toll_fraud_country_seen",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** ISO-3166 alpha-2, upper case. `char(2)` because it is exactly two, always. */
		country: char("country", { length: 2 }).notNull(),
		firstSeenAt: utcTimestamp("first_seen_at").notNull().defaultNow(),
		lastSeenAt: utcTimestamp("last_seen_at").notNull().defaultNow(),
		/** Legs observed. Not a ceiling — evidence, for the screen that explains a hold. */
		callCount: integer("call_count").notNull().default(0),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("toll_fraud_country_seen_key").on(table.organizationId, table.country),
		index("toll_fraud_country_seen_organization_idx").on(table.organizationId),
		tenantIsolationPolicy("toll_fraud_country_seen"),
	],
);
