/**
 * Outbound STIR/SHAKEN attestation decisioning, and the caller-id right-to-use it reads.
 *
 * # Why this is ours to decide even though the carrier signs
 *
 * The April 2026 FNPRM (*Enhancing STIR/SHAKEN*) says a voice service provider that serves end
 * users directly makes all attestation-level decisions regardless of whether it has an
 * implementation obligation of its own, and third-party signing is permitted only when the VSP
 * makes those decisions. Telnyx holds the certificate; the question "does this tenant have the
 * right to present this number?" is one only this platform can answer, because only this platform
 * knows which DIDs it sold to whom.
 *
 * # The three levels, and the fact each of them asserts
 *
 * - **A** — full attestation: the platform knows the customer AND knows they have the right to use
 *   the calling number. That is a DID this platform assigned them, and nothing else.
 * - **B** — partial: the platform knows the customer but cannot vouch for the number. That is an
 *   external number the tenant asked to present and somebody here checked a document for.
 * - **C** — gateway: neither. A number a tenant typed into a field.
 *
 * Which is why {@link CallerIdRightToUse} has exactly two values and absence is the third: the
 * absent case is not a missing fact, it is the fact that produces C.
 *
 * # Why the decision is pure, and lives beside the resolver rather than in it
 *
 * `resolveOutbound` already knows the effective caller id — it is the last thing it computes, after
 * the route override, the extension and the org default have all had their say. Feeding that one
 * string plus a compiled table into a function with no clock and no I/O is what makes "why did this
 * call go out as C?" answerable from the artifact alone, months later, by re-running it.
 */

/** The three STIR/SHAKEN attestation levels, most trusted first. */
export const ATTESTATION_LEVELS = ["A", "B", "C"] as const;
export type AttestationLevel = (typeof ATTESTATION_LEVELS)[number];

export function isAttestationLevel(value: unknown): value is AttestationLevel {
	return typeof value === "string" && (ATTESTATION_LEVELS as readonly string[]).includes(value);
}

/**
 * What this platform can say about a tenant's claim on a number it presents.
 *
 * `owned` is a DID this platform assigned — a purchase, a completed port, a number an operator
 * attached to the organization. `verified` is an external number for which somebody recorded a
 * verification document. There is no third value: a number with neither record is simply absent
 * from the table, and absence is what produces C.
 */
export const CALLER_ID_RIGHT_TO_USE = ["owned", "verified"] as const;
export type CallerIdRightToUse = (typeof CALLER_ID_RIGHT_TO_USE)[number];

export function isCallerIdRightToUse(value: unknown): value is CallerIdRightToUse {
	return typeof value === "string" && (CALLER_ID_RIGHT_TO_USE as readonly string[]).includes(value);
}

/**
 * What the organization asks be done when a caller id has no right-to-use record.
 *
 * `allow` is the pre-2026 behaviour and is kept because an existing tenant's calls must not start
 * failing the day this lands; it still stamps C on the leg, so the ledger records the weak claim
 * even where the call proceeds. `replace` substitutes the organization's main number, which is a
 * number it does own, and the attestation is then recomputed against THAT number rather than
 * asserted — a main number that is itself unowned does not launder a C into an A. `refuse` ends
 * the call with a named cause.
 */
export const UNVERIFIED_CALLER_ID_POLICIES = ["allow", "replace", "refuse"] as const;
export type UnverifiedCallerIdPolicy = (typeof UNVERIFIED_CALLER_ID_POLICIES)[number];

export function isUnverifiedCallerIdPolicy(value: unknown): value is UnverifiedCallerIdPolicy {
	return (
		typeof value === "string" &&
		(UNVERIFIED_CALLER_ID_POLICIES as readonly string[]).includes(value)
	);
}

/** The named refusal causes this seam can end an outbound call with. */
export const OUTBOUND_COMPLIANCE_REFUSALS = ["unverified-caller-id", "kyc-not-approved"] as const;
export type OutboundComplianceRefusal = (typeof OUTBOUND_COMPLIANCE_REFUSALS)[number];

/**
 * The compiled attestation block, as the engine reads it out of the artifact.
 *
 * Every field is required because defaulting is the compiler's job — the engine has no settings
 * page and must never have to decide what an absent policy means halfway through an originate. The
 * BLOCK itself is optional on the settings, and absent means "this artifact predates attestation
 * decisioning": a reader that finds it missing does exactly what every release before this one did.
 */
export interface CompiledAttestationPolicy {
	readonly unverifiedCallerIdPolicy: UnverifiedCallerIdPolicy;
	/**
	 * E.164 → what the platform can vouch for, for every number this organization may present.
	 *
	 * A map and not a list because the lookup is per call on the originate path, and because the
	 * two facts it can hold — assigned by us, verified on paper — are exactly the A and B criteria.
	 */
	readonly rightToUse: Readonly<Record<string, CallerIdRightToUse>>;
	/**
	 * Whether this tenant's onboarding review reached `approved`.
	 *
	 * Compiled from the KYC record rather than read live, for the same reason everything else here
	 * is: the engine holds no database handle, and a compliance gate that depended on one would be
	 * a gate that opens when the database is slow.
	 */
	readonly kycApproved: boolean;
	/** Whether an un-approved tenant is actually refused, or merely recorded as un-approved. */
	readonly kycRequiredForOutbound: boolean;
}

