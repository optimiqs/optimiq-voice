import { describe, expect, it } from "bun:test";
import { resolveRecordingConsent } from "./recording-consent";
import type { CompiledRoutingSettings } from "@optimiq-voice/routing";

type CompiledRecordingPolicy = NonNullable<CompiledRoutingSettings["recording"]>;

/** The compiler's own defaults, with the shipped region list abbreviated to what these cases need. */
function policy(overrides: Partial<CompiledRecordingPolicy> = {}): CompiledRecordingPolicy {
	return {
		consentPolicy: "none",
		acceptDigit: "1",
		declineDigit: "2",
		allPartyRegions: ["US-CA", "EU"],
		autoPauseOnDtmf: false,
		...overrides,
	};
}

/** California and New York. One is an all-party jurisdiction on the list above; the other is not. */
const CALIFORNIA = "+14155550100";
const NEW_YORK = "+12125550100";

describe("resolveRecordingConsent", () => {
	it("decides nothing at all for an artifact compiled before the policy existed", () => {
		expect(
			resolveRecordingConsent(undefined, {
				callerIdNumber: CALIFORNIA,
				destinationNumber: CALIFORNIA,
			}),
		).toEqual({
			policy: "none",
			acceptDigit: "1",
			declineDigit: "2",
			parties: [],
			regions: [],
		});
	});

	it("leaves a `none` tenant alone when no configured jurisdiction is touched", () => {
		const resolved = resolveRecordingConsent(policy(), {
			callerIdNumber: NEW_YORK,
			destinationNumber: NEW_YORK,
		});
		expect(resolved.policy).toBe("none");
		expect(resolved.parties).toEqual([]);
		expect(resolved.regions).toEqual([]);
	});

	it("upgrades `none` to an announcement to BOTH sides in an all-party jurisdiction", () => {
		const resolved = resolveRecordingConsent(policy(), {
			callerIdNumber: CALIFORNIA,
			destinationNumber: NEW_YORK,
		});
		expect(resolved.policy).toBe("announce");
		expect(resolved.parties).toEqual(["caller", "callee"]);
		expect(resolved.regions).toEqual(["US-CA"]);
	});

	it("announces to the recorded leg alone on an INBOUND call no jurisdiction forced", () => {
		const resolved = resolveRecordingConsent(policy({ consentPolicy: "announce" }), {
			callerIdNumber: NEW_YORK,
			destinationNumber: NEW_YORK,
			direction: "inbound",
		});
		expect(resolved.parties).toEqual(["caller"]);
		expect(resolved.regions).toEqual([]);
	});

	it("reads an unstated direction as inbound, exactly as every caller before it behaved", () => {
		const resolved = resolveRecordingConsent(policy({ consentPolicy: "announce" }), {
			callerIdNumber: NEW_YORK,
			destinationNumber: NEW_YORK,
		});
		expect(resolved.parties).toEqual(["caller"]);
	});

	it("announces to BOTH sides of an OUTBOUND call even where no jurisdiction matched", () => {
		// The recorded leg is the tenant's agent; the far end is the person being recorded, and they
		// are the whole reason the announcement exists.
		const resolved = resolveRecordingConsent(policy({ consentPolicy: "announce" }), {
			callerIdNumber: NEW_YORK,
			destinationNumber: NEW_YORK,
			direction: "outbound",
		});
		expect(resolved.parties).toEqual(["caller", "callee"]);
		expect(resolved.regions).toEqual([]);
	});

	it("still widens an outbound keypress policy's ANNOUNCEMENT and not its question", () => {
		const resolved = resolveRecordingConsent(
			policy({ consentPolicy: "announce-and-require-keypress" }),
			{ callerIdNumber: NEW_YORK, destinationNumber: NEW_YORK, direction: "outbound" },
		);
		expect(resolved.policy).toBe("announce-and-require-keypress");
		expect(resolved.parties).toEqual(["caller", "callee"]);
	});

	it("does NOT make an outbound call announce when the tenant asked for no announcement", () => {
		const resolved = resolveRecordingConsent(policy(), {
			callerIdNumber: NEW_YORK,
			destinationNumber: NEW_YORK,
			direction: "outbound",
		});
		expect(resolved.policy).toBe("none");
		expect(resolved.parties).toEqual([]);
	});

	it("widens an announcement to both sides once a jurisdiction matches", () => {
		const resolved = resolveRecordingConsent(policy({ consentPolicy: "announce" }), {
			callerIdNumber: NEW_YORK,
			destinationNumber: CALIFORNIA,
		});
		expect(resolved.parties).toEqual(["caller", "callee"]);
	});

	it("leaves a keypress policy a keypress: an upgrade never asks two parties for a digit", () => {
		const resolved = resolveRecordingConsent(
			policy({ consentPolicy: "announce-and-require-keypress" }),
			{ callerIdNumber: CALIFORNIA, destinationNumber: CALIFORNIA },
		);
		expect(resolved.policy).toBe("announce-and-require-keypress");
		// Both sides still HEAR it; only one of them is asked to answer, which the gate does on the
		// recorded leg.
		expect(resolved.parties).toEqual(["caller", "callee"]);
	});

	it("lets the DID override beat the org, in both directions", () => {
		const stricter = resolveRecordingConsent(policy({ consentPolicy: "announce" }), {
			didConsentPolicy: "announce-and-require-keypress",
			callerIdNumber: NEW_YORK,
			destinationNumber: NEW_YORK,
		});
		expect(stricter.policy).toBe("announce-and-require-keypress");

		const looser = resolveRecordingConsent(policy({ consentPolicy: "announce" }), {
			didConsentPolicy: "none",
			callerIdNumber: NEW_YORK,
			destinationNumber: NEW_YORK,
		});
		expect(looser.policy).toBe("none");
		expect(looser.parties).toEqual([]);
	});

	it("still upgrades a DID that overrode the org down to `none`, in an all-party jurisdiction", () => {
		const resolved = resolveRecordingConsent(policy({ consentPolicy: "announce" }), {
			didConsentPolicy: "none",
			callerIdNumber: CALIFORNIA,
			destinationNumber: NEW_YORK,
		});
		expect(resolved.policy).toBe("announce");
		expect(resolved.parties).toEqual(["caller", "callee"]);
	});

	it("takes the DID's prompt over the org's, and inherits the org's when the DID names none", () => {
		const overridden = resolveRecordingConsent(
			policy({ consentPolicy: "announce", consentPromptId: "org-prompt" }),
			{ didConsentPromptId: "did-prompt" },
		);
		expect(overridden.promptId).toBe("did-prompt");

		const inherited = resolveRecordingConsent(
			policy({ consentPolicy: "announce", consentPromptId: "org-prompt" }),
			{ didConsentPolicy: "announce-and-require-keypress" },
		);
		expect(inherited.promptId).toBe("org-prompt");
	});

	it("omits the prompt entirely when neither level names one", () => {
		expect(
			resolveRecordingConsent(policy({ consentPolicy: "announce" }), {}).promptId,
		).toBeUndefined();
	});

	it("carries the tenant's own digits through", () => {
		const resolved = resolveRecordingConsent(
			policy({
				consentPolicy: "announce-and-require-keypress",
				acceptDigit: "5",
				declineDigit: "9",
			}),
			{},
		);
		expect(resolved.acceptDigit).toBe("5");
		expect(resolved.declineDigit).toBe("9");
	});

	it("decides nothing from a jurisdiction when the tenant emptied the region list", () => {
		const resolved = resolveRecordingConsent(policy({ allPartyRegions: [] }), {
			callerIdNumber: CALIFORNIA,
			destinationNumber: CALIFORNIA,
		});
		expect(resolved.policy).toBe("none");
		expect(resolved.regions).toEqual([]);
	});
});
