import { describe, expect, it } from "bun:test";
import { RETRYABLE_HANGUP_CAUSES } from "@optimiq-voice/telephony";
import { ROUTING_ARTIFACT_VERSION } from "./artifact";
import { snapshotHash } from "./cache";
import { canonicalJson } from "./canonical-json";
import { callBlockHangupCause, compileRoutingArtifact, tryCompileRoutingArtifact } from "./compile";
import { RoutingCompileError, RoutingSnapshotError } from "./errors";
import {
	aCallBlockRule,
	aConference,
	aFeatureCode,
	anExtension,
	anInboundRoute,
	anIvrMenu,
	anIvrOption,
	anOutboundRoute,
	aParkLot,
	aPhoneNumber,
	aQueue,
	aRingGroup,
	aRingGroupMember,
	aSnapshot,
	aTimeCondition,
	aTimeRule,
	aTrunk,
	aVoicemailBox,
	codesOf,
	compileAttempt,
	compiled,
	COMPILED_AT,
	ORG_ID,
} from "./fixtures";
import { planNodeReferences } from "./plan";
import { emptySnapshot } from "./snapshot";
import type {
	ExtensionPlanNode,
	IvrMenuPlanNode,
	RingGroupPlanNode,
	TrunkDialPlanNode,
} from "./plan";

describe("compile — envelope", () => {
	it("compiles an empty organization", () => {
		const artifact = compiled(emptySnapshot(ORG_ID));
		expect(artifact.organizationId).toBe(ORG_ID);
		expect(artifact.inbound.rules).toEqual([]);
	});

	it("stamps the schema version", () => {
		expect(compiled(emptySnapshot(ORG_ID)).artifactVersion).toBe(ROUTING_ARTIFACT_VERSION);
	});

	it("records the caller's instant rather than reading a clock", () => {
		expect(compiled(emptySnapshot(ORG_ID)).compiledAt).toBe(COMPILED_AT);
	});

	it("normalises the instant to ISO 8601", () => {
		const artifact = compileRoutingArtifact(emptySnapshot(ORG_ID), {
			compiledAt: "2026-08-05T12:00:00+00:00",
		});
		expect(artifact.compiledAt).toBe("2026-08-05T12:00:00.000Z");
	});

	it("carries the snapshot's content hash", () => {
		const snapshot = emptySnapshot(ORG_ID);
		expect(compiled(snapshot).snapshotHash).toBe(snapshotHash(snapshot));
	});

	it("rejects a snapshot with no organization id", () => {
		expect(() => compiled({ ...emptySnapshot(ORG_ID), organizationId: "" })).toThrow(
			RoutingSnapshotError,
		);
	});

	it("rejects a snapshot missing a collection", () => {
		const broken = { ...emptySnapshot(ORG_ID), extensions: undefined } as never;
		expect(() => compiled(broken)).toThrow(RoutingSnapshotError);
	});

	it("rejects a compiledAt that is not an instant", () => {
		expect(() =>
			compileRoutingArtifact(emptySnapshot(ORG_ID), { compiledAt: "yesterday" }),
		).toThrow(RoutingSnapshotError);
	});

	it("always carries the terminals a resolver may need without configuration", () => {
		const nodes = compiled(emptySnapshot(ORG_ID)).nodes;
		for (const cause of [
			"NORMAL_CLEARING",
			"UNALLOCATED_NUMBER",
			"CALL_REJECTED",
			"USER_BUSY",
			"OUTGOING_CALL_BARRED",
		]) {
			expect(nodes[`hangup:${cause}`]).toBeDefined();
		}
	});
});

describe("compile — determinism", () => {
	const snapshot = aSnapshot({
		extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
		phoneNumbers: [aPhoneNumber()],
		inboundRoutes: [anInboundRoute()],
		trunks: [aTrunk()],
		outboundRoutes: [anOutboundRoute()],
		featureCodes: [aFeatureCode()],
	});

	it("produces a byte-identical artifact when compiled twice", () => {
		expect(canonicalJson(compiled(snapshot))).toBe(canonicalJson(compiled(snapshot)));
	});

	it("produces a deep-equal artifact when compiled twice", () => {
		expect(compiled(snapshot)).toEqual(compiled(snapshot));
	});

	it("is unaffected by the order rows arrive in", () => {
		const reversed = aSnapshot({
			...snapshot,
			extensions: [...snapshot.extensions].reverse(),
		});
		expect(canonicalJson(compiled(reversed))).toBe(canonicalJson(compiled(snapshot)));
	});

	it("keys nodes deterministically off the entity, not a counter", () => {
		expect(Object.keys(compiled(snapshot).nodes)).toContain("extension:ext-1");
	});

	it("sorts the node table", () => {
		const keys = Object.keys(compiled(snapshot).nodes);
		expect(keys).toEqual([...keys].sort());
	});

	it("survives a JSON round trip unchanged", () => {
		const artifact = compiled(snapshot);
		expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
	});

	it("changes hash when the configuration changes", () => {
		const changed = aSnapshot({
			...snapshot,
			extensions: [
				anExtension({ callTimeoutSeconds: 45 }),
				anExtension({ id: "ext-2", number: "1002" }),
			],
		});
		expect(compiled(changed).snapshotHash).not.toBe(compiled(snapshot).snapshotHash);
	});
});

