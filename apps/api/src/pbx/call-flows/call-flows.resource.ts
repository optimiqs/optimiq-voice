import { callFlow } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Call flows — the day/night switch.
 *
 * ## Two REQUIRED trios, which is the only shape in this area that has one
 *
 * Every other secondary trio in this directory is `required: false`: a ring group's timeout, a
 * park lot's, an IVR's invalid branch. All of them are branches a tenant may leave unset, and an
 * unset branch means "release the call". A call flow's night destination is not a branch — it is
 * the other half of the switch, and a flow with one position is not a flow. `call-flows-schema.ts`
 * enforces it with a NON-optional shape check on nullable columns, and this is the half of that
 * sentence the write path speaks.
 *
 * ## The mode is not written through this resource
 *
 * `mode` is a column on the row and is deliberately absent from the write DTOs: it moves through
 * `POST /:id/toggle`, guarded by `call-flows.toggle` rather than `call-flows.write`, because moving
 * the switch and re-pointing the branches are different jobs done by different people. Letting a
 * PATCH set it would put the receptionist's daily action behind the administrator's grant and would
 * also skip the presence write that lights the lamp.
 */
export const CALL_FLOW_RESOURCE: PbxResource = {
	kind: "call-flow",
	tableName: "call_flow",
	table: callFlow,
	searchColumns: [callFlow.name, callFlow.extensionNumber, callFlow.featureCode],
	orderBy: [callFlow.name, callFlow.id],
	enabledColumn: callFlow.enabled,
	destinations: [
		{ prefix: "", required: true },
		{ prefix: "night", required: true },
	],
	destinationType: "call-flow",
};
