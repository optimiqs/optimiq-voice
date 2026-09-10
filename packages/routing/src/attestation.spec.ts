import { describe, expect, it } from "bun:test";
import {
	attestationKey,
	decideAttestation,
	isAttestationLevel,
	isCallerIdRightToUse,
	isUnverifiedCallerIdPolicy,
} from "./attestation";
import type { CompiledAttestationPolicy } from "./attestation";

const OWNED = "+12125550100";
const VERIFIED = "+13105550111";
const STRANGER = "+442079460000";

function policyOf(overrides: Partial<CompiledAttestationPolicy> = {}): CompiledAttestationPolicy {
	return {
		unverifiedCallerIdPolicy: "allow",
		rightToUse: { [OWNED]: "owned", [VERIFIED]: "verified" },
		kycApproved: true,
		kycRequiredForOutbound: false,
		...overrides,
	};
}

describe("attestationKey", () => {
	it("normalises separators and a missing plus to one E.164 key", () => {
		expect(attestationKey("+1 (212) 555-0100")).toBe(OWNED);
		expect(attestationKey("12125550100")).toBe(OWNED);
	});

	it("returns an empty key for a value with no digits", () => {
		expect(attestationKey("anonymous")).toBe("");
	});
});

describe("guards", () => {
	it("accept the vocabularies and reject anything else", () => {
		expect(isAttestationLevel("A")).toBe(true);
		expect(isAttestationLevel("D")).toBe(false);
		expect(isCallerIdRightToUse("owned")).toBe(true);
		expect(isCallerIdRightToUse("assumed")).toBe(false);
		expect(isUnverifiedCallerIdPolicy("refuse")).toBe(true);
		expect(isUnverifiedCallerIdPolicy("ignore")).toBe(false);
	});
});

describe("decideAttestation", () => {
	it("gives A to a number the organization owns", () => {
		const decision = decideAttestation(policyOf(), OWNED, OWNED);
		expect(decision.attestation).toBe("A");
		expect(decision.rightToUse).toBe("owned");
		expect(decision.callerIdNumber).toBe(OWNED);
		expect(decision.refusal).toBeUndefined();
	});

	it("gives B to an externally verified number", () => {
		const decision = decideAttestation(policyOf(), VERIFIED, OWNED);
		expect(decision.attestation).toBe("B");
		expect(decision.rightToUse).toBe("verified");
	});

	it("matches a loosely formatted caller id against the table", () => {
		expect(decideAttestation(policyOf(), "1 212 555 0100", OWNED).attestation).toBe("A");
	});

	it("gives C and proceeds under the allow policy", () => {
		const decision = decideAttestation(policyOf(), STRANGER, OWNED);
		expect(decision.attestation).toBe("C");
		expect(decision.rightToUse).toBeUndefined();
		expect(decision.refusal).toBeUndefined();
		expect(decision.callerIdNumber).toBe(STRANGER);
	});

	it("refuses with a named cause under the refuse policy", () => {
		const decision = decideAttestation(
			policyOf({ unverifiedCallerIdPolicy: "refuse" }),
			STRANGER,
			OWNED,
		);
		expect(decision.refusal).toBe("unverified-caller-id");
		expect(decision.attestation).toBe("C");
	});

	it("replaces with the organization's main number and recomputes the level against it", () => {
		const decision = decideAttestation(
			policyOf({ unverifiedCallerIdPolicy: "replace" }),
			STRANGER,
			OWNED,
		);
		expect(decision.callerIdNumber).toBe(OWNED);
		expect(decision.replacedFrom).toBe(STRANGER);
		expect(decision.attestation).toBe("A");
	});

	it("does not launder a C: a main number that is itself unowned stays C", () => {
		const decision = decideAttestation(
			policyOf({ unverifiedCallerIdPolicy: "replace" }),
			STRANGER,
			"+15005550006",
		);
		expect(decision.callerIdNumber).toBe("+15005550006");
		expect(decision.attestation).toBe("C");
	});

	it("refuses rather than presenting the rejected number when there is nothing to replace with", () => {
		const decision = decideAttestation(
			policyOf({ unverifiedCallerIdPolicy: "replace" }),
			STRANGER,
			undefined,
		);
		expect(decision.refusal).toBe("unverified-caller-id");
		expect(decision.callerIdNumber).toBe(STRANGER);
	});

	it("blocks an un-approved tenant ahead of everything else, keeping the level it would have had", () => {
		const decision = decideAttestation(
			policyOf({ kycApproved: false, kycRequiredForOutbound: true }),
			OWNED,
			OWNED,
		);
		expect(decision.refusal).toBe("kyc-not-approved");
		expect(decision.attestation).toBe("A");
	});

	it("does not block an un-approved tenant when the organization does not require KYC", () => {
		const decision = decideAttestation(policyOf({ kycApproved: false }), OWNED, OWNED);
		expect(decision.refusal).toBeUndefined();
	});

	it("handles an absent caller id as unverified", () => {
		const decision = decideAttestation(policyOf(), undefined, OWNED);
		expect(decision.attestation).toBe("C");
		expect(decision.callerIdNumber).toBeUndefined();
	});
});
