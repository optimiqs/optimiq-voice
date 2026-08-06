import { describe, expect, it } from "bun:test";
import { getTableName, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { DESTINATION_TYPES, DestinationColumnPrefixError } from "../destinations";
import { pbxTenantContext } from "../tenant";
import { CARRIER_PROVIDERS } from "./carrier-schema";
import { destinationCheck, namedDestinationColumns } from "./columns";
import { EXTENSION_USER_ROLES, RECORD_POLICIES, TOLL_CLASSES } from "./extensions-schema";
import { FEATURE_CODE_ACTIONS } from "./features-schema";
import { QUEUE_AGENT_STATUSES, QUEUE_STRATEGIES } from "./queues-schema";
import { pbxRelations } from "./relations";
import { SIP_ACL_SCOPES } from "./security-schema";
import { pbxTables } from "./tables";
import { VOICEMAIL_FOLDERS } from "./voicemail-schema";

const tables = Object.values(pbxTables);

const CONST_TUPLES = {
	CARRIER_PROVIDERS,
	DESTINATION_TYPES,
	EXTENSION_USER_ROLES,
	FEATURE_CODE_ACTIONS,
	QUEUE_AGENT_STATUSES,
	QUEUE_STRATEGIES,
	RECORD_POLICIES,
	SIP_ACL_SCOPES,
	TOLL_CLASSES,
	VOICEMAIL_FOLDERS,
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
		// A DID has exactly one owner on the PSTN, so it has exactly one owner here. Uniqueness is
		// the point rather than a lookup path: it is what makes "two tenants claim one number"
		// impossible at the moment of the write, and therefore what makes the `did-index` KV bucket
		// safe to treat as a projection with one writer per key.
		"phone_number_e164_global_key",
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
