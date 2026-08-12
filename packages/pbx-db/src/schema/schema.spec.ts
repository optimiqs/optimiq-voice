import { describe, expect, it } from "bun:test";
import { getTableName, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { DESTINATION_TYPES, DestinationColumnPrefixError } from "../destinations";
import { pbxTenantContext } from "../tenant";
import { CALL_FLOW_MODES } from "./call-flows-schema";
import { CARRIER_PROVIDERS } from "./carrier-schema";
import { destinationCheck, namedDestinationColumns } from "./columns";
import { DIRECTORY_SEARCH_FIELDS } from "./directory-schema";
import { EXTENSION_USER_ROLES, RECORD_POLICIES, TOLL_CLASSES } from "./extensions-schema";
import { FEATURE_CODE_ACTIONS } from "./features-schema";
import { PROMPT_KINDS } from "./media-schema";
import {
	QUEUE_AGENT_STATUSES,
	QUEUE_PRIORITY_MAX,
	QUEUE_PRIORITY_MIN,
	QUEUE_STRATEGIES,
} from "./queues-schema";
import { pbxRelations } from "./relations";
import { SIP_ACL_SCOPES } from "./security-schema";
import { pbxTables } from "./tables";
import { TIME_CONDITION_OVERRIDES } from "./time-conditions-schema";
import { VOICEMAIL_FOLDERS, VOICEMAIL_TRANSCRIPTION_STATUSES } from "./voicemail-schema";

const tables = Object.values(pbxTables);

const CONST_TUPLES = {
	CALL_FLOW_MODES,
	CARRIER_PROVIDERS,
	DESTINATION_TYPES,
	DIRECTORY_SEARCH_FIELDS,
	EXTENSION_USER_ROLES,
	FEATURE_CODE_ACTIONS,
	PROMPT_KINDS,
	QUEUE_AGENT_STATUSES,
	QUEUE_STRATEGIES,
	RECORD_POLICIES,
	SIP_ACL_SCOPES,
	TIME_CONDITION_OVERRIDES,
	TOLL_CLASSES,
	VOICEMAIL_FOLDERS,
	VOICEMAIL_TRANSCRIPTION_STATUSES,
} as const;

describe("const tuples", () => {
	it("has no duplicate members and uses kebab-case values", () => {
		for (const [name, tuple] of Object.entries(CONST_TUPLES)) {
			expect(new Set(tuple).size, `${name} has duplicates`).toBe(tuple.length);
			for (const value of tuple) {
				expect(value, `${name} member "${value}"`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
			}
		}
	});
});

describe("tenant tables", () => {
	it("registers every table under its own TypeScript key", () => {
		expect(tables.every((table) => table instanceof Table)).toBe(true);
		const names = tables.map((table) => getTableName(table));
		expect(new Set(names).size).toBe(names.length);
	});

	/**
	 * `user_setting` is BACK — this test used to assert its absence, and the inversion is the
	 * point. The table was dropped because it was a cascade level nothing read, and the drop note
	 * in `settings-schema.ts` named four prerequisites for its return: a user-scoped setting
	 * catalogue, the `settings.read.own`/`settings.write.own` pair, a resolver, and a surface. All
	 * four exist now, so the assertion flips from "it must not come back" to "it is here, shaped
	 * the way the resolver needs it".
	 *
	 * Only the SCHEMA half of the prerequisites is assertable here: the catalogue, the resolver
	 * and the surface live in `apps/api`, and `pbx-db` cannot import an application that depends
	 * on it. Their assertions live where they live — `apps/api/test/pbx/orgSettings.test.ts` pins
	 * that the catalogue marks a NON-EMPTY user-scoped set and that `resolveForUser` applies
	 * `code default → org_setting → user_setting`. The permission pair is pinned by
	 * `packages/auth`'s own registry spec.
	 */
	it("registers the user settings level below the organization, shaped for the resolver", () => {
		const names = tables.map((table) => getTableName(table));
		expect(names).toContain("org_setting");
		expect(names).toContain("user_setting");
		expect(Object.keys(pbxTables)).toContain("userSetting");

		const config = getTableConfig(pbxTables.userSetting);
		const columns = new Map(config.columns.map((column) => [column.name, column]));

		// The owner: a better-auth user id from another database. TEXT and FK-less on purpose —
		// this side does not own the identifier's shape, and a malformed id must be an unmatchable
		// row rather than a cast error that rolls back a preferences save.
		expect(columns.get("user_id")?.getSQLType()).toBe("text");
		expect(columns.get("user_id")?.notNull).toBe(true);
		expect(config.foreignKeys).toEqual([]);

		// The same value shape as `org_setting`, because the resolver overlays the levels by name.
		expect(columns.get("value")?.getSQLType()).toBe("jsonb");
		expect(columns.get("value_type")?.default).toBe("string");
		expect(columns.get("enabled")?.default).toBe(true);

		// One override per person per setting, and the preferences screen's read path.
		const unique = config.indexes.find(
			(candidate) => candidate.config.name === "user_setting_organization_user_category_name_key",
		);
		expect(unique?.config.unique).toBe(true);
		expect(unique?.config.columns.map((entry) => ("name" in entry ? entry.name : ""))).toEqual([
			"organization_id",
			"user_id",
			"category",
			"name",
		]);
		expect(
			config.indexes.some(
				(candidate) => candidate.config.name === "user_setting_organization_user_idx",
			),
		).toBe(true);
	});

	it("scopes every table to an organization and enables row-level security", () => {
		for (const table of tables) {
			const config = getTableConfig(table);
			const columnNames = config.columns.map((column) => column.name);
			expect(columnNames, `${config.name} is missing organization_id`).toContain("organization_id");
			expect(config.enableRLS, `${config.name} has RLS disabled`).toBe(true);
		}
	});

	it("makes organization_id NOT NULL so the policy can never compare against NULL", () => {
		for (const table of tables) {
			const config = getTableConfig(table);
			const column = config.columns.find((candidate) => candidate.name === "organization_id");
			expect(column?.notNull, `${config.name}.organization_id is nullable`).toBe(true);
		}
	});

	it("gives every table a uuid primary key named id", () => {
		for (const table of tables) {
			const config = getTableConfig(table);
			const primary = config.columns.filter((column) => column.primary);
			expect(
				primary.map((column) => column.name),
				`${config.name} primary key`,
			).toEqual(["id"]);
			expect(primary[0]?.getSQLType(), `${config.name}.id type`).toBe("uuid");
		}
	});

	it("names every tenant policy after the harness convention and targets the tenant role", () => {
		for (const table of tables) {
			const config = getTableConfig(table);
			expect(config.policies.length, `${config.name} policy count`).toBeGreaterThan(0);
			for (const policy of config.policies) {
				expect(policy.name, `${config.name} policy name`).toMatch(
					new RegExp(`^${config.name}_tenant_(isolation|select|insert)$`, "u"),
				);
				expect(policy.to, `${config.name} policy role`).toBe(pbxTenantContext.role);
				expect(policy.as).toBe("permissive");
			}
		}
	});

	/**
	 * Indexes that span every tenant, and why each one has to.
	 *
	 * The rule this suspends exists because a tenant-scoped query wants the tenant predicate to be
	 * the leading column, so RLS is satisfied by an index seek rather than a filter. These two are
	 * not tenant-scoped queries: both are resolved BEFORE a tenant is known, which is precisely what
	 * makes them global.
	 */
	const DELIBERATELY_GLOBAL_INDEXES = new Set([
		// A provisioning token arrives from a phone that has not told anyone who it belongs to.
		"device_provisioning_token_key",
		// The secret half of the same token, hashed. Global for the same reason, and unique so one
		// stolen URL cannot resolve to two devices.
		"device_provisioning_token_hash_key",
		// A DID has exactly one owner on the PSTN, so it has exactly one owner here. Uniqueness is
		// the point rather than a lookup path: it is what makes "two tenants claim one number"
		// impossible at the moment of the write, and therefore what makes the `did-index` KV bucket
		// safe to treat as a projection with one writer per key.
		"phone_number_e164_global_key",
		// The projection outbox's two sweeper indexes. Leading with `organization_id` would be
		// actively wrong here: the sweeper's question is "which tenants are owed a publish?", asked by
		// a platform process that has no session organization and runs on the untenanted handle. An
		// organization-first index could only be scanned in full for that query, while the partial
		// index below is the size of the backlog — normally empty, because the fast path marks its own
		// row within milliseconds of the commit.
		"pbx_projection_outbox_pending_idx",
		// Retention prunes published rows by age, across every tenant, for the same reason.
		"pbx_projection_outbox_published_idx",
		// The transcription back-fill's index, and exactly the same argument a third time: the
		// question is "which messages ANYWHERE still owe a transcript?", asked on the untenanted
		// handle by a process with no session organization. The tenant-scoped version of the same
		// question already has `voicemail_message_transcription_pending_idx`, which does lead with
		// `organization_id`; this one is partial over the two working statuses and is the size of the
		// backlog rather than of the table.
		"voicemail_message_transcription_sweep_idx",
	]);

	it("leads every composite index with organization_id so the tenant predicate is usable", () => {
		for (const table of tables) {
			const config = getTableConfig(table);
			for (const index of config.indexes) {
				const [first] = index.config.columns;
				const name = index.config.name ?? "<unnamed>";
				if (DELIBERATELY_GLOBAL_INDEXES.has(name)) {
					continue;
				}
				expect(
					first && "name" in first ? first.name : undefined,
					`${config.name} index ${name} does not lead with organization_id`,
				).toBe("organization_id");
			}
		}
	});
});

describe("destination trios", () => {
	it("always ships type, ref and data together with a shape check", () => {
		for (const table of tables) {
			const config = getTableConfig(table);
			const typeColumns = config.columns
				.map((column) => column.name)
				.filter((name) => name.endsWith("destination_type"));
			const columnNames = new Set(config.columns.map((column) => column.name));
			for (const typeColumn of typeColumns) {
				const prefix = typeColumn.replace(/destination_type$/u, "");
				expect(columnNames).toContain(`${prefix}destination_ref`);
				expect(columnNames).toContain(`${prefix}destination_data`);
				const checkName = `${config.name}_${prefix === "" ? "" : prefix}destination_shape_check`;
				expect(
					config.checks.map((constraint) => constraint.name),
					`${config.name} is missing ${checkName}`,
				).toContain(checkName);
			}
		}
	});

	it("never gives destination_ref a foreign key — it is polymorphic by contract", () => {
		for (const table of tables) {
			const config = getTableConfig(table);
			for (const foreignKey of config.foreignKeys) {
				const referencing = foreignKey.reference().columns.map((column) => column.name);
				for (const column of referencing) {
					expect(column.endsWith("destination_ref")).toBe(false);
				}
			}
		}
	});
});

describe("carrier provenance", () => {
	/**
	 * The two tables a managed carrier can create a row in. Anything else gaining a
	 * `carrier_provider` column without gaining the pair and the check is a row that can claim to be
	 * managed while being unactionable — which is how a resource gets orphaned at the carrier.
	 */
	const CARRIER_OWNED_TABLES = ["phone_number", "trunk"] as const;

	it("ships carrier_provider and carrier_ref together, with an all-or-nothing check", () => {
		for (const table of tables) {
			const config = getTableConfig(table);
			const columnNames = new Set(config.columns.map((column) => column.name));
			if (!columnNames.has("carrier_provider") && !columnNames.has("carrier_ref")) {
				continue;
			}
			expect(columnNames, `${config.name} has half a provenance pair`).toContain(
				"carrier_provider",
			);
			expect(columnNames, `${config.name} has half a provenance pair`).toContain("carrier_ref");
			expect(
				config.checks.map((constraint) => constraint.name),
				`${config.name} is missing its carrier shape check`,
			).toContain(`${config.name}_carrier_shape_check`);
		}
	});

	it("keeps provenance nullable so a BYO-SIP trunk and a typed-in DID stay expressible", () => {
		for (const name of CARRIER_OWNED_TABLES) {
			const config = getTableConfig(
				tables.find((table) => getTableName(table) === name) ?? pbxTables.trunk,
			);
			for (const columnName of ["carrier_provider", "carrier_ref"]) {
				const column = config.columns.find((candidate) => candidate.name === columnName);
				expect(column, `${name}.${columnName} is missing`).toBeDefined();
				expect(column?.notNull, `${name}.${columnName} is NOT NULL`).toBe(false);
			}
		}
	});
});

/**
 * The `*8` pickup group.
 *
 * A single nullable text column, and the two things worth pinning about it are both things a
 * later change could quietly take away: NULL has to stay expressible, because NULL is how "in no
 * group" is spelled and the engine's org-wide fallback depends on it; and it must NOT become an
 * enum, a foreign key or an indexed column, because nothing queries by group — the snapshot loader
 * reads every extension whole and the engine answers from the compiled artifact.
 */
describe("pickup groups", () => {
	const extensionConfig = getTableConfig(pbxTables.extension);
	const column = extensionConfig.columns.find((candidate) => candidate.name === "pickup_group");

	it("is a nullable text column on extension, so 'in no group' stays expressible", () => {
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("text");
		expect(column?.notNull).toBe(false);
		expect(column?.hasDefault).toBe(false);
	});

	it("carries no index, because nothing ever queries by group", () => {
		const indexed = extensionConfig.indexes.flatMap((index) =>
			index.config.columns.map((entry) => ("name" in entry ? entry.name : "")),
		);
		expect(indexed).not.toContain("pickup_group");
	});
});

/**
 * Call screening.
 *
 * One boolean, and the two things worth pinning are the two a later change could quietly take away.
 * It must stay NOT NULL with a `false` default, because that default is what every extension that
 * existed before screening did gets, and the only safe reading of such a row is "nobody asked for
 * this" — a `true` default would put a name-recording prompt on the front of every inbound call in
 * every tenant that upgraded. And it must stay a boolean rather than becoming a mode enum: the
 * external-only scope is a decision the engine implements, not a column the tenant configures.
 */
describe("call screening", () => {
	const column = getTableConfig(pbxTables.extension).columns.find(
		(candidate) => candidate.name === "call_screening",
	);

	it("is a NOT NULL boolean that is off by default", () => {
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("boolean");
		expect(column?.notNull).toBe(true);
		expect(column?.default).toBe(false);
	});
});

/**
 * Whisper-on-answer.
 *
 * Nullable and defaultless, because the absence of a whisper is the normal state and the column has
 * to be able to say so: a queue with no whisper prompt bridges the agent straight through, which is
 * what every queue did before the column existed. It references `prompt` like its two caller-facing
 * siblings do, and `set null` on delete for the same reason they use it — losing a prompt should
 * cost a queue its whisper, not cost the tenant the queue.
 */
describe("agent whisper", () => {
	const config = getTableConfig(pbxTables.queue);
	const column = config.columns.find((candidate) => candidate.name === "agent_whisper_prompt_id");

	it("is a nullable uuid with no default", () => {
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("uuid");
		expect(column?.notNull).toBe(false);
		expect(column?.hasDefault).toBe(false);
	});

	it("references the prompt library, so a deleted prompt cannot dangle", () => {
		const foreignKey = config.foreignKeys.find((candidate) =>
			candidate.reference().columns.some((entry) => entry.name === "agent_whisper_prompt_id"),
		);
		expect(foreignKey).toBeDefined();
		expect(getTableName(foreignKey?.reference().foreignTable ?? pbxTables.prompt)).toBe("prompt");
		expect(foreignKey?.onDelete).toBe("set null");
	});
});

/**
 * Paging groups.
 *
 * What is pinned here is the shape a page depends on and nothing else: that membership is a REAL
 * table with two cascading foreign keys (a member that dangles is a page that reaches fewer people
 * than the operator believes it does, silently), that the ordinal is NOT NULL (the fan-out order is
 * the operator's, not the loader's), that the group's number stays nullable behind a partial unique
 * index (a group reachable only through `*81` has none, and several such groups must not collide on
 * NULL), and that both tables carry their tenant-isolation policy.
 */
describe("paging groups", () => {
	const groupConfig = getTableConfig(pbxTables.pagingGroup);
	const memberConfig = getTableConfig(pbxTables.pagingGroupMember);
	const groupColumns = new Map(groupConfig.columns.map((column) => [column.name, column]));
	const memberColumns = new Map(memberConfig.columns.map((column) => [column.name, column]));

	it("names the group's dialable number nullable, so `*81`-only groups stay expressible", () => {
		const column = groupColumns.get("extension_number");
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("text");
		expect(column?.notNull).toBe(false);
		expect(column?.hasDefault).toBe(false);
	});

	it("makes the number index partial, so two groups without one do not collide", () => {
		const index = groupConfig.indexes.find(
			(candidate) => candidate.config.name === "paging_group_organization_extension_number_key",
		);
		expect(index?.config.unique).toBe(true);
		expect(index?.config.where).toBeDefined();
		expect(JSON.stringify(index?.config.where?.queryChunks)).toContain("extension_number");
	});

	it("defaults to a one-way announcement with a thirty-second leg budget", () => {
		expect(groupColumns.get("duplex")?.getSQLType()).toBe("boolean");
		expect(groupColumns.get("duplex")?.notNull).toBe(true);
		expect(groupColumns.get("duplex")?.default).toBe(false);
		expect(groupColumns.get("timeout_seconds")?.getSQLType()).toBe("integer");
		expect(groupColumns.get("timeout_seconds")?.notNull).toBe(true);
		expect(groupColumns.get("timeout_seconds")?.default).toBe(30);
		expect(groupColumns.get("enabled")?.default).toBe(true);
	});

	/**
	 * A page ENDS. Every other entity that receives a call carries a destination trio for what
	 * happens next; this one must not grow one by accident, because there is no "next".
	 */
	it("carries no destination trio, because a page has no continuation", () => {
		const names = groupConfig.columns.map((column) => column.name);
		expect(names.filter((name) => name.endsWith("destination_type"))).toEqual([]);
	});

	it("holds membership on its own table, ordered and cascading from both parents", () => {
		expect(memberColumns.get("ordinal")?.getSQLType()).toBe("integer");
		expect(memberColumns.get("ordinal")?.notNull).toBe(true);
		expect(memberColumns.get("paging_group_id")?.notNull).toBe(true);
		expect(memberColumns.get("extension_id")?.notNull).toBe(true);
		expect(memberColumns.get("enabled")?.default).toBe(true);

		const targets = memberConfig.foreignKeys.map((foreignKey) => ({
			column: foreignKey.reference().columns[0]?.name,
			table: getTableName(foreignKey.reference().foreignTable),
			onDelete: foreignKey.onDelete,
		}));
		expect(targets).toContainEqual({
			column: "paging_group_id",
			table: "paging_group",
			onDelete: "cascade",
		});
		expect(targets).toContainEqual({
			column: "extension_id",
			table: "extension",
			onDelete: "cascade",
		});
	});

	it("refuses a duplicate member and a duplicate position within one group", () => {
		const unique = memberConfig.indexes
			.filter((candidate) => candidate.config.unique)
			.map((candidate) => ({
				name: candidate.config.name,
				columns: candidate.config.columns.map((entry) => ("name" in entry ? entry.name : "")),
			}));
		expect(unique).toContainEqual({
			name: "paging_group_member_group_extension_key",
			columns: ["organization_id", "paging_group_id", "extension_id"],
		});
		expect(unique).toContainEqual({
			name: "paging_group_member_group_ordinal_key",
			columns: ["organization_id", "paging_group_id", "ordinal"],
		});
	});

	it("isolates both tables by tenant under the harness naming convention", () => {
		expect(groupConfig.policies.map((policy) => policy.name)).toEqual([
			"paging_group_tenant_isolation",
		]);
		expect(memberConfig.policies.map((policy) => policy.name)).toEqual([
			"paging_group_member_tenant_isolation",
		]);
		expect(groupConfig.enableRLS).toBe(true);
		expect(memberConfig.enableRLS).toBe(true);
	});
});

/**
 * Voicemail transcription state.
 *
 * The shape here is the whole safety story for a feature that is off by default, so the assertions
 * are about what a later change could quietly take away. `transcription_status` must stay NOT NULL
 * with a `disabled` default, because that default is what a row inserted by anything that has never
 * heard of transcription gets, and the only safe reading of such a row is "nobody is coming for
 * this" — a `pending` default would make every historic message look like an unpaid debt to a
 * back-fill. `transcribed_at` must stay nullable, because it is only ever written in `done`.
 *
 * The pending index must stay PARTIAL. On a healthy deployment `done` and `disabled` are together
 * essentially the whole table; indexing them would buy a write on every filed message to answer a
 * question ("who still owes a transcript") that is only ever asked about the tiny `pending` slice.
 */
describe("voicemail transcription", () => {
	const config = getTableConfig(pbxTables.voicemailMessage);
	const columnsByName = new Map(config.columns.map((column) => [column.name, column]));

	it("keeps the transcript itself on a nullable text column", () => {
		const column = columnsByName.get("transcription");
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("text");
		expect(column?.notNull).toBe(false);
	});

	it("defaults the status to disabled, so a queue is never implied by an insert", () => {
		const column = columnsByName.get("transcription_status");
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("text");
		expect(column?.notNull).toBe(true);
		expect(column?.default).toBe("disabled");
	});

	it("keeps transcribed_at nullable and timezone-aware, because only `done` writes it", () => {
		const column = columnsByName.get("transcribed_at");
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("timestamp with time zone");
		expect(column?.notNull).toBe(false);
		expect(column?.hasDefault).toBe(false);
	});

	it("indexes the backlog partially, on pending alone", () => {
		const index = config.indexes.find(
			(candidate) => candidate.config.name === "voicemail_message_transcription_pending_idx",
		);
		expect(index).toBeDefined();
		// Partial, and on the status the sweep actually looks for.
		expect(index?.config.where).toBeDefined();
		expect(JSON.stringify(index?.config.where?.queryChunks)).toContain("pending");
		// Still organization-first, so the tenant predicate stays usable — the rule above.
		const columns = index?.config.columns.map((entry) => ("name" in entry ? entry.name : ""));
		expect(columns?.[0]).toBe("organization_id");
	});

	it("counts claims on a NOT NULL column that starts at zero", () => {
		// Zero rather than nullable, so "how many attempts has this had" needs no coalesce anywhere and
		// every row filed before the back-fill existed reads as having its whole budget left.
		const column = columnsByName.get("transcription_attempts");
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("integer");
		expect(column?.notNull).toBe(true);
		expect(column?.default).toBe(0);
	});

	it("keeps the claim nullable, because null is what UNCLAIMED means", () => {
		// The compare-and-set is `… WHERE transcription_claimed_at IS NULL OR … < cutoff`. A NOT NULL
		// column with an epoch default would make every historic row permanently claimable-looking and
		// would take the "nobody has ever touched this" state away from the predicate entirely.
		const column = columnsByName.get("transcription_claimed_at");
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("timestamp with time zone");
		expect(column?.notNull).toBe(false);
		expect(column?.hasDefault).toBe(false);
	});

	it("keeps the notification marker nullable and defaultless, because it records a SEND", () => {
		// `email_sent_at` is the once-only gate for a notification that now has three possible senders
		// (the worker, the deferral timeout, the back-fill). A default would claim every message had
		// been emailed, which is the one direction of error that loses mail silently.
		const column = columnsByName.get("email_sent_at");
		expect(column).toBeDefined();
		expect(column?.getSQLType()).toBe("timestamp with time zone");
		expect(column?.notNull).toBe(false);
		expect(column?.hasDefault).toBe(false);
	});

	it("indexes the cross-tenant back-fill on status first, not organization first", () => {
		// The distinction from the pending index above: this query cannot constrain `organization_id`
		// — it is the query that asks WHICH tenants are owed — so a leading tenant column would leave
		// it scanning the whole index.
		const index = config.indexes.find(
			(candidate) => candidate.config.name === "voicemail_message_transcription_sweep_idx",
		);
		expect(index).toBeDefined();
		const columns = index?.config.columns.map((entry) => ("name" in entry ? entry.name : ""));
		expect(columns?.[0]).toBe("transcription_status");
		expect(columns?.[1]).toBe("transcription_claimed_at");
		// Partial over both working statuses, and neither of the two that are ~100% of the table.
		const predicate = JSON.stringify(index?.config.where?.queryChunks);
		expect(predicate).toContain("pending");
		expect(predicate).toContain("failed");
		expect(predicate).not.toContain("disabled");
	});

	it("keeps the mailbox's own switch a plain boolean that is off by default", () => {
		// The per-box opt-in. Transcription needs BOTH this and a configured provider; a deployment
		// that configures a provider must not start transcribing every mailbox it already had.
		const column = getTableConfig(pbxTables.voicemailBox).columns.find(
			(candidate) => candidate.name === "transcription_enabled",
		);
		expect(column?.getSQLType()).toBe("boolean");
		expect(column?.notNull).toBe(true);
		expect(column?.default).toBe(false);
	});
});

describe("destination column helpers", () => {
	it("derives camelCase keys and snake_case column names from one prefix", () => {
		const columns = namedDestinationColumns("timeout");
		expect(Object.keys(columns).sort()).toEqual([
			"timeoutDestinationData",
			"timeoutDestinationRef",
			"timeoutDestinationType",
		]);
	});

	it("refuses a prefix that would not survive as a column name or a TypeScript key", () => {
		expect(() => namedDestinationColumns("call timeout")).toThrow(DestinationColumnPrefixError);
		expect(() => namedDestinationColumns("Timeout")).toThrow(DestinationColumnPrefixError);
	});

	it("names checks so the schema spec can find them from the column name alone", () => {
		expect(destinationCheck("phone_number").name).toBe("phone_number_destination_shape_check");
		expect(destinationCheck("queue", "timeout", true).name).toBe(
			"queue_timeout_destination_shape_check",
		);
	});
});

describe("relations", () => {
	it("configures exactly the tables in the registry", () => {
		expect(new Set(Object.keys(pbxRelations))).toEqual(new Set(Object.keys(pbxTables)));
	});
});

describe("time condition rules", () => {
	it("stores rules on their own ordered table, not on the condition", () => {
		const rule = getTableConfig(pbxTables.timeConditionRule);
		const columnNames = rule.columns.map((column) => column.name);
		expect(columnNames).toContain("ordinal");
		expect(columnNames).toContain("predicates");
		expect(rule.columns.find((column) => column.name === "predicates")?.getSQLType()).toBe("jsonb");
	});

	it("keeps the match / nomatch destinations on the condition itself", () => {
		const condition = getTableConfig(pbxTables.timeCondition);
		const columnNames = condition.columns.map((column) => column.name);
		expect(columnNames).toContain("destination_type");
		expect(columnNames).toContain("nomatch_destination_type");
		expect(columnNames).toContain("timezone");
	});
});

/**
 * The T2 admin block.
 *
 * One describe rather than nine, because what is worth pinning about these tables is the handful of
 * decisions a later edit could quietly reverse — not their column lists, which the generic
 * assertions above already cover for every table in the registry.
 */
describe("call flows", () => {
	const config = getTableConfig(pbxTables.callFlow);
	const columns = new Map(config.columns.map((column) => [column.name, column]));

	/**
	 * THE decision. A mode kept only in a live-state bucket would make a flip free of a recompile and
	 * would also make the compiled artifact an incomplete answer to "where do this tenant's calls go
	 * right now" — see the schema header for why the park-slot precedent puts it on this side.
	 */
	it("persists the mode as a column, so a flip survives every process restarting", () => {
		expect(columns.get("mode")?.getSQLType()).toBe("text");
		expect(columns.get("mode")?.notNull).toBe(true);
		expect(columns.get("mode")?.default).toBe("day");
	});

	it("refuses a mode outside the vocabulary", () => {
		const constraint = config.checks.find((check) => check.name === "call_flow_mode_check");
		expect(constraint).toBeDefined();
	});

	/**
	 * A switch with one position is not a switch. `namedDestinationColumns` produces nullable
	 * columns, so the NON-optional shape check is the only thing making the night trio mandatory.
	 */
	it("requires BOTH destinations, day and night", () => {
		const names = config.checks.map((check) => check.name);
		expect(names).toContain("call_flow_destination_shape_check");
		expect(names).toContain("call_flow_night_destination_shape_check");
		const night = config.checks.find(
			(check) => check.name === "call_flow_night_destination_shape_check",
		);
		// An `optional` trio's check opens with the all-NULL clause. This one must not.
		expect(JSON.stringify(night?.value.queryChunks)).not.toContain(
			"night_destination_type is null and night_destination_ref is null",
		);
	});

	it("keeps the toggle code and the dialable number nullable and separately unique", () => {
		expect(columns.get("feature_code")?.notNull).toBe(false);
		expect(columns.get("extension_number")?.notNull).toBe(false);
		for (const name of [
			"call_flow_organization_feature_code_key",
			"call_flow_organization_extension_number_key",
		]) {
			const index = config.indexes.find((candidate) => candidate.config.name === name);
			expect(index?.config.unique, name).toBe(true);
			expect(index?.config.where, name).toBeDefined();
		}
	});
});

describe("time condition manual override", () => {
	const config = getTableConfig(pbxTables.timeCondition);
	const columns = new Map(config.columns.map((column) => [column.name, column]));

	it("defaults to obeying the clock", () => {
		expect(columns.get("override")?.getSQLType()).toBe("text");
		expect(columns.get("override")?.notNull).toBe(true);
		expect(columns.get("override")?.default).toBe("auto");
	});

	it("constrains the override to the vocabulary the compiler switches on", () => {
		expect(config.checks.map((check) => check.name)).toContain("time_condition_override_check");
	});

	it("carries its own toggle code, unique only among conditions that have one", () => {
		expect(columns.get("override_feature_code")?.notNull).toBe(false);
		const index = config.indexes.find(
			(candidate) =>
				candidate.config.name === "time_condition_organization_override_feature_code_key",
		);
		expect(index?.config.unique).toBe(true);
		expect(index?.config.where).toBeDefined();
	});
});

describe("pin numbers", () => {
	const setConfig = getTableConfig(pbxTables.pinSet);
	const entryConfig = getTableConfig(pbxTables.pinSetEntry);
	const entryColumns = new Map(entryConfig.columns.map((column) => [column.name, column]));

	/**
	 * The whole argument of `pins-schema.ts` in one assertion: upstream's column is the PIN, ours is
	 * a digest, and a column called `pin_number` reappearing here would be the change that undoes it.
	 */
	it("stores a digest and never a PIN", () => {
		const names = entryConfig.columns.map((column) => column.name);
		expect(names).toContain("pin_hash");
		expect(names).not.toContain("pin");
		expect(names).not.toContain("pin_number");
		expect(entryColumns.get("pin_hash")?.notNull).toBe(true);
	});

	/** The identity a CDR names. An array position would shift under a delete; a row does not. */
	it("gives every code a stable ordinal and a label, unique within its set", () => {
		expect(entryColumns.get("ordinal")?.notNull).toBe(true);
		expect(entryColumns.get("label")?.notNull).toBe(false);
		const index = entryConfig.indexes.find(
			(candidate) => candidate.config.name === "pin_set_entry_set_ordinal_key",
		);
		expect(index?.config.unique).toBe(true);
	});

	it("bounds the attempts, because unbounded retries make a four-digit PIN free to guess", () => {
		const columns = new Map(setConfig.columns.map((column) => [column.name, column]));
		expect(columns.get("max_attempts")?.notNull).toBe(true);
		expect(columns.get("max_attempts")?.default).toBe(3);
	});

	it("removes the gate rather than the route when a set is deleted", () => {
		const route = getTableConfig(pbxTables.outboundRoute);
		const key = route.foreignKeys.find(
			(foreignKey) => foreignKey.reference().columns[0]?.name === "pin_set_id",
		);
		expect(key === undefined ? undefined : getTableName(key.reference().foreignTable)).toBe(
			"pin_set",
		);
		expect(key?.onDelete).toBe("set null");
	});
});

describe("number translation rulesets", () => {
	const ruleConfig = getTableConfig(pbxTables.translationRule);
	const columns = new Map(ruleConfig.columns.map((column) => [column.name, column]));

	/**
	 * A rule REWRITES, and only a regex with capture groups can. `exact` and `prefix` have no way to
	 * say "keep the last ten digits", so a `match_kind` column here would be three-quarters dead.
	 */
	it("is regex-only: a rewrite has no other match kind", () => {
		const names = ruleConfig.columns.map((column) => column.name);
		expect(names).toContain("match_pattern");
		expect(names).toContain("replacement");
		expect(names).not.toContain("match_kind");
		expect(columns.get("match_pattern")?.notNull).toBe(true);
		expect(columns.get("replacement")?.notNull).toBe(true);
	});

	it("orders the pipeline and keeps two rules out of one position", () => {
		expect(columns.get("ordinal")?.notNull).toBe(true);
		const index = ruleConfig.indexes.find(
			(candidate) => candidate.config.name === "translation_rule_ruleset_ordinal_key",
		);
		expect(index?.config.unique).toBe(true);
	});

	/** Attachable to BOTH sides — that is the reusability the inline mechanism cannot express. */
	it("attaches to an outbound route and to a trunk's inbound caller id", () => {
		const route = getTableConfig(pbxTables.outboundRoute);
		const trunk = getTableConfig(pbxTables.trunk);
		expect(route.columns.map((column) => column.name)).toContain("translation_ruleset_id");
		expect(trunk.columns.map((column) => column.name)).toContain("inbound_translation_ruleset_id");
		for (const config of [route, trunk]) {
			const key = config.foreignKeys.find((foreignKey) =>
				foreignKey.reference().columns[0]?.name.endsWith("translation_ruleset_id"),
			);
			expect(key?.onDelete).toBe("set null");
		}
	});
});

describe("destination aliases", () => {
	const config = getTableConfig(pbxTables.destinationAlias);
	const names = config.columns.map((column) => column.name);

	/**
	 * The deviation from FusionPBX's "Bridges", asserted rather than only argued: an alias names a
	 * destination trio, and a `dial_string` column reappearing here would be the toll gate reopening.
	 */
	it("names a destination trio, never a raw dial string", () => {
		expect(names).toContain("destination_type");
		expect(names).not.toContain("dial_string");
		expect(names).not.toContain("bridge");
		expect(config.checks.map((check) => check.name)).toContain(
			"destination_alias_destination_shape_check",
		);
	});
});

describe("audio streams", () => {
	const config = getTableConfig(pbxTables.audioStream);
	const columns = new Map(config.columns.map((column) => [column.name, column]));

	/**
	 * The fallback is what stops a driver that cannot play a remote URL from dropping the call in
	 * silence, so its check is NOT the optional one every other secondary trio gets.
	 */
	it("requires somewhere to go when the stream cannot be played", () => {
		const check = config.checks.find(
			(candidate) => candidate.name === "audio_stream_fallback_destination_shape_check",
		);
		expect(check).toBeDefined();
		expect(JSON.stringify(check?.value.queryChunks)).not.toContain(
			"fallback_destination_type is null and fallback_destination_ref is null",
		);
	});

	it("defaults to answering, and to playing until the caller hangs up", () => {
		expect(columns.get("answer_first")?.default).toBe(true);
		expect(columns.get("max_seconds")?.default).toBe(0);
		expect(columns.get("url")?.notNull).toBe(true);
	});
});

describe("phrases", () => {
	const promptConfig = getTableConfig(pbxTables.prompt);
	const stepConfig = getTableConfig(pbxTables.phraseStep);

	/** A phrase IS a prompt row, which is what makes every `*_prompt_id` accept one for free. */
	it("is a prompt kind rather than a table of its own", () => {
		expect(PROMPT_KINDS).toContain("phrase");
	});

	it("loosens object_key only for a phrase, and says so in a constraint", () => {
		const objectKey = promptConfig.columns.find((column) => column.name === "object_key");
		expect(objectKey?.notNull).toBe(false);
		expect(promptConfig.checks.map((check) => check.name)).toContain(
			"prompt_object_key_kind_check",
		);
	});

	/**
	 * A step's audio is `restrict`, not `cascade`: cascading would silently SHORTEN a phrase when
	 * somebody deleted a prompt, and "your call is number in the queue" is worse than a refused
	 * delete. The phrase side cascades, because deleting the phrase should take its steps.
	 */
	it("cascades from the phrase and restricts from the audio", () => {
		const byColumn = new Map(
			stepConfig.foreignKeys.map((foreignKey) => [
				foreignKey.reference().columns[0]?.name,
				foreignKey,
			]),
		);
		expect(byColumn.get("phrase_id")?.onDelete).toBe("cascade");
		expect(byColumn.get("prompt_id")?.onDelete).toBe("restrict");
	});
});

describe("dial-by-name directory", () => {
	const config = getTableConfig(pbxTables.dialByNameDirectory);
	const columns = new Map(config.columns.map((column) => [column.name, column]));

	it("asks for three digits by default and searches the surname", () => {
		expect(columns.get("min_digits")?.default).toBe(3);
		expect(columns.get("search_field")?.default).toBe("last-name");
		expect(config.checks.map((check) => check.name)).toContain(
			"dial_by_name_directory_search_field_check",
		);
	});
});

describe("speed dials", () => {
	const config = getTableConfig(pbxTables.speedDial);
	const names = config.columns.map((column) => column.name);

	/**
	 * A bare number would be a dial string with no route matched, which is the same toll-gate bypass
	 * `destination_alias` refuses. The trio is what keeps a speed dial inside outbound routing.
	 */
	it("points at a destination trio rather than a number", () => {
		expect(names).toContain("destination_type");
		expect(names).not.toContain("number");
		expect(config.checks.map((check) => check.name)).toContain(
			"speed_dial_destination_shape_check",
		);
	});

	it("makes the code unique within the organization", () => {
		const index = config.indexes.find(
			(candidate) => candidate.config.name === "speed_dial_organization_code_key",
		);
		expect(index?.config.unique).toBe(true);
	});
});

describe("organization limits", () => {
	const config = getTableConfig(pbxTables.orgLimit);
	const columns = new Map(config.columns.map((column) => [column.name, column]));

	/**
	 * Every column nullable, because this table arrives after tenants exist and a number in a column
	 * would silently cap every organization already running.
	 */
	it("treats an unset limit as no limit", () => {
		for (const name of ["max_extensions", "max_trunks", "max_concurrent_calls", "max_storage_mb"]) {
			expect(columns.get(name)?.notNull, name).toBe(false);
			expect(columns.get(name)?.hasDefault, name).toBe(false);
		}
	});

	it("holds at most one row per organization", () => {
		const index = config.indexes.find(
			(candidate) => candidate.config.name === "org_limit_organization_key",
		);
		expect(index?.config.unique).toBe(true);
	});
});

/**
 * The contact-centre block on `queue` and `queue_tier`.
 *
 * The two constraints are the ones worth having in the DATABASE rather than only in a DTO, and the
 * reason is the same for both: the engine compares these values with `===` and arithmetic, so a row
 * that got past a form is a feature that silently never fires. An exit key of `"1 "` is a queue
 * whose exit key does nothing, configured by an operator who watched themselves configure it.
 */
describe("queue contact-centre settings", () => {
	const config = getTableConfig(pbxTables.queue);
	const columns = new Map(config.columns.map((column) => [column.name, column]));

	it("replaced the boolean nobody honoured with the record policy everything else uses", () => {
		expect(columns.get("record_policy")?.notNull).toBe(true);
		expect(columns.get("record_policy")?.default).toBe("none");
		expect(columns.has("record_enabled")).toBe(false);
	});

	it("keeps the exit key nullable, because most queues have none", () => {
		expect(columns.get("exit_key")?.notNull).toBe(false);
		expect(columns.get("exit_key")?.hasDefault).toBe(false);
	});

	it("constrains the exit key to one DTMF symbol in the database, not only in a form", () => {
		expect(config.checks.map((check) => check.name)).toContain("queue_exit_key_shape_check");
	});

	it("gives the exit key a full destination trio with the same shape check as the timeout one", () => {
		for (const name of ["exit_destination_type", "exit_destination_ref", "exit_destination_data"]) {
			expect(columns.has(name), name).toBe(true);
		}
		expect(config.checks.map((check) => check.name)).toContain(
			"queue_exit_destination_shape_check",
		);
	});

	/** 0 is `unprioritised`, which is what every queue was before the column existed. */
	it("defaults the priority to the bottom of the scale, and pins the scale", () => {
		expect(columns.get("default_priority")?.notNull).toBe(true);
		expect(columns.get("default_priority")?.default).toBe(QUEUE_PRIORITY_MIN);
		expect(config.checks.map((check) => check.name)).toContain(
			"queue_default_priority_range_check",
		);
		expect(QUEUE_PRIORITY_MAX).toBe(1000);
	});
});

/**
 * The per-tier agent announcement.
 *
 * Nullable and defaultless, like the queue whisper it overrides and for the same reason: the absence
 * of one is the normal state, and the column has to be able to say so — a tier with no prompt falls
 * back to the queue's, which is what every tier did before the column existed.
 */
describe("tier announcements", () => {
	const config = getTableConfig(pbxTables.queueTier);
	const column = config.columns.find((candidate) => candidate.name === "announce_prompt_id");

	it("is a nullable uuid with no default", () => {
		expect(column).toBeDefined();
		expect(column?.notNull).toBe(false);
		expect(column?.hasDefault).toBe(false);
	});

	it("sets null on delete, so losing a prompt costs a tier its cue and not the tenant its tier", () => {
		const foreignKey = config.foreignKeys.find((candidate) =>
			candidate.reference().columns.some((entry) => entry.name === "announce_prompt_id"),
		);
		expect(foreignKey?.onDelete).toBe("set null");
	});
});