describe("compile — the node graph is closed", () => {
	const snapshot = aSnapshot({
		extensions: [anExtension({ voicemailEnabled: true })],
		voicemailBoxes: [aVoicemailBox()],
		ringGroups: [
			aRingGroup({ timeoutDestinationType: "voicemail", timeoutDestinationRef: "vm-1" }),
		],
		ringGroupDestinations: [aRingGroupMember()],
		ivrMenus: [anIvrMenu({ timeoutDestinationType: "ring-group", timeoutDestinationRef: "rg-1" })],
		ivrMenuOptions: [anIvrOption({ destinationType: "ring-group", destinationRef: "rg-1" })],
		queues: [aQueue({ timeoutDestinationType: "ivr", timeoutDestinationRef: "ivr-1" })],
		phoneNumbers: [aPhoneNumber({ destinationType: "queue", destinationRef: "q-1" })],
	});

	it("resolves every reference in every node", () => {
		const artifact = compiled(snapshot);
		for (const node of Object.values(artifact.nodes)) {
			for (const reference of planNodeReferences(node)) {
				expect(artifact.nodes[reference]).toBeDefined();
			}
		}
	});

	it("resolves every match-table entry point", () => {
		const artifact = compiled(snapshot);
		const entries = [
			artifact.inbound.noMatchNodeId,
			artifact.internal.noMatchNodeId,
			artifact.outbound.noMatchNodeId,
			artifact.outbound.deniedNodeId,
			...artifact.inbound.rules.map((rule) => rule.destinationNodeId),
			...Object.values(artifact.inbound.didDefaults).map((did) => did.destinationNodeId),
			...Object.values(artifact.internal.numbers).map((entry) => entry.nodeId),
			...Object.values(artifact.extensionsByNumber).map((entry) => entry.nodeId),
			...artifact.internal.featureCodes.map((entry) => entry.nodeId),
			...artifact.internal.parkSlots.map((entry) => entry.nodeId),
		];
		for (const entry of entries) {
			expect(artifact.nodes[entry]).toBeDefined();
		}
	});

	it("deduplicates references to the same entity into one node", () => {
		const artifact = compiled(snapshot);
		const ringGroupNodes = Object.keys(artifact.nodes).filter((id) => id.startsWith("ring-group:"));
		expect(ringGroupNodes).toEqual(["ring-group:rg-1"]);
	});

	it("survives a cycle between two extensions forwarding to each other", () => {
		const cyclic = aSnapshot({
			extensions: [
				anExtension({ forwardBusyEnabled: true, forwardBusyDestination: "1002" }),
				anExtension({
					id: "ext-2",
					number: "1002",
					forwardBusyEnabled: true,
					forwardBusyDestination: "1001",
				}),
			],
		});
		const artifact = compiled(cyclic);
		expect((artifact.nodes["extension:ext-1"] as ExtensionPlanNode).busyNodeId).toBe(
			"extension:ext-2",
		);
		expect((artifact.nodes["extension:ext-2"] as ExtensionPlanNode).busyNodeId).toBe(
			"extension:ext-1",
		);
	});
});

