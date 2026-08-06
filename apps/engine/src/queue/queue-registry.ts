import { Injectable } from "@nestjs/common";
import type { QueueCursorPort, QueuePositionPort } from "./queue-session";

/**
 * The two pieces of queue state that are per PROCESS rather than per call: who is in line, and
 * which agent each queue distributed to last.
 *
 * ## Why these are not in KV
 *
 * They are not facts about the tenant, they are facts about this engine's current work, and both
 * degrade gracefully when they are wrong. A round-robin cursor that resets costs one caller their
 * turn order. A position that is a lower bound tells a caller they are third when they are fifth.
 * Neither is worth a KV round trip per second per waiting caller, and neither is worth the
 * distributed-consensus problem that a genuinely correct shared version would be.
 *
 * ## Where that stops being true
 *
 * With more than one engine instance, {@link QueuePositions} counts only the callers THIS process
 * holds, so an announced position is a lower bound rather than the position. That is an honest
 * degradation — a caller is never told they are further back than they are — but it is a
 * degradation, and the fix is a shared counter on the backbone rather than a cleverer local one.
 * `queue.caller.joined` / `caller.answered` / `caller.abandoned` already carry everything a
 * cluster-wide position would be computed from, so the read model can be built without any new
 * contract.
 *
 * The cursor has the same shape of limitation and a smaller consequence: two instances round-robin
 * independently, which spreads load within each and not across them.
 */

/** One queue's line, in arrival order. */
type Line = string[];

@Injectable()
export class QueuePositions implements QueuePositionPort {
	private readonly lines = new Map<string, Line>();

	/** Waiting callers this process is holding, across every queue. `/healthz` reads it. */
	get waitingCount(): number {
		let total = 0;
		for (const line of this.lines.values()) {
			total += line.length;
		}
		return total;
	}

	join(orgId: string, queueId: string, callId: string): number {
		const line = this.lineFor(orgId, queueId);
		if (!line.includes(callId)) {
			line.push(callId);
		}
		return line.indexOf(callId) + 1;
	}

	/**
	 * Their position now.
	 *
	 * A caller the line has never heard of reports 1 rather than 0 or -1: the event schema's floor is
	 * 1, and "you are next" is the least alarming thing to tell somebody whose bookkeeping this
	 * process has lost.
	 */
	positionOf(orgId: string, queueId: string, callId: string): number {
		const index = this.lineFor(orgId, queueId).indexOf(callId);
		return index < 0 ? 1 : index + 1;
	}

	leave(orgId: string, queueId: string, callId: string): void {
		const key = keyOf(orgId, queueId);
		const line = this.lines.get(key);
		if (line === undefined) {
			return;
		}
		const index = line.indexOf(callId);
		if (index >= 0) {
			line.splice(index, 1);
		}
		if (line.length === 0) {
			// Dropped rather than kept empty: a tenant with a thousand queues would otherwise leave a
			// thousand empty arrays behind after one busy hour.
			this.lines.delete(key);
		}
	}

	private lineFor(orgId: string, queueId: string): Line {
		const key = keyOf(orgId, queueId);
		const existing = this.lines.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const line: Line = [];
		this.lines.set(key, line);
		return line;
	}
}

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
