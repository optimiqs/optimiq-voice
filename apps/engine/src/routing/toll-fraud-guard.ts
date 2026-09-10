import type { HangupCause } from "@optimiq-voice/telephony";

/**
 * The spend/velocity/geo gate on an outbound trunk dial.
 *
 * ## Why this is a PORT and not a function
 *
 * The decision itself is pure — ceilings in, a named refusal out — but two of its three inputs are
 * not. The ceilings come off the compiled artifact, which the walker already holds; the rolling
 * counters come out of `shared_rate_window`, which is a database the walker must never learn about;
 * and the "have we ever called this country" fact is a row that the same call is about to write.
 * A port keeps the walker's dependency at "something that can answer this question", which is what
 * lets a spec answer it with a literal.
 *
 * The ceilings are NOT passed in for the same reason: the walker holds a compiled plan, not the
 * artifact the plan came out of, and threading `settings.tollFraud` down to one node would put a
 * whole configuration block through six call frames to reach one gate. The implementation is built
 * per deployment beside the artifact source and looks its own policy up.
 *
 * ## Why the refusal is named as well as caused
 *
 * `OUTGOING_CALL_BARRED` (Q.850 21) is the correct wire cause and is already what a toll-class
 * refusal carries, so a carrier, a CDR and a report all read it the same way. But four different
 * controls produce it, and a tenant who is told only "call barred" cannot tell "you are over your
 * hourly international minutes" from "this country is on your deny list" — one of those is fixed by
 * waiting and the other never is. So the reason travels beside the cause, in the walker's own note
 * and on the fraud signal, and only the cause goes on the wire.
 */
export interface TollFraudGuardPort {
	/**
	 * Decides one outbound attempt, BEFORE any INVITE and before the caller hears ringback.
	 *
	 * Implementations must be fail-open on their own errors: a counter store that is unreachable is
	 * an operational fault, and refusing every international call in an organization because a query
	 * timed out is a worse outcome than the one this gate exists to prevent. A refusal returned here
	 * is a DECISION, never a failure.
	 */
	authorize(request: TollFraudGuardRequest): Promise<TollFraudGuardVerdict>;
}

export interface TollFraudGuardRequest {
	readonly organizationId: string;
	/** The extension placing the call, when the leg has one. Carries the per-extension override. */
	readonly extensionNumber?: string;
	/** The number as the route resolved it — after digit manipulation, never the dialled string. */
	readonly dialedNumber: string;
	readonly now: number;
}

export type TollFraudGuardVerdict =
	| { readonly kind: "allow" }
	| {
			readonly kind: "refuse";
			/** One of `TOLL_FRAUD_REFUSAL_REASONS`. Kept as a string so the engine does not depend on the api. */
			readonly reason: string;
			/** A sentence for the walker's note and the tenant's report. */
			readonly detail: string;
	  };

/**
 * The cause every toll-fraud refusal hangs up with.
 *
 * Deliberately the same one `packages/routing`'s toll-class gate uses (`compile.ts`'s
 * `TOLL_DENIED_CAUSE`): both are "this caller may not reach this destination", and giving them two
 * causes would split one condition across two rows of every report for no benefit to anyone reading
 * it.
 */
export const TOLL_FRAUD_REFUSAL_CAUSE: HangupCause = "OUTGOING_CALL_BARRED";