describe("compile — extensions", () => {
	it("falls back to voicemail on busy when a mailbox exists", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension({ voicemailEnabled: true })],
				voicemailBoxes: [aVoicemailBox()],
			}),
		);
		expect((artifact.nodes["extension:ext-1"] as ExtensionPlanNode).busyNodeId).toBe(
			"voicemail:vm-1:leave",
		);
	});

	it("falls back to a busy hangup when voicemail is off", () => {
		const artifact = compiled(aSnapshot({ extensions: [anExtension()] }));
		expect((artifact.nodes["extension:ext-1"] as ExtensionPlanNode).busyNodeId).toBe(
			"hangup:USER_BUSY",
		);
	});

	it("uses distinct causes for busy, no-answer and unregistered", () => {
		const node = compiled(aSnapshot({ extensions: [anExtension()] })).nodes[
			"extension:ext-1"
		] as ExtensionPlanNode;
		expect([node.busyNodeId, node.noAnswerNodeId, node.notRegisteredNodeId]).toEqual([
			"hangup:USER_BUSY",
			"hangup:NO_ANSWER",
			"hangup:USER_NOT_REGISTERED",
		]);
	});

	it("prefers an explicit forward over voicemail", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [
					anExtension({
						voicemailEnabled: true,
						forwardBusyEnabled: true,
						forwardBusyDestination: "1002",
					}),
					anExtension({ id: "ext-2", number: "1002" }),
				],
				voicemailBoxes: [aVoicemailBox()],
			}),
		);
		expect((artifact.nodes["extension:ext-1"] as ExtensionPlanNode).busyNodeId).toBe(
			"extension:ext-2",
		);
	});

	it("keeps an internal forward inside the PBX", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [
					anExtension({ forwardAllEnabled: true, forwardAllDestination: "1002" }),
					anExtension({ id: "ext-2", number: "1002" }),
				],
			}),
		);
		expect((artifact.nodes["extension:ext-1"] as ExtensionPlanNode).forwardAllNodeId).toBe(
			"extension:ext-2",
		);
	});

	it("sends an unrecognised forward target out through outbound routing", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [
					anExtension({ forwardAllEnabled: true, forwardAllDestination: "+15559998888" }),
				],
			}),
		);
		const node = artifact.nodes["external:+15559998888"];
		expect(node).toMatchObject({ kind: "external", viaOutboundRouting: true });
	});

	it("warns when forwarding is on with no destination", () => {
		const result = compileAttempt(
			aSnapshot({ extensions: [anExtension({ forwardAllEnabled: true })] }),
		);
		expect(codesOf(result)).toContain("unresolvable-forward");
	});

	it("warns when voicemail is on but no mailbox exists", () => {
		const result = compileAttempt(
			aSnapshot({ extensions: [anExtension({ voicemailEnabled: true })] }),
		);
		expect(codesOf(result)).toContain("missing-voicemail-box");
	});

	it("keeps do-not-disturb as a flag the engine can short-circuit on", () => {
		const artifact = compiled(aSnapshot({ extensions: [anExtension({ doNotDisturb: true })] }));
		expect((artifact.nodes["extension:ext-1"] as ExtensionPlanNode).doNotDisturb).toBe(true);
	});

	it("omits a disabled extension from the internal table", () => {
		const artifact = compiled(aSnapshot({ extensions: [anExtension({ enabled: false })] }));
		expect(artifact.internal.numbers["1001"]).toBeUndefined();
	});

	it("indexes enabled extensions by number for caller lookup", () => {
		const artifact = compiled(aSnapshot({ extensions: [anExtension()] }));
		expect(artifact.extensionsByNumber["1001"]).toMatchObject({
			extensionId: "ext-1",
			tollClass: "national",
		});
	});
});

describe("compile — internal numbering", () => {
	it("claims numbers for extensions, ring groups, IVRs, queues and conference rooms", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				ringGroups: [aRingGroup({ extensionNumber: "2000" })],
				ringGroupDestinations: [aRingGroupMember()],
				ivrMenus: [anIvrMenu({ extensionNumber: "5000" })],
				queues: [aQueue({ extensionNumber: "4000" })],
				conferences: [aConference()],
			}),
		);
		expect(Object.keys(artifact.internal.numbers).sort()).toEqual([
			"1001",
			"2000",
			"3001",
			"4000",
			"5000",
		]);
	});

	it("errors when two entities claim the same internal number", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension({ number: "2000" })],
				ringGroups: [aRingGroup({ extensionNumber: "2000" })],
				ringGroupDestinations: [aRingGroupMember()],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("duplicate-internal-number");
	});

	it("does not put mailboxes in the number table, since they share extension numbers", () => {
		const artifact = compiled(
			aSnapshot({ extensions: [anExtension()], voicemailBoxes: [aVoicemailBox()] }),
		);
		expect(artifact.internal.numbers["1001"]?.kind).toBe("extension");
		expect(artifact.internal.mailboxes["1001"]).toMatchObject({ voicemailBoxId: "vm-1" });
	});

	it("errors when two mailboxes claim the same number", () => {
		const result = compileAttempt(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox(), aVoicemailBox({ id: "vm-2", extensionId: null })],
			}),
		);
		expect(codesOf(result)).toContain("duplicate-internal-number");
	});

	it("compiles a park lot into a slot range", () => {
		const artifact = compiled(aSnapshot({ parkLots: [aParkLot()] }));
		expect(artifact.internal.parkSlots).toEqual([
			{ parkLotId: "park-1", slotStart: 701, slotEnd: 720, nodeId: "park:park-1" },
		]);
	});

	it("errors when two park lots overlap", () => {
		const result = compileAttempt(
			aSnapshot({
				parkLots: [
					aParkLot(),
					aParkLot({ id: "park-2", name: "Second", slotStart: 715, slotEnd: 730 }),
				],
			}),
		);
		expect(codesOf(result)).toContain("duplicate-internal-number");
	});

	it("warns when a park range swallows a dialable internal number", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension({ number: "705" })],
				parkLots: [aParkLot()],
			}),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("duplicate-internal-number");
	});
});

