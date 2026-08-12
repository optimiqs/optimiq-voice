import { normalizeSipCallId } from "./channel-identity";
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
 *
 * A THIRD index, by SIP `Call-ID`, is filled in separately ({@link indexSipDialog}) rather than in
 * {@link add}. It has to be: the Call-ID is read off the media server, a B-leg's aggregate is
 * created BEFORE the leg exists to be read from, and a Local channel has no dialog at all — so this
 * index is sparse by nature and an `add` that demanded one would have nothing to give it.
 *
 * A FOURTH, by organization, exists for {@link liveCountFor} — see its note for why the count has to
 * be O(1) and why it is maintained here rather than computed from {@link all}.
 */
export class ChannelRegistry {
	private readonly byAriId = new Map<string, ChannelAggregate>();
	private readonly byChannelId = new Map<string, ChannelAggregate>();
	/** SIP `Call-ID` → the leg carrying that dialog. Sparse; only SIP legs appear. */
	private readonly bySipDialog = new Map<string, ChannelAggregate>();
	/**
	 * The reverse of {@link bySipDialog}, keyed by ARI id.
	 *
	 * Not a convenience — it is the only thing that makes {@link remove} O(1) AND complete. Without
	 * it a teardown would have to either scan the whole dialog map or trust a variable to still say
	 * what it said at index time, and the failure mode of getting that wrong is a map that grows for
	 * the lifetime of the process while pointing at calls that ended hours ago.
	 */
	private readonly sipDialogByAriId = new Map<string, string>();
	/**
	 * Organization → its live legs. Maintained in {@link add} / {@link remove} / {@link clear}.
	 *
	 * A fourth map rather than `all.filter(...)` because the one caller is on the CALL SETUP PATH:
	 * the concurrent-call admission gate asks this question about every arriving call, and
	 * {@link all} allocates a copy of every live leg on the instance before the filter even starts.
	 * At a hundred concurrent calls that is a hundred-element array built per arrival to answer a
	 * question a counter answers for free.
	 */
	private readonly byOrganization = new Map<string, Set<ChannelAggregate>>();
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
		const organization = this.byOrganization.get(aggregate.organizationId);
		if (organization === undefined) {
			this.byOrganization.set(aggregate.organizationId, new Set([aggregate]));
			return;
		}
		organization.add(aggregate);
	}

	/**
	 * How many legs this organization currently holds ON THIS REPLICA.
	 *
	 * The qualifier is the whole caveat and it is stated rather than hidden, on exactly the terms
	 * `trunk-capacity.ts` states its own: the cluster-wide truth is the `channels` KV bucket, keyed
	 * `<org>.<call>.<leg>`, and answering from it means listing and getting every live leg on the
	 * platform on every arriving call. A CAS counter of its own costs two round trips on the call
	 * setup path plus a reaper for a counter whose holder crashed.
	 *
	 * So this counts one process, which means **with N engines the effective ceiling is N times the
	 * configured one**. That is wrong by a known factor and never wrong in the dangerous direction —
	 * it can admit a call it should have refused, it can never refuse one it should have admitted —
	 * and for the single-instance deployment this repo ships it is exact. A cluster-true counter is a
	 * KV wave, and this method is the seam for it.
	 *
	 * Counts LEGS, not calls, which is what the quota means: `org_limit.max_concurrent_calls` is
	 * "simultaneous live channels across the whole organization", and a call that has been bridged to
	 * a desk phone is occupying two of them.
	 */
	liveCountFor(organizationId: string): number {
		return this.byOrganization.get(organizationId)?.size ?? 0;
	}

	byAriChannelId(ariChannelId: string): ChannelAggregate | undefined {
		return this.byAriId.get(ariChannelId);
	}

	byDomainChannelId(channelId: string): ChannelAggregate | undefined {
		return this.byChannelId.get(channelId);
	}

	/**
	 * Records which SIP dialog a leg is carrying. Idempotent, and safe to call again with a new value.
	 *
	 * Both stale directions are cleaned up before the new pair is written: a leg that re-indexes under
	 * a different Call-ID loses its old key, and a Call-ID claimed by a second leg releases the first.
	 * The second case is not hypothetical — a masquerade (an attended transfer completing, a pickup)
	 * moves a dialog from one channel to another, and an index that kept the old pointer would answer
	 * a REFER with a channel that no longer has the call on it.
	 *
	 * A value that is not a usable key is dropped rather than stored, so nothing has to check for the
	 * empty string on the way out. See {@link normalizeSipCallId}.
	 */
	indexSipDialog(aggregate: ChannelAggregate, sipCallId: string): void {
		const key = normalizeSipCallId(sipCallId);
		if (key === undefined) {
			return;
		}
		const previousHolder = this.bySipDialog.get(key);
		if (previousHolder !== undefined && previousHolder !== aggregate) {
			this.sipDialogByAriId.delete(previousHolder.ariChannelId);
		}
		const previousKey = this.sipDialogByAriId.get(aggregate.ariChannelId);
		if (previousKey !== undefined && previousKey !== key) {
			this.bySipDialog.delete(previousKey);
		}
		this.bySipDialog.set(key, aggregate);
		this.sipDialogByAriId.set(aggregate.ariChannelId, key);
	}

	/** The leg carrying this SIP dialog, or `undefined` when this instance holds no such call. */
	bySipCallId(sipCallId: string): ChannelAggregate | undefined {
		const key = normalizeSipCallId(sipCallId);
		return key === undefined ? undefined : this.bySipDialog.get(key);
	}

	/** How many dialogs are indexed. Read by the specs that prove the index does not leak. */
	get sipDialogCount(): number {
		return this.bySipDialog.size;
	}

	remove(aggregate: ChannelAggregate): void {
		this.byAriId.delete(aggregate.ariChannelId);
		this.byChannelId.delete(aggregate.channelId);
		const organization = this.byOrganization.get(aggregate.organizationId);
		if (organization !== undefined) {
			organization.delete(aggregate);
			// The empty set is dropped rather than kept. A tenant whose calls have all ended must not
			// leave a key behind: the map would otherwise grow to one entry per organization this
			// process has ever served and never shrink, which is the leak `sipDialogByAriId` exists to
			// prevent on the other index.
			if (organization.size === 0) {
				this.byOrganization.delete(aggregate.organizationId);
			}
		}
		const sipCallId = this.sipDialogByAriId.get(aggregate.ariChannelId);
		if (sipCallId !== undefined) {
			this.sipDialogByAriId.delete(aggregate.ariChannelId);
			// Only when it is still OURS. A masquerade may have handed this key to another leg, and
			// deleting it here would un-index a live call as a side effect of an unrelated teardown.
			if (this.bySipDialog.get(sipCallId) === aggregate) {
				this.bySipDialog.delete(sipCallId);
			}
		}
	}

	clear(): void {
		this.byAriId.clear();
		this.byChannelId.clear();
		this.bySipDialog.clear();
		this.sipDialogByAriId.clear();
		this.byOrganization.clear();
	}
}
