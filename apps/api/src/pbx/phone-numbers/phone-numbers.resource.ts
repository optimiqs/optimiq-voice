import { phoneNumber } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * DIDs. The table is `phone_number` rather than `number` because `number` is a column name
 * everywhere else in the schema.
 *
 * The required destination trio is the DID's **default** route, taken when no inbound route
 * matches — the compiler tries rules first and falls back to this. It is required, not optional,
 * so "this number rings nothing" is never expressible as a NULL nobody notices.
 *
 * Nothing points at a DID as a destination (`destinationType: null`); `inbound_route.phone_number_id`
 * does reference it, but with `on delete cascade` declared in the schema, so deleting a DID
 * deliberately takes its narrowed routes with it rather than being refused.
 */
export const PHONE_NUMBER_RESOURCE: PbxResource = {
	kind: "phone-number",
	tableName: "phone_number",
	table: phoneNumber,
	searchColumns: [phoneNumber.e164, phoneNumber.label],
	orderBy: [phoneNumber.e164, phoneNumber.id],
	enabledColumn: phoneNumber.enabled,
	destinations: [{ prefix: "", required: true }],
	destinationType: null,
};
