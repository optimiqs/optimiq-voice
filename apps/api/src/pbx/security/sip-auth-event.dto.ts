import { z } from "zod/v4";
import { SIP_ACL_SCOPES, SIP_AUTH_EVENT_TYPES } from "@optimiq-voice/pbx-db";

/**
 * The query contract for the attack log.
 *
 * Deliberately the same shape as `audit-log.dto.ts` — a defaulted, echoed window, a keyset cursor,
 * exact filters over indexed columns, and no free-text search. Two append-only ledgers in one area
 * that paged differently would be two things for a UI to learn and two places for an off-by-one to
 * hide, and every argument that file makes for the shape holds here more strongly: this table grows
 * fastest exactly when somebody is reading it.
 *
 * ## The window is SEVEN days, not thirty
 *
 * The one place the two ledgers diverge, and it is a statement about what each is for. A change
 * ledger is consulted historically — "who turned outbound calling off last month". An attack log is
 * consulted operationally: something is happening now, or happened last night. Thirty days of an
 * ongoing attack is a lot of rows to page through to reach the ones that matter, and the range is a
 * parameter for the investigation that genuinely needs more.
 */

export const DEFAULT_EVENT_RANGE_DAYS = 7;
export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 200;

const isoDateTime = z.iso.datetime({ offset: true }).or(z.iso.datetime());

export const sipAuthEventQuerySchema = z.object({
	/** Inclusive lower bound on `occurred_at`. Defaults to {@link DEFAULT_EVENT_RANGE_DAYS} before `to`. */
	from: isoDateTime.optional(),
	/** Inclusive upper bound on `occurred_at`. Defaults to now. */
	to: isoDateTime.optional(),

	eventType: z.enum(SIP_AUTH_EVENT_TYPES).optional(),
	scope: z.enum(SIP_ACL_SCOPES).optional(),
	/**
	 * One source address, exactly.
	 *
	 * An address and not a network, even though the column is `inet` and `<<=` would work. A prefix
	 * filter is the shape that invites `?sourceIp=0.0.0.0/0`, which is a full scan of the window
	 * spelled as a filter — and the question an operator actually asks of an attack log is "what has
	 * THIS address been doing", because that is the address they are about to block.
	 */
	sourceIp: z.union([z.ipv4(), z.ipv6()]).optional(),
	/** The attempted account, extension or MAC, exactly as it was recorded. */
	accountRef: z.string().min(1).max(128).optional(),

	limit: z.coerce.number().int().min(1).max(MAX_EVENT_LIMIT).default(DEFAULT_EVENT_LIMIT),
	/** Opaque keyset handle from the previous page's `nextCursor`. */
	cursor: z.string().max(256).optional(),
});

export type SipAuthEventQuery = z.infer<typeof sipAuthEventQuerySchema>;
