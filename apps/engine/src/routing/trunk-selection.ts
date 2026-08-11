/**
 * The order an outbound trunk chain is walked in.
 *
 * Nothing here talks to KV, to the media server or to a clock. It takes the attempts the compiler
 * put in the artifact and returns the sequence the dial loop should try them in — the same shape,
 * and the same reasoning, as `queue-strategy.ts` holds for agents.
 *
 * ## `order` versus `weight`
 *
 * `order` is FAILOVER. A lower `order` is tried first and a higher one only exists to catch the
 * lower one failing; reordering across `order` boundaries would send calls to the backup carrier
 * while the primary is healthy, which is a billing decision nobody made.
 *
 * `weight` is DISTRIBUTION, and it only has meaning **inside** one `order`. Two carriers a tenant
 * bought at 70/30 sit at the same `order` with weights 70 and 30, and the point is that roughly
 * seven calls in ten leave by the first one — not that the first one is preferred and the second
 * is a fallback. That distinction is the whole of `weight`, and it is why this is a weighted
 * SAMPLE rather than a weighted sort: a sort of fixed weights produces one fixed sequence, which
 * is a preference, not a share.
 *
 * The compiler already emits each group high-weight-first with a `trunkId` tiebreak
 * (`compile.ts`), so with no weights present — and with `random` unused — this function is the
 * identity, and the chain behaves exactly as it did before weights were read.
 *
 * ## Sampling without replacement, not "pick one"
 *
 * The result is a full permutation of the group, not a single winner, because the caller is a
 * FAILOVER loop: the trunk chosen for the call may reject it, and the loop must then have
 * somewhere to go. Sampling without replacement gives the first position the intended share and
 * leaves every other member behind it as a fallback, which is both of the things the field
 * promises at once.
 *
 * A member with no weight (or a weight of zero, or a negative one — the artifact is data and data
 * arrives wrong) is not "share zero, never dialled": it takes the tail of its group in the
 * compiler's own order. A trunk a tenant listed is a trunk a tenant wants tried before the call
 * fails; the weight only says it should not be tried FIRST.
 */

import type { TrunkAttempt } from "@optimiq-voice/routing";

/**
 * The chain in the sequence the dial loop should walk it.
 *
 * @param attempts the artifact's attempts, in any order
 * @param random `[0,1)`. Injected so a spec is deterministic — see `queue-strategy.ts`, which
 *   holds the same rule for the same reason.
 */
export function orderTrunkAttempts(
	attempts: readonly TrunkAttempt[],
	random: () => number,
): readonly TrunkAttempt[] {
	if (attempts.length < 2) {
		return attempts;
	}

	const ordered: TrunkAttempt[] = [];
	for (const group of groupsByOrder(attempts)) {
		ordered.push(...weightedSample(group, random));
	}
	return ordered;
}

/**
 * The chain split into failover tiers, lowest `order` first.
 *
 * Within a tier the incoming sequence is preserved: it is the compiler's, it is already total
 * (weight desc, then trunk id), and re-deriving it here would be a second opinion on a decision
 * that has already been made deterministically once.
 */
function groupsByOrder(attempts: readonly TrunkAttempt[]): readonly (readonly TrunkAttempt[])[] {
	const byOrder = new Map<number, TrunkAttempt[]>();
	for (const attempt of attempts) {
		const group = byOrder.get(attempt.order);
		if (group === undefined) {
			byOrder.set(attempt.order, [attempt]);
			continue;
		}
		group.push(attempt);
	}
	return [...byOrder.entries()].sort(([left], [right]) => left - right).map(([, group]) => group);
}

/** A weight the sampler can use: absent, zero, negative and non-finite all mean "unweighted". */
function shareOf(attempt: TrunkAttempt): number {
	const weight = attempt.weight;
	if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
		return 0;
	}
	return weight;
}

/**
 * One tier, permuted so that each member's chance of taking a position is its share of the weight
 * still unassigned at that point.
 *
 * Unweighted members are held back and appended in their incoming order, so a tier where nobody
 * carries a weight comes back untouched and the whole function is a no-op for every artifact
 * compiled before weights were configured.
 */
function weightedSample(
	group: readonly TrunkAttempt[],
	random: () => number,
): readonly TrunkAttempt[] {
	if (group.length < 2) {
		return group;
	}

	const weighted = group.filter((attempt) => shareOf(attempt) > 0);
	const unweighted = group.filter((attempt) => shareOf(attempt) === 0);
	if (weighted.length < 2) {
		return group;
	}

	const remaining = [...weighted];
	const sampled: TrunkAttempt[] = [];
	while (remaining.length > 1) {
		const total = remaining.reduce((sum, attempt) => sum + shareOf(attempt), 0);
		// `random()` is [0,1) so `target` is [0,total); the loop below always lands on a member,
		// and the final `?? 0` covers only a caller whose `random` broke its own contract.
		let target = random() * total;
		let index = remaining.length - 1;
		for (const [candidate, attempt] of remaining.entries()) {
			target -= shareOf(attempt);
			if (target < 0) {
				index = candidate;
				break;
			}
		}
		sampled.push(remaining[index] as TrunkAttempt);
		remaining.splice(index, 1);
	}
	sampled.push(...remaining);
	sampled.push(...unweighted);
	return sampled;
}
