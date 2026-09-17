import { callBlockRule } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Caller screening — the allow/deny list the engine has been honouring since the routing package
 * learned `checkCallBlock`.
 *
 * This resource is the CRUD half of a feature whose enforcement half shipped first, which is worth
 * saying plainly because it explains why there is nothing clever here. `call_block_rule` is already
 * a snapshot collection (`SNAPSHOT_COLLECTIONS`), already compiled (`compileCallBlock`), already
 * consulted on all three resolution paths (inbound DID, internal dial, outbound dial), and already
 * bypassed by emergency numbers. Until now the only way to put a row in it was `INSERT` by hand:
 * the table was reachable by the engine and unreachable by the product.
 *
 * So the declaration is deliberately ordinary. `affectsRouting("call_block_rule")` is TRUE — the
 * table is in `ROUTING_TABLE_TO_ENTITY` — which means every write here recompiles the tenant's
 * artifact inside the write transaction and republishes it. That is the whole integration: a rule
 * saved through this resource is a rule the next call is screened against, with no separate
 * publish step and no second write path to a routing input.
 *
 * ## What is not writable, and why it is still in the row
 *
 * `hit_count` and `last_hit_at` are counters the enforcement side owns. They are absent from both
 * DTOs — `z.strictObject` refuses them rather than dropping them — so a client cannot forge a rule
 * that claims to have blocked four hundred calls. They are NOT in `secretColumns`: reading them is
 * the point. "This rule has never matched anything" is the single most useful thing a screening
 * list can tell an administrator, and hiding it would leave a stale blocklist looking identical to
 * a working one.
 *
 * ## No destination trio
 *
 * `action: "voicemail"` looks like it should carry one, and it does not. The compiler maps the
 * action to a hangup cause (`callBlockHangupCause`) or to the callee's own mailbox — the box the
 * dialed extension already owns — rather than to an arbitrary destination the rule picked. A rule
 * that could re-point a blocked caller anywhere in the dial plan would be an inbound route wearing
 * a blocklist's name, and the reverse-reference scan that protects destinations would then have to
 * treat a screening entry as a routing edge. `destinations: []`, `destinationType: null`: nothing
 * points at a block rule, and a block rule points at nothing.
 */
export const CALL_BLOCK_RULE_RESOURCE: PbxResource = {
	kind: "call-block-rule",
	tableName: "call_block_rule",
	table: callBlockRule,
	searchColumns: [callBlockRule.pattern, callBlockRule.label],
	// Pattern first so the list reads as a screening list rather than as an insertion log; `id` is
	// uuidv7 and unique, so the keyset window can never repeat a row.
	orderBy: [callBlockRule.pattern, callBlockRule.id],
	enabledColumn: callBlockRule.enabled,
	destinations: [],
	destinationType: null,
};
