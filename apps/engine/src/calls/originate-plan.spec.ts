import { describe, expect, it } from "bun:test";
import { ROUTING_ARTIFACT_VERSION } from "@optimiq-voice/routing";
import { planOriginate } from "./originate-plan";
import type { ExtensionIndexEntry, PlanNodeTable, RoutingArtifact } from "@optimiq-voice/routing";

/**
 * The decidable half of a click-to-call: everything that can be refused before a channel exists.
 *
 * A pure function over the tenant's artifact, so this spec is a table of cases with no media server,
 * no broker and no orchestrator. The two refusals it owns are the two an integrator will actually
 * see — a wrong extension number and a destination the tenant may not dial — and the second is the
 * toll-fraud boundary, which is why it is asserted from both sides.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const NOW = new Date("2026-08-11T12:00:00.000Z");

const TERMINALS = {
	"hangup:UNALLOCATED_NUMBER": {
		id: "hangup:UNALLOCATED_NUMBER",
		kind: "hangup",
		cause: "UNALLOCATED_NUMBER",
	},
	"hangup:OUTGOING_CALL_BARRED": {
		id: "hangup:OUTGOING_CALL_BARRED",
		kind: "hangup",
		cause: "OUTGOING_CALL_BARRED",
	},
	"ext:1001": {
		id: "ext:1001",
		kind: "extension",
		number: "1001",
		extensionId: "0195c0f0-1c2f-7000-8000-0000000000e1",
	},
	"ext:1002": {
		id: "ext:1002",
		kind: "extension",
		number: "1002",
		extensionId: "0195c0f0-1c2f-7000-8000-0000000000e2",
	},
	"trunk:pstn": {
		id: "trunk:pstn",
		kind: "trunk-dial",
		attempts: [
			{
				trunkId: "0195c0f0-1c2f-7000-8000-0000000000c1",
				name: "pstn",
				number: "{dialed}",
				timeoutSeconds: 30,
			},
		],
	},
} as unknown as PlanNodeTable;

interface ArtifactOptions {
	readonly extensions?: Readonly<Record<string, Partial<ExtensionIndexEntry>>>;
	/** Exact internal numbers, as the compiler's `internal.numbers` table carries them. */
	readonly numbers?: Readonly<Record<string, string>>;
	/** Whether the tenant has an outbound rule matching everything. */
	readonly outbound?: boolean;
}

function artifact(options: ArtifactOptions = {}): RoutingArtifact {
	const extensions = options.extensions ?? {
		"1001": { extensionId: "0195c0f0-1c2f-7000-8000-0000000000e1", nodeId: "ext:1001" },
	};
	return {
		artifactVersion: ROUTING_ARTIFACT_VERSION,
		organizationId: ORG,
		snapshotHash: "hash-1",
		compiledAt: "2026-08-11T10:00:00.000Z",
		settings: {},
		nodes: TERMINALS,
		timeConditions: {},
		inbound: { rules: [], didDefaults: {}, noMatchNodeId: "hangup:UNALLOCATED_NUMBER" },
		internal: {
			featureCodes: [],
			voicemailPrefixes: [],
			numbers: Object.fromEntries(
				Object.entries(options.numbers ?? {}).map(([number, nodeId]) => [
					number,
					{ number, kind: "extension", nodeId },
				]),
			),
			mailboxes: {},
			parkSlots: [],
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
		},
		outbound: {
			enabled: true,
			rules:
				options.outbound === true
					? [
							{
								routeId: "0195c0f0-1c2f-7000-8000-0000000000b1",
								name: "everything",
								priority: 100,
								enabled: true,
								patterns: [{ kind: "regex", value: "^\\+?[0-9]{6,15}$" }],
								tollClass: "national",
								nodeId: "trunk:pstn",
							},
						]
					: [],
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
			deniedNodeId: "hangup:OUTGOING_CALL_BARRED",
		},
		callBlock: [],
		extensionsByNumber: Object.fromEntries(
			Object.entries(extensions).map(([number, entry]) => [
				number,
				{ number, tollClass: "national", enabled: true, ...entry },
			]),
		),
		diagnostics: [],
	} as unknown as RoutingArtifact;
}

const TEMPLATE = "PJSIP/{number}";

function plan(options: { readonly from?: string; readonly to?: string } & ArtifactOptions = {}) {
	const { from, to, ...artifactOptions } = options;
	return planOriginate(artifact(artifactOptions), {
		fromExtension: from ?? "1001",
		to: to ?? "1002",
		extensionDialTemplate: TEMPLATE,
		now: NOW,
	});
}

describe("planning a click-to-call", () => {
	it("renders the extension's endpoint through the deployment's dial template", () => {
		const result = plan({ numbers: { "1002": "ext:1002" } });
		expect(result.ok).toBe(true);
		expect(result.ok === true && result.endpoint).toBe("PJSIP/1001");
	});

	it("carries the extension's own outbound caller id when the artifact has one", () => {
		const result = plan({
			numbers: { "1002": "ext:1002" },
			extensions: {
				"1001": {
					extensionId: "0195c0f0-1c2f-7000-8000-0000000000e1",
					nodeId: "ext:1001",
					outboundCallerIdNumber: "+15550001111",
					outboundCallerIdName: "Support",
				},
			},
		});
		expect(result.ok === true && result.callerIdNumber).toBe("+15550001111");
		expect(result.ok === true && result.callerIdName).toBe("Support");
	});

	it("refuses an extension number this tenant does not have", () => {
		const result = plan({ from: "9999", numbers: { "1002": "ext:1002" } });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("unknown_extension");
	});

	it("refuses a disabled extension as unknown, rather than naming the distinction", () => {
		const result = plan({
			numbers: { "1002": "ext:1002" },
			extensions: {
				"1001": {
					extensionId: "0195c0f0-1c2f-7000-8000-0000000000e1",
					nodeId: "ext:1001",
					enabled: false,
				},
			},
		});
		expect(result.ok === false && result.reason).toBe("unknown_extension");
	});

	it("decides the extension BEFORE the target, so a bad extension cannot probe the dial plan", () => {
		// Nothing matches `+15551230000` here either. The reason must still be about the extension.
		const result = plan({ from: "9999", to: "+15551230000" });
		expect(result.ok === false && result.reason).toBe("unknown_extension");
	});

	it("reaches another extension through the internal table", () => {
		const result = plan({ to: "1002", numbers: { "1002": "ext:1002" } });
		expect(result.ok).toBe(true);
	});

	it("falls through to outbound when the target is not an internal number", () => {
		const result = plan({ to: "+15551230000", outbound: true });
		expect(result.ok).toBe(true);
	});

	it("refuses a target that matches neither table — the toll-fraud boundary", () => {
		const result = plan({ to: "+15551230000", outbound: false });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("invalid_target");
	});

	it("trims what it was given, because a dial button's field has whitespace in it", () => {
		const result = planOriginate(artifact({ numbers: { "1002": "ext:1002" } }), {
			fromExtension: " 1001 ",
			to: " 1002 ",
			extensionDialTemplate: TEMPLATE,
			now: NOW,
		});
		expect(result.ok === true && result.endpoint).toBe("PJSIP/1001");
	});
});