describe("compile — feature codes", () => {
	it("compiles a code into a node and a table entry", () => {
		const artifact = compiled(aSnapshot({ featureCodes: [aFeatureCode()] }));
		expect(artifact.internal.featureCodes[0]).toMatchObject({
			code: "*97",
			action: "voicemail-check",
			argumentMode: "none",
			nodeId: "feature-code:fc-1",
		});
	});

	it("sorts the table longest code first", () => {
		const artifact = compiled(
			aSnapshot({
				featureCodes: [
					aFeatureCode({ id: "fc-a", code: "*8", action: "group-pickup" }),
					aFeatureCode({ id: "fc-b", code: "*801", action: "intercom" }),
				],
			}),
		);
		expect(artifact.internal.featureCodes.map((entry) => entry.code)).toEqual(["*801", "*8"]);
	});

	it("errors on a duplicate code", () => {
		const result = compileAttempt(
			aSnapshot({
				featureCodes: [aFeatureCode(), aFeatureCode({ id: "fc-2", action: "redial" })],
			}),
		);
		expect(codesOf(result)).toContain("conflicting-feature-code");
	});

	it("errors on a code that is not dialable", () => {
		const result = compileAttempt(aSnapshot({ featureCodes: [aFeatureCode({ code: "97" })] }));
		expect(result.ok).toBe(false);
	});

	it("skips a disabled code", () => {
		const artifact = compiled(aSnapshot({ featureCodes: [aFeatureCode({ enabled: false })] }));
		expect(artifact.internal.featureCodes).toEqual([]);
	});

	it("resolves a park lot named in a code's params", () => {
		const artifact = compiled(
			aSnapshot({
				parkLots: [aParkLot()],
				featureCodes: [
					aFeatureCode({ code: "*5", action: "call-park", params: { lotId: "park-1" } }),
				],
			}),
		);
		expect(artifact.nodes["feature-code:fc-1"]).toMatchObject({ targetNodeId: "park:park-1" });
	});

	it("errors when a code names a park lot that does not exist", () => {
		const result = compileAttempt(
			aSnapshot({
				featureCodes: [
					aFeatureCode({ code: "*5", action: "call-park", params: { lotId: "nope" } }),
				],
			}),
		);
		expect(codesOf(result)).toContain("dangling-destination");
	});

	it("compiles voicemail prefixes from settings", () => {
		const artifact = compiled(
			aSnapshot({
				settings: { voicemailPrefix: "*99", voicemailCheckPrefix: "*98" },
				voicemailBoxes: [aVoicemailBox()],
			}),
		);
		expect(artifact.internal.voicemailPrefixes).toEqual([
			{ prefix: "*99", mode: "leave" },
			{ prefix: "*98", mode: "check" },
		]);
	});

	it("warns when a voicemail prefix is swallowed by a feature code", () => {
		const result = compileAttempt(
			aSnapshot({
				settings: { voicemailPrefix: "*97" },
				featureCodes: [aFeatureCode()],
			}),
		);
		expect(codesOf(result)).toContain("conflicting-feature-code");
	});
});

describe("compile — inbound", () => {
	it("compiles a DID's own destination as the default route", () => {
		const artifact = compiled(
			aSnapshot({ extensions: [anExtension()], phoneNumbers: [aPhoneNumber()] }),
		);
		expect(artifact.inbound.didDefaults["+15551230001"]).toMatchObject({
			destinationNodeId: "extension:ext-1",
		});
	});

	it("skips a DID with voice disabled", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [aPhoneNumber({ voiceEnabled: false })],
			}),
		);
		expect(artifact.inbound.didDefaults).toEqual({});
	});

	it("orders rules by priority first", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [
					anInboundRoute({ id: "in-a", name: "Low", priority: 200, matchKind: "any" }),
					anInboundRoute({ id: "in-b", name: "High", priority: 10, matchKind: "any" }),
				],
			}),
		);
		expect(artifact.inbound.rules.map((rule) => rule.name)).toEqual(["High", "Low"]);
	});

	it("orders equal priorities by specificity, most specific first", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [
					anInboundRoute({ id: "in-any", name: "Any", matchKind: "any" }),
					anInboundRoute({
						id: "in-short",
						name: "Short",
						matchKind: "prefix",
						matchPattern: "+1",
					}),
					anInboundRoute({
						id: "in-long",
						name: "Long",
						matchKind: "prefix",
						matchPattern: "+1555",
					}),
					anInboundRoute({
						id: "in-exact",
						name: "Exact",
						matchKind: "exact",
						matchPattern: "+15551230001",
					}),
				],
			}),
		);
		expect(artifact.inbound.rules.map((rule) => rule.name)).toEqual([
			"Exact",
			"Long",
			"Short",
			"Any",
		]);
	});

	it("puts a DID-bound rule above every pattern at the same priority", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [aPhoneNumber()],
				inboundRoutes: [
					anInboundRoute({
						id: "in-exact",
						name: "Exact",
						matchKind: "exact",
						matchPattern: "+15551230001",
					}),
					anInboundRoute({
						id: "in-bound",
						name: "Bound",
						matchKind: "any",
						phoneNumberId: "did-1",
					}),
				],
			}),
		);
		expect(artifact.inbound.rules[0]?.name).toBe("Bound");
	});

	it("breaks a full tie by id so the order never drifts", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [
					anInboundRoute({ id: "in-b", name: "B", matchKind: "any" }),
					anInboundRoute({ id: "in-a", name: "A", matchKind: "any" }),
				],
			}),
		);
		expect(artifact.inbound.rules.map((rule) => rule.id)).toEqual(["in-a", "in-b"]);
	});

	it("errors when a rule is bound to a DID that no longer exists", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [anInboundRoute({ phoneNumberId: "did-gone" })],
			}),
		);
		expect(codesOf(result)).toContain("dangling-destination");
	});

	it("errors when a rule points at a missing destination", () => {
		const result = compileAttempt(
			aSnapshot({ inboundRoutes: [anInboundRoute({ destinationRef: "ext-gone" })] }),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("dangling-destination");
	});

	it("warns when a rule can never run behind an unconditional catch-all", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [
					anInboundRoute({ id: "in-any", name: "Catch all", priority: 1, matchKind: "any" }),
					anInboundRoute({ id: "in-specific", name: "Specific", priority: 2 }),
				],
			}),
		);
		expect(codesOf(result)).toContain("unreachable-route");
	});

	it("warns when two rules match exactly the same calls", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [
					anInboundRoute({ id: "in-a", name: "A", priority: 1 }),
					anInboundRoute({ id: "in-b", name: "B", priority: 2 }),
				],
			}),
		);
		expect(codesOf(result)).toContain("overlapping-did-pattern");
	});

	it("stays quiet when the earlier rule has a caller screen and might decline", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [
					anInboundRoute({
						id: "in-a",
						name: "VIP",
						priority: 1,
						matchKind: "any",
						callerIdPattern: "+1555",
					}),
					anInboundRoute({ id: "in-b", name: "Everyone", priority: 2, matchKind: "any" }),
				],
			}),
		);
		expect(codesOf(result)).not.toContain("unreachable-route");
	});

	it("skips disabled routes without complaining", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [anInboundRoute({ enabled: false })],
			}),
		);
		expect(result.ok).toBe(true);
		expect(result.diagnostics).toEqual([]);
	});

	it("warns and releases when a route points at a disabled entity", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension({ enabled: false })],
				inboundRoutes: [anInboundRoute()],
			}),
		);
		expect(codesOf(result)).toContain("disabled-entity");
		expect(result.ok).toBe(true);
	});
});

