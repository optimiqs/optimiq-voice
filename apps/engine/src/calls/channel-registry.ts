import type { ChannelAggregate } from "./channel-aggregate";

/**
 * The engine's live channels, indexed both ways.
 *
 * In-memory and single-instance, exactly like the dispatcher it replaces — but with two
 * differences that matter, both from plan §2.2 defect 6:
 *
 * 1. Every aggregate is mirrored into the `channels` KV bucket by the orchestrator, so this map is
 *    a CACHE of state that survives the process, not the state itself.
 * 2. It knows how to stop accepting new work ({@link closeForNewCalls}), which is what makes a
 *    drain possible instead of a hard kill.
 *
 * Both indexes exist because both directions are hot: ARI events arrive keyed by the media
 * server's channel id, and verbs/events are addressed by the domain leg id.
 */
export class ChannelRegistry {
	private readonly byAriId = new Map<string, ChannelAggregate>();
	private readonly byChannelId = new Map<string, ChannelAggregate>();
	private acceptingNewCalls = true;

	/** Whether new calls are still being admitted. `false` once a drain has begun. */
	get isAccepting(): boolean {
		return this.acceptingNewCalls;
	}

	get size(): number {
		return this.byAriId.size;
	}

	/** Every live leg, in insertion order. */
	get all(): readonly ChannelAggregate[] {
		return [...this.byAriId.values()];
	}

	/**
	 * Stops admitting new calls. Existing legs are untouched.
	 *
	 * The first half of a drain: from here on a `StasisStart` is rejected at the door with a
	 * telephony cause the caller's carrier understands, so the call fails over to another instance
	 * instead of being answered by a process that is about to exit.
	 */
	closeForNewCalls(): void {
		this.acceptingNewCalls = false;
	}

	/** Re-opens the door. Only used by tests. */
	reopen(): void {
		this.acceptingNewCalls = true;
	}

	add(aggregate: ChannelAggregate): void {
		this.byAriId.set(aggregate.ariChannelId, aggregate);
		this.byChannelId.set(aggregate.channelId, aggregate);
	}

	byAriChannelId(ariChannelId: string): ChannelAggregate | undefined {
		return this.byAriId.get(ariChannelId);
	}

	byDomainChannelId(channelId: string): ChannelAggregate | undefined {
		return this.byChannelId.get(channelId);
	}

	remove(aggregate: ChannelAggregate): void {
		this.byAriId.delete(aggregate.ariChannelId);
		this.byChannelId.delete(aggregate.channelId);
	}

	clear(): void {
		this.byAriId.clear();
		this.byChannelId.clear();
	}
}
