import { describe, expect, it } from "bun:test";
import { ROUTING_ARTIFACT_VERSION } from "@optimiq-voice/routing";
import { planOriginate, planQueueCallback } from "./originate-plan";
import type { QueueCallbackPlanInput } from "./originate-plan";
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
								// `id` and `destinationNodeId` are the field names `resolveOutbound`
								// reads. A rule spelled `routeId`/`nodeId` still MATCHES and then
								// resolves to `plan: undefined`, so the case below would pass
								// without ever exercising `planNodeId`.
								id: "0195c0f0-1c2f-7000-8000-0000000000b1",
								name: "everything",
								priority: 100,
								enabled: true,
								patterns: [{ kind: "regex", value: "^\\+?[0-9]{6,15}$" }],
								tollClass: "national",
								destinationNodeId: "trunk:pstn",
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

	/**
	 * The CLIR setting is not on `ExtensionIndexEntry` yet — the column, the compiler mapping and the
	 * API surface are still to come — so the fixture writes it the way the compiler eventually will,
	 * and the plan is asserted to carry it through untouched. Absent stays absent, which the edge
	 * reads as `allowed`.
	 */
	it("carries the extension's caller-id presentation, and omits it when unset", () => {
		const entry = {
			extensionId: "0195c0f0-1c2f-7000-8000-0000000000e1",
			nodeId: "ext:1001" as const,
		};
		const withSetting = plan({
			numbers: { "1002": "ext:1002" },
			extensions: {
				"1001": {
					...entry,
					outboundCallerIdPresentation: "restricted",
				} as Partial<ExtensionIndexEntry>,
			},
		});
		expect(withSetting.ok === true && withSetting.callerIdPresentation).toBe("restricted");

		const without = plan({ numbers: { "1002": "ext:1002" }, extensions: { "1001": entry } });
		expect(without.ok === true && without.callerIdPresentation).toBeUndefined();
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

/**
 * Virtual hold's half of the same file: the queue calls a customer back.
 *
 * The two things worth pinning are the ones that make it a separate function — the resolve runs the
 * internal-then-outbound ladder and reports which rung matched, and the caller id presented is the
 * queue's rather than anybody else's — plus the toll-class refusal, which fails closed on purpose.
 */
describe("planning a queue callback", () => {
	function callback(
		options: { readonly to?: string; readonly queueNumber?: string } & ArtifactOptions &
			Pick<QueueCallbackPlanInput, "callerIdNumber" | "callerIdName"> = {},
	) {
		const { to, queueNumber, callerIdNumber, callerIdName, ...artifactOptions } = options;
		return planQueueCallback(artifact(artifactOptions), {
			to: to ?? "+15551234567",
			now: NOW,
			...(queueNumber === undefined ? {} : { queueNumber }),
			...(callerIdNumber === undefined ? {} : { callerIdNumber }),
			...(callerIdName === undefined ? {} : { callerIdName }),
		});
	}

	const QUEUE_EXTENSION = {
		"4010": {
			extensionId: "0195c0f0-1c2f-7000-8000-0000000000f1",
			nodeId: "ext:1001" as const,
		},
	};

	it("dials the customer through the org's outbound routing", () => {
		const result = callback({ outbound: true, queueNumber: "4010", extensions: QUEUE_EXTENSION });
		expect(result.ok).toBe(true);
		expect(result.ok === true && result.destination).toBe("+15551234567");
		// The rule must RESOLVE, not merely match: a fixture whose id/destinationNodeId are
		// misspelled still matches and yields `plan: undefined`, leaving this case green while
		// the callback path is handed a route with no trunk on it.
		expect(result.ok === true && result.planNodeId).toBe("trunk:pstn");
	});

	it("presents the caller id pinned on the queue, ahead of the route's own", () => {
		const result = callback({
			outbound: true,
			queueNumber: "4010",
			extensions: QUEUE_EXTENSION,
			callerIdNumber: "+15559990000",
			callerIdName: "Acme Support",
		});
		expect(result.ok === true && result.callerIdNumber).toBe("+15559990000");
		expect(result.ok === true && result.callerIdName).toBe("Acme Support");
	});

	/**
	 * The finding this rung exists for. The party who waited in a queue is as often an EXTENSION as a
	 * customer on a trunk — an internal transfer into support, a branch office, a warm hand-off — and
	 * an outbound-only resolve refused every one of them `invalid_target`, thirty seconds at a time,
	 * after the caller had been told their place was held.
	 */
	it("dials an internal caller back, and says which rung matched", () => {
		// The tenant has NO outbound route, and `1002` is one of its extensions.
		const result = callback({
			to: "1002",
			numbers: { "1002": "ext:1002" },
			queueNumber: "4010",
			extensions: { ...QUEUE_EXTENSION, "1002": { nodeId: "ext:1002" as const } },
		});
		expect(result.ok).toBe(true);
		expect(result.ok === true && result.context).toBe("internal");
		expect(result.ok === true && result.destination).toBe("1002");
	});

	/**
	 * The collision the outbound-only rule used to be afraid of is not one: an internal table holds
	 * extension numbers, and a customer's number is an E.164 no extension table contains. So an
	 * external number still takes the outbound rung it always did.
	 */
	it("still dials an external number outbound, and says so", () => {
		const result = callback({ outbound: true, queueNumber: "4010", extensions: QUEUE_EXTENSION });
		expect(result.ok).toBe(true);
		expect(result.ok === true && result.context).toBe("outbound");
	});

	/**
	 * Fails CLOSED. A queue with no number of its own has no toll entitlement to read, and inventing
	 * one would turn a misconfigured callback into an unmetered dialler.
	 */
	it("refuses when the queue has no number to take a toll class from", () => {
		const result = callback({ outbound: true });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("invalid_target");
	});

	it("refuses a blank number rather than resolving one", () => {
		const result = callback({ outbound: true, to: "   " });
		expect(result.ok === false && result.reason).toBe("bad_request");
	});
});