describe("compile — outbound", () => {
	const base = aSnapshot({
		extensions: [anExtension()],
		trunks: [aTrunk(), aTrunk({ id: "trunk-2", name: "Backup" })],
		outboundRoutes: [
			anOutboundRoute({
				trunkPriority: [
					{ trunkId: "trunk-2", order: 2 },
					{ trunkId: "trunk-1", order: 1 },
				],
			}),
		],
	});

	it("builds an ordered failover chain", () => {
		const node = compiled(base).nodes["trunk-dial:out-1"] as TrunkDialPlanNode;
		expect(node.attempts.map((attempt) => attempt.trunkId)).toEqual(["trunk-1", "trunk-2"]);
	});

	it("defaults continueOnCauses to the retryable set, never to every cause", () => {
		const node = compiled(base).nodes["trunk-dial:out-1"] as TrunkDialPlanNode;
		expect([...node.continueOnCauses].sort()).toEqual([...RETRYABLE_HANGUP_CAUSES].sort());
		expect(node.continueOnCauses).not.toContain("CALL_REJECTED");
	});

	it("accepts an explicit continueOnCauses list", () => {
		const artifact = compiled(
			aSnapshot({ ...base, settings: { trunkContinueOnCauses: ["GATEWAY_DOWN"] } }),
		);
		expect((artifact.nodes["trunk-dial:out-1"] as TrunkDialPlanNode).continueOnCauses).toEqual([
			"GATEWAY_DOWN",
		]);
	});

	it("drops an unknown cause from continueOnCauses with a warning", () => {
		const result = compileAttempt(
			aSnapshot({ ...base, settings: { trunkContinueOnCauses: ["NOT_A_CAUSE"] } }),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("invalid-pattern");
	});

	it("carries the trunk's dial facts onto the attempt", () => {
		const node = compiled(base).nodes["trunk-dial:out-1"] as TrunkDialPlanNode;
		expect(node.attempts[0]).toMatchObject({
			sipProxy: "sip.carrier.example",
			transport: "udp",
			kind: "ip-auth",
		});
	});

	it("warns and drops a trunk that no longer exists", () => {
		const result = compileAttempt(
			aSnapshot({
				...base,
				outboundRoutes: [anOutboundRoute({ trunkPriority: [{ trunkId: "gone", order: 1 }] })],
			}),
		);
		expect(codesOf(result)).toContain("unknown-trunk");
		expect(codesOf(result)).toContain("empty-trunk-list");
		expect(result.ok).toBe(true);
	});

	it("warns and drops a disabled trunk", () => {
		const result = compileAttempt(
			aSnapshot({
				...base,
				trunks: [aTrunk({ enabled: false })],
				outboundRoutes: [anOutboundRoute()],
			}),
		);
		expect(codesOf(result)).toContain("disabled-trunk");
	});

	it("errors on invalid digit manipulation rather than dialing garbage", () => {
		const result = compileAttempt(
			aSnapshot({ ...base, outboundRoutes: [anOutboundRoute({ stripDigits: -1 })] }),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("invalid-digit-manipulation");
	});

	it("errors on a prepend that is not dialable", () => {
		const result = compileAttempt(
			aSnapshot({ ...base, outboundRoutes: [anOutboundRoute({ prependDigits: "sip:evil@" })] }),
		);
		expect(result.ok).toBe(false);
	});

	it("errors on an uncompilable dial pattern", () => {
		const result = compileAttempt(
			aSnapshot({
				...base,
				outboundRoutes: [anOutboundRoute({ matchKind: "regex", dialPatterns: ["^(("] })],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("invalid-regex");
	});

	it("warns about an unanchored dial regex, the classic toll-fraud hole", () => {
		const result = compileAttempt(
			aSnapshot({
				...base,
				outboundRoutes: [anOutboundRoute({ matchKind: "regex", dialPatterns: ["555"] })],
			}),
		);
		expect(codesOf(result)).toContain("unanchored-regex");
		expect(result.ok).toBe(true);
	});

	it("errors on a route with no dial patterns", () => {
		const result = compileAttempt(
			aSnapshot({ ...base, outboundRoutes: [anOutboundRoute({ dialPatterns: [] })] }),
		);
		expect(result.ok).toBe(false);
	});

	it("accepts a catch-all route with no patterns", () => {
		const artifact = compiled(
			aSnapshot({
				...base,
				outboundRoutes: [anOutboundRoute({ matchKind: "any", dialPatterns: [] })],
			}),
		);
		expect(artifact.outbound.rules[0]?.patterns).toEqual([{ kind: "any" }]);
	});

	it("records the organization's outbound kill switch", () => {
		const artifact = compiled(aSnapshot({ ...base, settings: { outboundEnabled: false } }));
		expect(artifact.outbound.enabled).toBe(false);
	});

	it("orders routes by priority then specificity", () => {
		const artifact = compiled(
			aSnapshot({
				...base,
				outboundRoutes: [
					anOutboundRoute({ id: "out-any", name: "Any", matchKind: "any", dialPatterns: [] }),
					anOutboundRoute({ id: "out-long", name: "Long", dialPatterns: ["+1555"] }),
					anOutboundRoute({ id: "out-short", name: "Short", dialPatterns: ["+1"] }),
				],
			}),
		);
		expect(artifact.outbound.rules.map((rule) => rule.name)).toEqual(["Long", "Short", "Any"]);
	});
});

describe("compile — ring groups", () => {
	it("compiles members in ordinal order", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
				ringGroups: [aRingGroup({ strategy: "sequential" })],
				ringGroupDestinations: [
					aRingGroupMember({ id: "rgd-2", ordinal: 2, destinationRef: "ext-2", delaySeconds: 10 }),
					aRingGroupMember({ id: "rgd-1", ordinal: 1 }),
				],
			}),
		);
		const node = artifact.nodes["ring-group:rg-1"] as RingGroupPlanNode;
		expect(node.members.map((member) => member.targetNodeId)).toEqual([
			"extension:ext-1",
			"extension:ext-2",
		]);
	});

	it("zeroes per-member delays for a simultaneous group", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				ringGroups: [aRingGroup({ strategy: "simultaneous" })],
				ringGroupDestinations: [aRingGroupMember({ delaySeconds: 15 })],
			}),
		);
		expect((artifact.nodes["ring-group:rg-1"] as RingGroupPlanNode).members[0]?.delaySeconds).toBe(
			0,
		);
	});

	it("keeps per-member delays for a sequential group", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				ringGroups: [aRingGroup({ strategy: "sequential" })],
				ringGroupDestinations: [aRingGroupMember({ delaySeconds: 15 })],
			}),
		);
		expect((artifact.nodes["ring-group:rg-1"] as RingGroupPlanNode).members[0]?.delaySeconds).toBe(
			15,
		);
	});

	it("lets a group-level confirm requirement win over a member's", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				ringGroups: [aRingGroup({ confirmEnabled: true })],
				ringGroupDestinations: [aRingGroupMember({ confirmRequired: false })],
			}),
		);
		expect(
			(artifact.nodes["ring-group:rg-1"] as RingGroupPlanNode).members[0]?.confirmRequired,
		).toBe(true);
	});

	it("warns about an empty ring group but still compiles it", () => {
		const result = compileAttempt(aSnapshot({ ringGroups: [aRingGroup()] }));
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("empty-ring-group");
	});

	it("drops disabled members", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				ringGroups: [aRingGroup()],
				ringGroupDestinations: [aRingGroupMember({ enabled: false })],
			}),
		);
		expect((artifact.nodes["ring-group:rg-1"] as RingGroupPlanNode).members).toEqual([]);
	});
});

