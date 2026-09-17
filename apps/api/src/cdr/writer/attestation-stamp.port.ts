/**
 * The attestation stamp the CDR writer asks for, and the compliance area answers.
 *
 * ## Why a port rather than an import
 *
 * `CdrModule` mounts on `CDR_DATABASE_URL` alone and must keep booting with no PBX area present —
 * the same boot independence `pbx-cdr-ports.module.ts` exists to protect. The compliance area lives
 * in `pbx-db` (the KYC file, the verified caller ids, the org settings) so a direct import from this
 * file would make the CDR writer require a telephony database. Instead the CDR area declares the
 * interface and the token, injects it `@Optional()`, and `ComplianceModule` provides it when both
 * areas are up. With it absent the writer files legs exactly as it did before, unstamped — which is
 * the correct degradation, and the same one every other port here degrades to.
 *
 * ## What the stamp is, and what it is not
 *
 * It is a RECONSTRUCTION, written at file time, of the attestation this platform's policy says the
 * leg's presented caller id was entitled to. It is not the attestation that went on the wire: the
 * engine made that decision live, from the routing artifact's own copy of the same policy, and — when
 * the tenant's policy is `replace` — the number in `from_number` is already the post-replacement one.
 * That is precisely why the stamp takes `fromNumber` and no "main number": by the time a leg is
 * filed, `from_number` IS what was presented, so the decision to reconstruct is the one about that
 * number and there is nothing left to replace.
 *
 * The two can disagree, and the disagreement is the point. A leg whose `sip_attestation` (what the
 * downstream carrier saw) differs from its `expected_attestation` (what our policy says it should
 * have been) is either a routing artifact that has gone stale or a signing service that is not doing
 * what we think — and neither is visible without both columns beside each other.
 */

/** Injection token. A Symbol, so nothing can collide with it by typo. */
export const CDR_ATTESTATION_STAMP = Symbol("api/cdr/AttestationStamp");

/** What the stamp adds to a leg. Both fields may be absent when no decision could be reached. */
export interface AttestationStampValues {
	readonly expectedAttestation?: string;
	readonly callerIdRightToUse?: string;
}

export interface AttestationStamp {
	/**
	 * The attestation the tenant's policy entitles `fromNumber` to, or `undefined`.
	 *
	 * Never throws: a stamp that fails must not turn a billing ledger write into a quarantined
	 * message. The implementation swallows and logs; the writer treats `undefined` as "leave the two
	 * columns as the payload had them".
	 */
	readonly stampOutbound: (
		organizationId: string,
		fromNumber: string,
	) => Promise<AttestationStampValues | undefined>;
}
