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
		case "shared-line": {
			// A shared line IS where the call went — the caller reached a seizable appearance — on the
			// same terms as `conference` and `park`, and `shared_line.id` is the row behind it. Leaving it
			// unmapped would make every SLA call in the CDR read `unknown`.
			return { destinationType: node.kind, destinationRef: node.sharedLineId };
		}
		case "paging": {
			// A page IS where the call went — the caller dialled a group and reached it — so it is a
			// destination on exactly the terms its neighbours are, and `paging_group.id` is the row
			// behind it. Leaving it unmapped would make every page in the CDR read `unknown`, which is
			// the one thing "did anyone actually page the warehouse?" cannot be answered from.
			return { destinationType: node.kind, destinationRef: node.pagingGroupId };
		}
		case "feature-code": {
			return { destinationType: node.kind, destinationRef: node.featureCodeId };
		}
		case "trunk-dial": {
			return { destinationType: node.kind, destinationRef: node.outboundRouteId };
		}
		case "stream": {
			// The caller listened to a stream; that is where they went. Same terms as `paging`.
			return { destinationType: node.kind, destinationRef: node.audioStreamId };
		}
		case "dial-by-name": {
			// The DIRECTORY, not the extension the caller eventually selected. The walk reports every
			// destination it enters and the extension node reports itself a moment later, so the CDR
			// ends up naming the extension — which is right — while the directory is still visible in
			// the walk's notes. Reporting only the extension would lose "they came through the
			// directory", which is the one question a directory's owner ever asks of a report.
			return { destinationType: node.kind, destinationRef: node.directoryId };
		}
		case "external":
		case "application":
		case "playback": {
			// Value-backed: the type is the whole answer, there is no row to name.
			return { destinationType: node.kind };
		}
		default: {
			// `hangup`, `time-condition` and `call-flow` — a terminal and two gates, none of which is
			// a destination. A call that crossed a day/night switch and then rang an extension was
			// destined for the EXTENSION; recording the switch would make every CDR behind one read
			// `call-flow`, which is true and useless, and is exactly the argument `time-condition`
			// already makes one line up.
			return undefined;
		}
	}
}

/**
 * Whether two destinations name the same place.
 *
 * Exists so the walk can report a destination the moment it enters one without reporting the same
 * one twice: a node revisited by a retry loop — an IVR replaying its greeting, a queue re-entered
 * after a failed transfer — is the same destination, and a second report would be a second KV write
 * saying nothing new.
 */
export function sameDestination(
	left: PlanDestination | undefined,
	right: PlanDestination | undefined,
): boolean {
	return (
		left?.destinationType === right?.destinationType &&
		left?.destinationRef === right?.destinationRef
	);
}