describe("compile — IVR menus", () => {
	it("compiles digit options into exact patterns", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				ivrMenus: [anIvrMenu()],
				ivrMenuOptions: [anIvrOption()],
			}),
		);
		const node = artifact.nodes["ivr-menu:ivr-1"] as IvrMenuPlanNode;
		expect(node.options[0]?.pattern).toEqual({ kind: "exact", value: "1" });
	});

	it("compiles regex options as regexes", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				ivrMenus: [anIvrMenu()],
				ivrMenuOptions: [anIvrOption({ matchKind: "regex", matchValue: "^[1-3]$" })],
			}),
		);
		const node = artifact.nodes["ivr-menu:ivr-1"] as IvrMenuPlanNode;
		expect(node.options[0]?.pattern).toEqual({ kind: "regex", source: "^[1-3]$" });
	});

	it("errors when an option points back at its own menu", () => {
		const result = compileAttempt(
			aSnapshot({
				ivrMenus: [anIvrMenu()],
				ivrMenuOptions: [anIvrOption({ destinationType: "ivr", destinationRef: "ivr-1" })],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("self-referencing-ivr");
	});

	it("errors when a menu's timeout branch is the menu itself", () => {
		const result = compileAttempt(
			aSnapshot({
				ivrMenus: [anIvrMenu({ timeoutDestinationType: "ivr", timeoutDestinationRef: "ivr-1" })],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("self-referencing-ivr");
	});

	it("warns, but compiles, when two menus point at each other", () => {
		const result = compileAttempt(
			aSnapshot({
				ivrMenus: [anIvrMenu(), anIvrMenu({ id: "ivr-2", name: "Sub menu" })],
				ivrMenuOptions: [
					anIvrOption({ destinationType: "ivr", destinationRef: "ivr-2" }),
					anIvrOption({
						id: "ivro-2",
						ivrMenuId: "ivr-2",
						matchValue: "9",
						destinationType: "ivr",
						destinationRef: "ivr-1",
					}),
				],
			}),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("ivr-cycle");
	});

	it("reports a cycle once, not once per member", () => {
		const result = compileAttempt(
			aSnapshot({
				ivrMenus: [anIvrMenu(), anIvrMenu({ id: "ivr-2", name: "Sub menu" })],
				ivrMenuOptions: [
					anIvrOption({ destinationType: "ivr", destinationRef: "ivr-2" }),
					anIvrOption({
						id: "ivro-2",
						ivrMenuId: "ivr-2",
						matchValue: "9",
						destinationType: "ivr",
						destinationRef: "ivr-1",
					}),
				],
			}),
		);
		expect(codesOf(result).filter((code) => code === "ivr-cycle")).toHaveLength(1);
	});

	it("stays quiet about a tree with no cycle", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				ivrMenus: [anIvrMenu(), anIvrMenu({ id: "ivr-2", name: "Sub menu" })],
				ivrMenuOptions: [
					anIvrOption({ destinationType: "ivr", destinationRef: "ivr-2" }),
					anIvrOption({ id: "ivro-2", ivrMenuId: "ivr-2", matchValue: "1" }),
				],
			}),
		);
		expect(codesOf(result)).not.toContain("ivr-cycle");
	});

	it("errors on an option whose regex does not compile", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				ivrMenus: [anIvrMenu()],
				ivrMenuOptions: [anIvrOption({ matchKind: "regex", matchValue: "^((" })],
			}),
		);
		expect(result.ok).toBe(false);
	});
});

