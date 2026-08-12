import { sipAclEntry } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * CIDR access-control entries — the toll-fraud gate.
 *
 * ## What was here before
 *
 * The table. Nothing else. The parity audit (plans/parity-audit-2026-08-11.md, row 1.23, ranked
 * gap #4) calls it "dead schema" and it was half right: `sip_acl_entry` had exactly one reader,
 * `provisioning/render/provision.repository.ts`'s `checkAllowlist`, which the grep behind that row
 * missed because it reaches the table through raw SQL rather than the Drizzle identifier. So the
 * `provisioning` scope was live and the other three — `registration`, `trunk`, `api` — were rows
 * nobody could create and nothing would have read.
 *
 * This resource is the write surface all four have been missing. `registration` and `trunk` are
 * additionally rendered into the media server's `acl.conf` by `acl-conf.ts` and
 * `scripts/generate-sip-acl.ts`.
 *
 * ## No destination trio, nothing points at it, no routing effect
 *
 * An ACL entry is not a place a call goes and nothing holds a foreign key to it, so both
 * destination fields are empty and there are no scalar references — a delete can never orphan
 * anything. `sip_acl_entry` is also absent from `ROUTING_TABLE_TO_ENTITY`, so a write here does not
 * recompile the tenant's routing artifact, which is correct: the compiler has no ACL input and an
 * eviction on every ACL edit would be cache churn with no consumer.
 *
 * The consequence is worth stating plainly, because it is the one thing an administrator will be
 * surprised by: **an edit here does not reach the media server by itself.** The generator has to be
 * run and the transport rebuilt. That is the same delivery `musiconhold.conf` uses and it is
 * documented in the same three places — the generator's header, `apps/asterisk/run.sh`, and
 * `apps/asterisk/README.md`.
 *
 * ## `network` is the natural key, per scope
 *
 * `sip_acl_entry_organization_scope_network_key` means one tenant cannot hold two rules for the
 * same network in the same scope, which is what stops an allow and a deny for `203.0.113.0/24`
 * from both existing and the answer depending on `priority`. A second rule for the same network is
 * a 409, and the entry that is already there is the one to edit.
 *
 * `trunk_id` is deliberately outside that key — see the schema comment on the column. It narrows what
 * a rule ATTRIBUTES, not which rule matches, so admitting the same network twice under two trunks
 * would add an ambiguity the edge's key cannot represent and buy nothing.
 *
 * ## No `scalarReferences`, and no delete guard for the trunk binding
 *
 * `trunk_id` is `on delete cascade`, so deleting a trunk takes its entries with it and there is
 * nothing to refuse. That is the opposite of what `TRUNK_RESOURCE` does for outbound routes, and the
 * asymmetry is the point: a route outlives its trunk as a route with a broken leg somebody repairs,
 * while an ACL entry for a carrier that no longer exists has nothing left to repair. The alternative
 * — `set null` — would turn a rule scoped to one carrier into one for the whole organization, which
 * is an access-control boundary widening as a side effect of an unrelated delete.
 */
export const SIP_ACL_ENTRY_RESOURCE: PbxResource = {
	kind: "sip-acl-entry",
	tableName: "sip_acl_entry",
	table: sipAclEntry,
	/**
	 * `network` is deliberately NOT searchable. Free-text search runs `ilike` over its columns and
	 * `network` is a `cidr`, not text — Postgres refuses the operator, and a cast that made it work
	 * would make `?search=10.` match `110.0.0.0/8`, which is worse than not searching.
	 */
	searchColumns: [sipAclEntry.name, sipAclEntry.description],
	orderBy: [sipAclEntry.priority, sipAclEntry.id],
	enabledColumn: sipAclEntry.enabled,
	destinations: [],
	destinationType: null,
};