/** The decision, and everything the CDR and the diagnostics want to say about it. */
export interface AttestationDecision {
	/** The level this platform asserts for the call, always decided even when the call is refused. */
	readonly attestation: AttestationLevel;
	/** What backed it, absent when nothing did. */
	readonly rightToUse?: CallerIdRightToUse;
	/** The caller id to actually present — the presented one, or the replacement. */
	readonly callerIdNumber?: string;
	/** Set when {@link UnverifiedCallerIdPolicy} `replace` substituted the organization's number. */
	readonly replacedFrom?: string;
	/** Set when the call must not proceed. */
	readonly refusal?: OutboundComplianceRefusal;
	/** One line for the diagnostic and the "why was this call refused?" ticket. */
	readonly reason: string;
}

/**
 * E.164 key normalisation for the right-to-use lookup.
 *
 * The table is compiled from `phone_number.e164`, which is stored E.164 with the `+`. A caller id
 * reaches the resolver from a route override or an extension column, which the compiler has already
 * canonicalised — but a `+` that a tenant typed and a separator they pasted are both cheap to
 * tolerate here, and a lookup miss on formatting alone would silently downgrade a number the
 * platform genuinely owns to C. Digits only, prefixed with `+`.
 */
export function attestationKey(number: string): string {
	const digits = number.replace(/\D/g, "");
	return digits.length === 0 ? "" : `+${digits}`;
}

/** Builds the lookup key map from a right-to-use table, tolerating loosely formatted keys. */
function lookup(
	table: Readonly<Record<string, CallerIdRightToUse>>,
	number: string | undefined,
): CallerIdRightToUse | undefined {
	if (number === undefined || number.length === 0) {
		return undefined;
	}
	return table[number] ?? table[attestationKey(number)];
}

function levelFor(right: CallerIdRightToUse | undefined): AttestationLevel {
	switch (right) {
		case "owned": {
			return "A";
		}
		case "verified": {
			return "B";
		}
		default: {
			return "C";
		}
	}
}

/**
 * Decides the attestation for one outbound call, and what to do about a caller id nobody vouches
 * for.
 *
 * Order matters and is not arbitrary. KYC is checked FIRST because an un-approved tenant may not
 * originate PSTN traffic at all, and deciding an attestation for a call that is not going to happen
 * would put a level in the ledger for a call that never left. The decision is still returned with
 * the refusal, though, because the refusal record is more useful with the level that WOULD have
 * been asserted on it — "we refused a C from an un-approved tenant" is the sentence an enforcement
 * inquiry wants.
 *
 * @param presented the effective caller id the resolver computed, before this seam touches it
 * @param mainNumber the organization's own outbound caller id, the `replace` target
 */
export function decideAttestation(
	policy: CompiledAttestationPolicy,
	presented: string | undefined,
	mainNumber: string | undefined,
): AttestationDecision {
	const right = lookup(policy.rightToUse, presented);

	if (policy.kycRequiredForOutbound && !policy.kycApproved) {
		return compactDecision({
			attestation: levelFor(right),
			rightToUse: right,
			callerIdNumber: presented,
			refusal: "kyc-not-approved",
			reason:
				"the organization's KYC record has not been approved; outbound PSTN calling is blocked",
		});
	}

	if (right !== undefined) {
		return compactDecision({
			attestation: levelFor(right),
			rightToUse: right,
			callerIdNumber: presented,
			reason:
				right === "owned"
					? `caller id ${presented} is assigned to this organization; full attestation A`
					: `caller id ${presented} has a recorded external verification; partial attestation B`,
		});
	}

	switch (policy.unverifiedCallerIdPolicy) {
		case "refuse": {
			return compactDecision({
				attestation: "C",
				callerIdNumber: presented,
				refusal: "unverified-caller-id",
				reason: `caller id ${presented ?? "(none)"} has no right-to-use record and the organization refuses unverified caller ids`,
			});
		}
		case "replace": {
			const replacement = mainNumber;
			if (replacement === undefined || replacement.length === 0) {
				// Nothing to replace it WITH. Refusing is the only remaining honest answer: proceeding
				// would present the very number the policy just rejected, under a policy that says it
				// must not be presented.
				return compactDecision({
					attestation: "C",
					callerIdNumber: presented,
					refusal: "unverified-caller-id",
					reason: `caller id ${presented ?? "(none)"} has no right-to-use record and the organization has no main number to replace it with`,
				});
			}
			const replacementRight = lookup(policy.rightToUse, replacement);
			return compactDecision({
				attestation: levelFor(replacementRight),
				rightToUse: replacementRight,
				callerIdNumber: replacement,
				replacedFrom: presented,
				reason: `caller id ${presented ?? "(none)"} has no right-to-use record; replaced with the organization's main number ${replacement}`,
			});
		}
		default: {
			return compactDecision({
				attestation: "C",
				callerIdNumber: presented,
				reason: `caller id ${presented ?? "(none)"} has no right-to-use record; gateway attestation C`,
			});
		}
	}
}

function compactDecision(decision: AttestationDecision): AttestationDecision {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(decision)) {
		const value = (decision as unknown as Record<string, unknown>)[key];
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out as unknown as AttestationDecision;
}