describe("compile — time conditions", () => {
	it("compiles rules in ordinal order", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				timeConditions: [aTimeCondition()],
				timeConditionRules: [
					aTimeRule({ id: "tcr-2", ordinal: 2, predicates: [{ months: [12] }] }),
					aTimeRule({ id: "tcr-1", ordinal: 1 }),
				],
			}),
		);
		expect(artifact.timeConditions["tc-1"]?.rules.map((rule) => rule.id)).toEqual([
			"tcr-1",
			"tcr-2",
		]);
	});

	it("errors on an unknown timezone", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				timeConditions: [aTimeCondition({ timezone: "Mars/Base" })],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("unknown-timezone");
	});

	it("errors on an out-of-range predicate", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				timeConditions: [aTimeCondition()],
				timeConditionRules: [aTimeRule({ predicates: [{ weekdays: [9] }] })],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("invalid-time-rule");
	});

	it("warns about a condition with no enabled rules", () => {
		const result = compileAttempt(
			aSnapshot({ extensions: [anExtension()], timeConditions: [aTimeCondition()] }),
		);
		expect(codesOf(result)).toContain("empty-time-condition");
	});

	it("attaches a gate to a route", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				timeConditions: [
					aTimeCondition({ nomatchDestinationType: "hangup", nomatchDestinationData: {} }),
				],
				timeConditionRules: [aTimeRule()],
				inboundRoutes: [anInboundRoute({ timeConditionId: "tc-1" })],
			}),
		);
		expect(artifact.inbound.rules[0]?.timeGate).toEqual({
			timeConditionId: "tc-1",
			closedNodeId: "hangup:NORMAL_CLEARING",
		});
	});

	it("falls back to the route's failover as the closed branch", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
				timeConditions: [aTimeCondition()],
				timeConditionRules: [aTimeRule()],
				inboundRoutes: [
					anInboundRoute({
						timeConditionId: "tc-1",
						failoverDestinationType: "extension",
						failoverDestinationRef: "ext-2",
					}),
				],
			}),
		);
		expect(artifact.inbound.rules[0]?.timeGate?.closedNodeId).toBe("extension:ext-2");
	});

	it("errors when a route names a time condition that does not exist", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [anInboundRoute({ timeConditionId: "tc-gone" })],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("missing-time-condition");
	});

	it("treats a disabled gate as always open, with a warning", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				timeConditions: [aTimeCondition({ enabled: false })],
				inboundRoutes: [anInboundRoute({ timeConditionId: "tc-1" })],
			}),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("disabled-entity");
	});

	it("compiles a time condition used as a destination into its own node", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
				timeConditions: [
					aTimeCondition({
						nomatchDestinationType: "extension",
						nomatchDestinationRef: "ext-2",
					}),
				],
				timeConditionRules: [aTimeRule()],
				phoneNumbers: [aPhoneNumber({ destinationType: "time-condition", destinationRef: "tc-1" })],
			}),
		);
		expect(artifact.nodes["time-condition:tc-1"]).toMatchObject({
			matchNodeId: "extension:ext-1",
			noMatchNodeId: "extension:ext-2",
		});
	});
});

