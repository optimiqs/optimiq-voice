import { Injectable } from "@nestjs/common";
import type { QueueCursorPort } from "./queue-session";

/**
 * The one piece of queue state that is still per PROCESS rather than per call: which agent each
 * queue distributed to last.
 *
 * ## Why this is not in KV, when the waiting line now is
 *
 * The line moved to the backbone (`queue-waiting.ts`) because being wrong about it is a caller told
 * they are third when they are ninth, and because priority ordering is meaningless unless every
 * instance sorts one list. The cursor is a different shape of fact: it is a fairness HEURISTIC, not
 * a ledger, and being wrong about it costs exactly one caller their turn order. Two instances
 * round-robin independently, which spreads load within each and not across them — worth a sentence,
 * not worth a KV round trip per distribution and the contention that comes with it.
 *
 * If that ever stops being true, the shape is already there: a cursor is one string per queue, and
 * the waiting record it would sit beside is written under compare-and-set on every join anyway.
 */

@Injectable()
export class QueueCursors implements QueueCursorPort {
	private readonly cursors = new Map<string, string>();

	lastAgentFor(orgId: string, queueId: string): string | undefined {
		return this.cursors.get(keyOf(orgId, queueId));
	}

	remember(orgId: string, queueId: string, agentId: string): void {
		this.cursors.set(keyOf(orgId, queueId), agentId);
	}
}

function keyOf(orgId: string, queueId: string): string {
	return `${orgId}/${queueId}`;
}
