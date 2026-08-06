import { sql } from "drizzle-orm";
import { check, text } from "drizzle-orm/pg-core";
import type { CheckBuilder } from "drizzle-orm/pg-core";

/**
 * Carrier provenance columns, shared by the two tables a managed carrier can create rows in:
 * `phone_number` (a DID we ordered on the tenant's behalf) and `trunk` (a SIP connection we
 * provisioned for them).
 *
 * ## Why provenance is a column and not an inference
 *
 * Releasing a DID and deleting a `credential_connection` are **irreversible, billable** operations
 * against somebody else's API. The control plane therefore has to be able to answer "did we create
 * this, and what is its id over there?" from the row itself, atomically with the row's own
 * lifecycle — never by matching an E.164 against a carrier listing at delete time, which is a
 * network call that can time out, lie by omission, or match a number a different platform owns.
 *
 * A BYO-SIP trunk and a hand-entered DID leave both columns NULL, and the delete path stays
 * exactly what it is today: a local row disappears and nothing is said to any carrier. That is the
 * carrier-agnostic half of decision D5 — Telnyx is a first-class managed provider, not a
 * dependency.
 *
 * ## The pair is all-or-nothing
 *
 * `carrier_provider` without `carrier_ref` is a row that claims to be managed but cannot be acted
 * on; `carrier_ref` without `carrier_provider` is an opaque string nobody can interpret. Both
 * states are unrepresentable rather than merely discouraged — the check constraint is the only
 * mechanism that is atomic with the write, and a NULL nobody notices is precisely how a number
 * gets orphaned at the carrier while its row is gone here.
 */

/**
 * Managed carriers. One member today; the tuple exists so a second one is a data change with a
 * migration behind it rather than a new free-text convention.
 */
export const CARRIER_PROVIDERS = ["telnyx"] as const;
export type CarrierProvider = (typeof CARRIER_PROVIDERS)[number];

/**
 * `carrier_provider` / `carrier_ref`: which managed carrier owns the upstream resource, and its
 * identifier over there (a Telnyx `phone_number.id` or `credential_connection.id`).
 *
 * Deliberately NOT in any create/update DTO. Provenance is written by the carrier module inside
 * the same transaction as the row it describes; an admin form that could set it could also make
 * the platform release a number it never ordered.
 */
export function carrierColumns() {
	return {
		carrierProvider: text("carrier_provider").$type<CarrierProvider>(),
		carrierRef: text("carrier_ref"),
	};
}

/** Asserts the provenance pair is either wholly absent or wholly present. */
export function carrierCheck(tableName: string): CheckBuilder {
	return check(
		`${tableName}_carrier_shape_check`,
		sql.raw(
			"(carrier_provider is null and carrier_ref is null) or " +
				"(carrier_provider is not null and carrier_ref is not null)",
		),
	);
}