describe("compile — call blocking", () => {
	it("sorts most specific first with allow ahead of block", () => {
		const artifact = compiled(
			aSnapshot({
				callBlockRules: [
					aCallBlockRule({
						id: "cb-block",
						pattern: "+1555",
						matchKind: "prefix",
						action: "block",
					}),
					aCallBlockRule({
						id: "cb-allow",
						pattern: "+15551230001",
						matchKind: "exact",
						action: "allow",
					}),
				],
			}),
		);
		expect(artifact.callBlock.map((rule) => rule.id)).toEqual(["cb-allow", "cb-block"]);
	});

	it("puts allow first at equal specificity", () => {
		const artifact = compiled(
			aSnapshot({
				callBlockRules: [
					aCallBlockRule({ id: "cb-b", pattern: "+1555", action: "block", matchKind: "prefix" }),
					aCallBlockRule({ id: "cb-a", pattern: "+1555", action: "allow", matchKind: "prefix" }),
				],
			}),
		);
		expect(artifact.callBlock[0]?.action).toBe("allow");
	});

	it("skips disabled rules", () => {
		const artifact = compiled(aSnapshot({ callBlockRules: [aCallBlockRule({ enabled: false })] }));
		expect(artifact.callBlock).toEqual([]);
	});

	it("maps block to an explicit decline and reject to busy", () => {
		expect(callBlockHangupCause("block")).toBe("CALL_REJECTED");
		expect(callBlockHangupCause("reject")).toBe("USER_BUSY");
	});

	it("gives allow and voicemail no terminal, because the call continues", () => {
		expect(callBlockHangupCause("allow")).toBeNull();
		expect(callBlockHangupCause("voicemail")).toBeNull();
	});
});

describe("compile — failure surface", () => {
	it("throws RoutingCompileError carrying the diagnostics", () => {
		const snapshot = aSnapshot({ inboundRoutes: [anInboundRoute({ destinationRef: "gone" })] });
		try {
			compiled(snapshot);
			throw new Error("expected a compile failure");
		} catch (error) {
			expect(error).toBeInstanceOf(RoutingCompileError);
			expect((error as RoutingCompileError).diagnostics.length).toBeGreaterThan(0);
			expect((error as RoutingCompileError).organizationId).toBe(ORG_ID);
		}
	});

	it("returns diagnostics instead of throwing from the try form", () => {
		const result = tryCompileRoutingArtifact(
			aSnapshot({ inboundRoutes: [anInboundRoute({ destinationRef: "gone" })] }),
			{ compiledAt: COMPILED_AT },
		);
		expect(result.ok).toBe(false);
	});

	it("collects every error rather than stopping at the first", () => {
		const result = compileAttempt(
			aSnapshot({
				inboundRoutes: [
					anInboundRoute({ id: "in-1", destinationRef: "gone-1" }),
					anInboundRoute({ id: "in-2", name: "Other", destinationRef: "gone-2" }),
				],
			}),
		);
		expect(result.diagnostics.filter((entry) => entry.severity === "error")).toHaveLength(2);
	});

	it("keeps warnings on a successful artifact", () => {
		const artifact = compiled(aSnapshot({ ringGroups: [aRingGroup()] }));
		expect(artifact.diagnostics.map((entry) => entry.code)).toContain("empty-ring-group");
	});

	it("never puts an error diagnostic on an artifact", () => {
		const artifact = compiled(aSnapshot({ ringGroups: [aRingGroup()] }));
		expect(artifact.diagnostics.every((entry) => entry.severity !== "error")).toBe(true);
	});
});
