import { z } from "zod/v4";
import { displayName, internalNumber, patchOf, resettable } from "../shared/dto";

/**
 * A paging group.
 *
 * `extensionNumber` is `.nullish()` for the same reason a ring group's is: a group reachable only
 * through `*81` has no number, and forcing one would make an operator invent digits that then
 * collide with an extension. `null` clears it — the column is genuinely nullable, so this is the
 * "clear it" half of {@link patchOf}'s contract rather than the "reset to the server default" half.
 *
 * There is deliberately no destination trio here. A page does not continue anywhere: the pager
 * speaks, the handsets auto-answer, and the announcement ends when the pager hangs up. See
 * `paging-groups.resource.ts`.
 */
const pagingGroupShape = {
	name: displayName,
	extensionNumber: internalNumber.nullish(),
	/**
	 * `false` is a one-way announcement; `true` is talkback, where members can be heard back.
	 *
	 * Optional, not required, because the column is `notNull().default(false)` and the safe default
	 * is the one that cannot surprise a room: a group that turns out to be one-way is an operator
	 * repeating themselves, a group that turns out to be duplex is fifty open microphones.
	 */
	duplex: z.boolean().optional(),
	/**
	 * How long a member's auto-answered leg may take to come up before it is given up on.
	 *
	 * Five seconds at the bottom, because a handset that has to be reached over a WAN needs more
	 * than a moment and a lower value would silently shrink the group. Three hundred at the top,
	 * which is far past any answer a handset will ever produce — the ceiling is here to stop a
	 * typo pinning fan-out resources open for an hour, not to express a real paging policy. A ring
	 * group's 600 is a different number for a different thing: that one is how long a HUMAN is given
	 * to pick up.
	 */
	timeoutSeconds: resettable(z.int().min(5).max(300)),
	enabled: z.boolean().optional(),
};

export const createPagingGroupDto = z.strictObject(pagingGroupShape);

export const updatePagingGroupDto = patchOf(z.strictObject(pagingGroupShape));

/**
 * One handset in the group.
 *
 * An `extensionId` and a position, and nothing else. A ring-group member carries a destination trio
 * because it may be an external number or another group; a paging member may not, because the
 * engine originates an auto-answered leg to it and only a registered endpoint can be told to pick
 * up. The foreign key is what enforces that, and `on delete cascade` is what removes a deleted
 * extension from every group it was in, in the same transaction rather than on the day of the fire
 * drill.
 */
const pagingGroupMemberShape = {
	extensionId: z.uuid(),
	/** The fan-out position. Rewritten wholesale by `PUT …/members/reorder`. */
	ordinal: z.int().min(0).max(1000),
	enabled: z.boolean().optional(),
};

export const createPagingGroupMemberDto = z.strictObject(pagingGroupMemberShape);

export const updatePagingGroupMemberDto = patchOf(z.strictObject(pagingGroupMemberShape));
