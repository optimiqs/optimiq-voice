import { sql } from "drizzle-orm";
import { check, jsonb, text } from "drizzle-orm/pg-core";
import { uuidEntityId } from "@optimiq-voice/db";
import {
	type DestinationData,
	destinationColumnNames,
	DestinationColumnPrefixError,
	destinationConsistencySql,
	type DestinationType,
} from "../destinations";
import type { CheckBuilder } from "drizzle-orm/pg-core";

/**
 * Column builders shared by every table that points a call somewhere. See `src/destinations.ts`
 * for the contract these columns implement.
 */

/**
 * Secondary trios take a single lower-case word so the derived TypeScript keys stay camelCase
 * (`timeout` → `timeoutDestinationType`). This is stricter than the DDL-safety rule
 * `destinationColumnNames` applies, but it raises the same error — one concept, one error type.
 */
const PREFIX_PATTERN = /^[a-z]{1,20}$/u;

function requiredBuilders(names: { type: string; ref: string; data: string }) {
	return {
		type: text(names.type).$type<DestinationType>().notNull(),
		ref: uuidEntityId(names.ref),
		data: jsonb(names.data).$type<DestinationData>(),
	};
}

function optionalBuilders(names: { type: string; ref: string; data: string }) {
	return {
		type: text(names.type).$type<DestinationType>(),
		ref: uuidEntityId(names.ref),
		data: jsonb(names.data).$type<DestinationData>(),
	};
}

type OptionalDestinationBuilders = ReturnType<typeof optionalBuilders>;

/** The table's primary destination: `destination_type` / `destination_ref` / `destination_data`. */
export function destinationColumns() {
	const builders = requiredBuilders(destinationColumnNames());
	return {
		destinationType: builders.type,
		destinationRef: builders.ref,
		destinationData: builders.data,
	};
}

/**
 * A secondary, always-nullable destination trio such as `timeout_destination_*`. The whole trio
 * being NULL means "no destination configured"; the check constraint enforces that.
 */
export function namedDestinationColumns<TPrefix extends string>(
	prefix: TPrefix,
): { [K in `${TPrefix}DestinationType`]: OptionalDestinationBuilders["type"] } & {
	[K in `${TPrefix}DestinationRef`]: OptionalDestinationBuilders["ref"];
} & { [K in `${TPrefix}DestinationData`]: OptionalDestinationBuilders["data"] } {
	if (!PREFIX_PATTERN.test(prefix)) {
		throw new DestinationColumnPrefixError(prefix);
	}
	const builders = optionalBuilders(destinationColumnNames(`${prefix}_`));
	return {
		[`${prefix}DestinationType`]: builders.type,
		[`${prefix}DestinationRef`]: builders.ref,
		[`${prefix}DestinationData`]: builders.data,
	} as unknown as ReturnType<typeof namedDestinationColumns<TPrefix>>;
}

/** Check constraint asserting the trio's shape. `optional` allows the all-NULL "unset" state. */
export function destinationCheck(tableName: string, prefix = "", optional = false): CheckBuilder {
	const suffix = prefix === "" ? "destination" : `${prefix}_destination`;
	return check(
		`${tableName}_${suffix}_shape_check`,
		sql.raw(destinationConsistencySql(prefix === "" ? "" : `${prefix}_`, optional)),
	);
}
