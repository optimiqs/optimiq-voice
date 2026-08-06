import type { PlanNode } from "@optimiq-voice/routing";

/**
 * The plan node → CDR destination projection.
 *
 * ## Why the engine has its own copy of this
 *
 * `apps/api`'s routing service projects the same thing for the `rpc.routing.v1.resolve` reply, and
 * the two agree field for field. They are not shared because the alternative is worse in both
 * directions: the engine would have to import a NestJS controller's module to fill in a CDR
 * column, or `packages/routing` would have to grow a `cdr-db` vocabulary it has no other reason to
 * know. Both would trade a nine-line switch for a dependency edge across the whole system.
 *
 * The vocabulary is the compiler's, verbatim: the plan-node kind IS the destination type, in
 * kebab-case, exactly as `pbx-db` spells it. `packages/events`' `destinationTypeSchema` accepts
 * kebab-case, so `ring-group` and `time-condition` cross the wire unmodified — one vocabulary from
 * the database column through the compiler to the CDR, with no translation table to drift.
 *
 * `destinationRef` is only set for kinds backed by a row, because the CDR column is a UUID: an
 * `external` node's "ref" is an E.164 string and would fail validation. The TYPE is still reported
 * for those, so a report can tell "forwarded to a mobile" from "hung up".
 */

/** What the CDR records about where a call went. */
export interface PlanDestination {
	readonly destinationType: string;
	readonly destinationRef?: string;
}

/**
 * The destination a node represents, or `undefined` for nodes that are steps rather than
 * destinations.
 *
 * `hangup` and `time-condition` return `undefined` deliberately. A call that traversed a gate and
 * then rang an extension was destined for the EXTENSION; recording the gate — or the terminal that
 * every path ends at — would make every CDR in the system say `hangup`, which is true and useless.
 */
export function planDestinationOf(node: PlanNode): PlanDestination | undefined {
	switch (node.kind) {
		case "extension": {
			return { destinationType: node.kind, destinationRef: node.extensionId };
		}
		case "ring-group": {
			return { destinationType: node.kind, destinationRef: node.ringGroupId };
		}
		case "ivr-menu": {
			return { destinationType: node.kind, destinationRef: node.ivrMenuId };
		}
		case "queue": {
			return { destinationType: node.kind, destinationRef: node.queueId };
		}
		case "voicemail": {
			return { destinationType: node.kind, destinationRef: node.voicemailBoxId };
		}
		case "conference": {
			return { destinationType: node.kind, destinationRef: node.conferenceId };
		}
		case "park": {
			return { destinationType: node.kind, destinationRef: node.parkLotId };
		}
		case "feature-code": {
			return { destinationType: node.kind, destinationRef: node.featureCodeId };
		}
		case "trunk-dial": {
			return { destinationType: node.kind, destinationRef: node.outboundRouteId };
		}
		case "external":
		case "application":
		case "playback": {
			// Value-backed: the type is the whole answer, there is no row to name.
			return { destinationType: node.kind };
		}
		default: {
			// `hangup`, `time-condition` — a terminal and a gate, neither of which is a destination.
			return undefined;
		}
	}
}
