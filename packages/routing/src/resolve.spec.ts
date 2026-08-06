import { describe, expect, it } from "bun:test";
import { PlanNodeNotFoundError } from "./errors";
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
	at,
	compiled,
} from "./fixtures";
import {
	checkCallBlock,
	MAX_GATE_DEPTH,
	planFrom,
	planNode,
	resolveInbound,
	resolveInternal,
	resolveOutbound,
} from "./resolve";
import type { RoutingArtifact } from "./artifact";

const NOW = at("2026-08-05T12:00:00Z");

function inboundArtifact(): RoutingArtifact {
	return compiled(
		aSnapshot({
			extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
			phoneNumbers: [
				aPhoneNumber(),
				aPhoneNumber({ id: "did-2", e164: "+15551230002", destinationRef: "ext-2" }),
			],
			inboundRoutes: [anInboundRoute()],
		}),
	);
}

describe("planFrom / planNode", () => {
	it("shares the artifact's node table rather than copying it", () => {
		const artifact = inboundArtifact();
		expect(planFrom(artifact, "extension:ext-1").nodes).toBe(artifact.nodes);
	});

	it("reads a node", () => {
		const artifact = inboundArtifact();
		expect(planNode(artifact, "extension:ext-1").kind).toBe("extension");
	});

	it("throws on an id the table does not contain", () => {
		expect(() => planNode(inboundArtifact(), "extension:nope")).toThrow(PlanNodeNotFoundError);
	});
});

describe("resolveInbound — matching", () => {
	it("matches a route by exact DID", () => {
		const route = resolveInbound(inboundArtifact(), { did: "+15551230001", now: NOW });
		expect(route).toMatchObject({ matched: true, matchedRuleId: "in-1" });
		expect(route.plan?.entryNodeId).toBe("extension:ext-1");
	});

	it("falls back to the DID's own destination when no route matches", () => {
		const route = resolveInbound(inboundArtifact(), { did: "+15551230002", now: NOW });
		expect(route).toMatchObject({ matched: true, matchedRuleId: "did-2" });
		expect(route.plan?.entryNodeId).toBe("extension:ext-2");
	});

	it("releases an unknown DID with UNALLOCATED_NUMBER", () => {
		const artifact = inboundArtifact();
		const route = resolveInbound(artifact, { did: "+15559999999", now: NOW });
		expect(route.matched).toBe(false);
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({
			kind: "hangup",
			cause: "UNALLOCATED_NUMBER",
		});
	});

	it("explains a non-match in its reason", () => {
		const route = resolveInbound(inboundArtifact(), { did: "+15559999999", now: NOW });
		expect(route.reason).toContain("+15559999999");
	});

	it("prefers the most specific rule at equal priority", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
				inboundRoutes: [
					anInboundRoute({
						id: "in-prefix",
						name: "Range",
						matchKind: "prefix",
						matchPattern: "+1555",
						destinationRef: "ext-2",
					}),
					anInboundRoute({
						id: "in-exact",
						name: "Specific",
						matchKind: "exact",
						matchPattern: "+15551230001",
					}),
				],
			}),
		);
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).matchedRuleId).toBe(
			"in-exact",
		);
	});

	it("prefers the longest matching prefix", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
				inboundRoutes: [
					anInboundRoute({
						id: "in-short",
						name: "Short",
						matchKind: "prefix",
						matchPattern: "+1",
						destinationRef: "ext-2",
					}),
					anInboundRoute({
						id: "in-long",
						name: "Long",
						matchKind: "prefix",
						matchPattern: "+1555123",
					}),
				],
			}),
		);
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).matchedRuleId).toBe(
			"in-long",
		);
	});

	it("lets a lower priority number win over a more specific pattern", () => {
		// Priority is the tenant's explicit statement of intent; specificity only breaks its ties.
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
				inboundRoutes: [
					anInboundRoute({
						id: "in-exact",
						name: "Specific",
						priority: 200,
						matchKind: "exact",
						matchPattern: "+15551230001",
					}),
					anInboundRoute({
						id: "in-any",
						name: "Catch all",
						priority: 1,
						matchKind: "any",
						destinationRef: "ext-2",
					}),
				],
			}),
		);
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).matchedRuleId).toBe(
			"in-any",
		);
	});

	it("honours a DID binding", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [aPhoneNumber(), aPhoneNumber({ id: "did-2", e164: "+15551230002" })],
				inboundRoutes: [anInboundRoute({ matchKind: "any", phoneNumberId: "did-1" })],
			}),
		);
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).matchedRuleId).toBe("in-1");
		expect(resolveInbound(artifact, { did: "+15551230002", now: NOW }).matchedRuleId).toBe("did-2");
	});

	it("applies a caller screen", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [
					anInboundRoute({ matchKind: "prefix", matchPattern: "+1555", callerIdPattern: "+1999" }),
				],
			}),
		);
		expect(
			resolveInbound(artifact, { did: "+15551230001", callerNumber: "+19995551212", now: NOW })
				.matched,
		).toBe(true);
		expect(
			resolveInbound(artifact, { did: "+15551230001", callerNumber: "+18885551212", now: NOW })
				.matched,
		).toBe(false);
	});

	it("screens by prefix when the route matches any DID", () => {
		// `any` would make an explicitly typed screen a no-op, so a screen on an `any` route falls
		// back to prefix matching — which is how caller screening is written in practice.
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [anInboundRoute({ matchKind: "any", callerIdPattern: "+1415" })],
			}),
		);
		expect(
			resolveInbound(artifact, { did: "+15551230001", callerNumber: "+14155550000", now: NOW })
				.matched,
		).toBe(true);
		expect(
			resolveInbound(artifact, { did: "+15551230001", callerNumber: "+12125550000", now: NOW })
				.matched,
		).toBe(false);
	});

	it("declines a caller-screened rule when the caller is anonymous", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [anInboundRoute({ matchKind: "any", callerIdPattern: "+1999" })],
			}),
		);
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).matched).toBe(false);
	});

	it("returns regex captures", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [
					anInboundRoute({ matchKind: "regex", matchPattern: "^\\+1(\\d{3})(\\d{7})$" }),
				],
			}),
		);
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).captures).toEqual([
			"555",
			"1230001",
		]);
	});

	it("prefixes the caller name from the DID", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [aPhoneNumber({ callerIdNamePrefix: "[Support] " })],
			}),
		);
		expect(
			resolveInbound(artifact, { did: "+15551230001", callerName: "Ada", now: NOW }).callerIdName,
		).toBe("[Support] Ada");
	});

	it("carries the route's record flag", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				inboundRoutes: [anInboundRoute({ recordEnabled: true })],
			}),
		);
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).recordEnabled).toBe(true);
	});
});

describe("resolveInbound — call blocking", () => {
	const artifact = compiled(
		aSnapshot({
			extensions: [anExtension()],
			phoneNumbers: [aPhoneNumber()],
			callBlockRules: [
				aCallBlockRule({ id: "cb-block", pattern: "+1555000", matchKind: "prefix" }),
				aCallBlockRule({
					id: "cb-allow",
					pattern: "+15550001111",
					matchKind: "exact",
					action: "allow",
				}),
				aCallBlockRule({
					id: "cb-reject",
					pattern: "+1900",
					matchKind: "prefix",
					action: "reject",
				}),
			],
		}),
	);

	it("blocks a matching caller with an explicit decline", () => {
		const route = resolveInbound(artifact, {
			did: "+15551230001",
			callerNumber: "+15550002222",
			now: NOW,
		});
		expect(route.blocked).toMatchObject({ ruleId: "cb-block", action: "block" });
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({
			cause: "CALL_REJECTED",
		});
	});

	it("rejects with a busy signal when the rule says reject", () => {
		const route = resolveInbound(artifact, {
			did: "+15551230001",
			callerNumber: "+19005551212",
			now: NOW,
		});
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({ cause: "USER_BUSY" });
	});

	it("lets an exact allow rule escape a broad prefix block", () => {
		const route = resolveInbound(artifact, {
			did: "+15551230001",
			callerNumber: "+15550001111",
			now: NOW,
		});
		expect(route.blocked).toBeUndefined();
		expect(route.plan?.entryNodeId).toBe("extension:ext-1");
	});

	it("leaves an unlisted caller alone", () => {
		const route = resolveInbound(artifact, {
			did: "+15551230001",
			callerNumber: "+442071234567",
			now: NOW,
		});
		expect(route.blocked).toBeUndefined();
	});

	it("does not screen an anonymous caller", () => {
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).blocked).toBeUndefined();
	});

	it("routes the call normally when the action is voicemail, flagging the diversion", () => {
		const voicemailBlock = compiled(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [aPhoneNumber()],
				callBlockRules: [aCallBlockRule({ action: "voicemail" })],
			}),
		);
		const route = resolveInbound(voicemailBlock, {
			did: "+15551230001",
			callerNumber: "+15550001111",
			now: NOW,
		});
		expect(route.blocked).toMatchObject({ action: "voicemail" });
		expect(route.plan?.entryNodeId).toBe("extension:ext-1");
	});

	it("records the decision as a diagnostic", () => {
		const route = resolveInbound(artifact, {
			did: "+15551230001",
			callerNumber: "+15550002222",
			now: NOW,
		});
		expect(route.diagnostics.map((entry) => entry.code)).toContain("call-blocked");
	});
});

describe("checkCallBlock", () => {
	const rules = [
		{
			id: "cb-in",
			pattern: { kind: "prefix", value: "+1" } as const,
			direction: "inbound" as const,
			action: "block" as const,
		},
		{
			id: "cb-both",
			pattern: { kind: "prefix", value: "+44" } as const,
			direction: "both" as const,
			action: "block" as const,
		},
	];

	it("matches a rule for its own direction", () => {
		expect(checkCallBlock(rules, "+15551212", "inbound")?.id).toBe("cb-in");
	});

	it("ignores a rule for the other direction", () => {
		expect(checkCallBlock(rules, "+15551212", "outbound")).toBeNull();
	});

	it("matches a 'both' rule in either direction", () => {
		expect(checkCallBlock(rules, "+442071234567", "outbound")?.id).toBe("cb-both");
		expect(checkCallBlock(rules, "+442071234567", "inbound")?.id).toBe("cb-both");
	});

	it("returns null for an absent value", () => {
		expect(checkCallBlock(rules, undefined, "inbound")).toBeNull();
	});

	it("returns null for an empty value", () => {
		expect(checkCallBlock(rules, "", "inbound")).toBeNull();
	});
});

describe("resolveInbound — time gates", () => {
	function gated(closedTo?: "voicemail" | "extension"): RoutingArtifact {
		return compiled(
			aSnapshot({
				extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
				voicemailBoxes: [aVoicemailBox()],
				timeConditions: [
					aTimeCondition({
						timezone: "UTC",
						...(closedTo === "voicemail"
							? { nomatchDestinationType: "voicemail" as const, nomatchDestinationRef: "vm-1" }
							: closedTo === "extension"
								? { nomatchDestinationType: "extension" as const, nomatchDestinationRef: "ext-2" }
								: {}),
					}),
				],
				timeConditionRules: [
					aTimeRule({
						predicates: [{ weekdays: [1, 2, 3, 4, 5], timeOfDay: { from: "09:00", to: "17:00" } }],
					}),
				],
				inboundRoutes: [anInboundRoute({ timeConditionId: "tc-1" })],
				phoneNumbers: [aPhoneNumber({ destinationRef: "ext-2" })],
			}),
		);
	}

	it("takes the route during business hours", () => {
		const route = resolveInbound(gated("voicemail"), { did: "+15551230001", now: NOW });
		expect(route.plan?.entryNodeId).toBe("extension:ext-1");
	});

	it("takes the closed branch outside business hours", () => {
		const route = resolveInbound(gated("voicemail"), {
			did: "+15551230001",
			now: at("2026-08-05T22:00:00Z"),
		});
		expect(route.plan?.entryNodeId).toBe("voicemail:vm-1:leave");
	});

	it("explains the closure", () => {
		const route = resolveInbound(gated("voicemail"), {
			did: "+15551230001",
			now: at("2026-08-05T22:00:00Z"),
		});
		expect(route.reason).toContain("time condition");
		expect(route.diagnostics.map((entry) => entry.code)).toContain("time-condition-closed");
	});

	it("records an open gate too, for the call-path trail", () => {
		const route = resolveInbound(gated("voicemail"), { did: "+15551230001", now: NOW });
		expect(route.diagnostics.map((entry) => entry.code)).toContain("time-condition-open");
	});

	it("falls through to the next candidate when a closed gate has no branch", () => {
		const route = resolveInbound(gated(), {
			did: "+15551230001",
			now: at("2026-08-05T22:00:00Z"),
		});
		// No closed branch, so the route is skipped and the DID's own destination applies.
		expect(route.matchedRuleId).toBe("did-1");
		expect(route.plan?.entryNodeId).toBe("extension:ext-2");
	});

	it("walks through a time-condition destination node using the same clock", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
				timeConditions: [
					aTimeCondition({
						nomatchDestinationType: "extension",
						nomatchDestinationRef: "ext-2",
					}),
				],
				timeConditionRules: [
					aTimeRule({ predicates: [{ timeOfDay: { from: "09:00", to: "17:00" } }] }),
				],
				phoneNumbers: [aPhoneNumber({ destinationType: "time-condition", destinationRef: "tc-1" })],
			}),
		);
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).plan?.entryNodeId).toBe(
			"extension:ext-1",
		);
		expect(
			resolveInbound(artifact, { did: "+15551230001", now: at("2026-08-05T22:00:00Z") }).plan
				?.entryNodeId,
		).toBe("extension:ext-2");
	});

	it("terminates a gate chain that has nowhere to go", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				timeConditions: [aTimeCondition()],
				timeConditionRules: [
					aTimeRule({ predicates: [{ timeOfDay: { from: "09:00", to: "17:00" } }] }),
				],
				phoneNumbers: [aPhoneNumber({ destinationType: "time-condition", destinationRef: "tc-1" })],
			}),
		);
		const route = resolveInbound(artifact, {
			did: "+15551230001",
			now: at("2026-08-05T22:00:00Z"),
		});
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({
			cause: "NORMAL_CLEARING",
		});
	});

	it("bounds the gate walk", () => {
		expect(MAX_GATE_DEPTH).toBeGreaterThan(1);
	});
});

describe("resolveInternal", () => {
	const artifact = compiled(
		aSnapshot({
			settings: { voicemailPrefix: "*99", voicemailCheckPrefix: "*95" },
			extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
			voicemailBoxes: [aVoicemailBox()],
			ringGroups: [aRingGroup({ extensionNumber: "2000" })],
			ringGroupDestinations: [aRingGroupMember()],
			ivrMenus: [anIvrMenu({ extensionNumber: "5000" })],
			ivrMenuOptions: [anIvrOption()],
			queues: [aQueue({ extensionNumber: "4000" })],
			conferences: [aConference()],
			parkLots: [aParkLot()],
			featureCodes: [
				aFeatureCode(),
				aFeatureCode({ id: "fc-2", code: "**", action: "call-pickup" }),
				aFeatureCode({ id: "fc-3", code: "*72", action: "call-forward-all" }),
			],
		}),
	);

	it("dials an extension", () => {
		const route = resolveInternal(artifact, { from: "1002", dialed: "1001", now: NOW });
		expect(route).toMatchObject({ matched: true });
		expect(route.plan?.entryNodeId).toBe("extension:ext-1");
	});

	it("dials a ring group by its internal number", () => {
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "2000", now: NOW }).plan?.entryNodeId,
		).toBe("ring-group:rg-1");
	});

	it("dials an IVR menu by its internal number", () => {
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "5000", now: NOW }).plan?.entryNodeId,
		).toBe("ivr-menu:ivr-1");
	});

	it("dials a queue by its internal number", () => {
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "4000", now: NOW }).plan?.entryNodeId,
		).toBe("queue:q-1");
	});

	it("dials a conference room", () => {
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "3001", now: NOW }).plan?.entryNodeId,
		).toBe("conference:conf-1");
	});

	it("matches a feature code before anything else", () => {
		const route = resolveInternal(artifact, { from: "1001", dialed: "*97", now: NOW });
		expect(route.plan?.entryNodeId).toBe("feature-code:fc-1");
		expect(route.matchedRuleName).toBe("*97");
	});

	it("captures a feature code's argument", () => {
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "**1001", now: NOW }).featureArgument,
		).toBe("1001");
	});

	it("omits the argument when a code is dialed alone", () => {
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "*72", now: NOW }).featureArgument,
		).toBeUndefined();
	});

	it("reaches a mailbox through the leave prefix", () => {
		expect(
			resolveInternal(artifact, { from: "1002", dialed: "*991001", now: NOW }).plan?.entryNodeId,
		).toBe("voicemail:vm-1:leave");
	});

	it("reaches a mailbox through the check prefix", () => {
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "*951001", now: NOW }).plan?.entryNodeId,
		).toBe("voicemail:vm-1:check");
	});

	it("does not treat a prefix with an unknown mailbox as a mailbox", () => {
		expect(resolveInternal(artifact, { from: "1001", dialed: "*999999", now: NOW }).matched).toBe(
			false,
		);
	});

	it("retrieves a parked call by slot", () => {
		const route = resolveInternal(artifact, { from: "1001", dialed: "705", now: NOW });
		expect(route.plan?.entryNodeId).toBe("park:park-1");
		expect(route.matchedRuleId).toBe("park-1");
	});

	it("ignores a number outside every park range", () => {
		expect(resolveInternal(artifact, { from: "1001", dialed: "800", now: NOW }).matched).toBe(
			false,
		);
	});

	it("reports no match so the caller can try outbound routing", () => {
		const route = resolveInternal(artifact, { from: "1001", dialed: "+15559998888", now: NOW });
		expect(route.matched).toBe(false);
		expect(route.reason).toContain("outbound");
	});

	it("never falls through to outbound by itself", () => {
		const route = resolveInternal(artifact, { from: "1001", dialed: "+15559998888", now: NOW });
		expect(route.context).toBe("internal");
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({ kind: "hangup" });
	});

	it("applies 'both'-direction call-block rules", () => {
		const blocked = compiled(
			aSnapshot({
				extensions: [anExtension()],
				callBlockRules: [
					aCallBlockRule({ pattern: "1001", matchKind: "exact", direction: "both" }),
				],
			}),
		);
		expect(
			resolveInternal(blocked, { from: "1002", dialed: "1001", now: NOW }).blocked,
		).toMatchObject({ action: "block" });
	});
});

describe("resolveOutbound — toll-class gate", () => {
	const artifact = compiled(
		aSnapshot({
			extensions: [
				anExtension({ number: "1001", tollClass: "national" }),
				anExtension({ id: "ext-2", number: "1002", tollClass: "local" }),
				anExtension({ id: "ext-3", number: "1003", tollClass: "premium" }),
			],
			trunks: [aTrunk()],
			outboundRoutes: [
				anOutboundRoute({
					id: "out-local",
					name: "Local",
					priority: 10,
					dialPatterns: ["+1555"],
					tollClass: "local",
				}),
				anOutboundRoute({
					id: "out-intl",
					name: "International",
					priority: 20,
					dialPatterns: ["+44"],
					tollClass: "international",
				}),
			],
		}),
	);

	it("allows a caller whose class covers the route", () => {
		const route = resolveOutbound(artifact, { from: "1001", dialed: "+15551230001", now: NOW });
		expect(route).toMatchObject({ matched: true, matchedRuleId: "out-local" });
	});

	it("refuses a caller whose class is too low", () => {
		const route = resolveOutbound(artifact, { from: "1002", dialed: "+442071234567", now: NOW });
		expect(route.matched).toBe(false);
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({
			cause: "OUTGOING_CALL_BARRED",
		});
	});

	it("explains the refusal", () => {
		const route = resolveOutbound(artifact, { from: "1002", dialed: "+442071234567", now: NOW });
		expect(route.diagnostics.map((entry) => entry.code)).toContain("toll-class-denied");
		expect(route.reason).toContain("local");
	});

	it("lets the highest class take every route", () => {
		expect(
			resolveOutbound(artifact, { from: "1003", dialed: "+442071234567", now: NOW }).matched,
		).toBe(true);
	});

	it("keeps walking past a denied route to a lower-class one that also matches", () => {
		const overlapping = compiled(
			aSnapshot({
				extensions: [anExtension({ tollClass: "local" })],
				trunks: [aTrunk()],
				outboundRoutes: [
					anOutboundRoute({
						id: "out-premium",
						name: "Premium",
						priority: 10,
						matchKind: "any",
						dialPatterns: [],
						tollClass: "premium",
					}),
					anOutboundRoute({
						id: "out-local",
						name: "Local",
						priority: 20,
						matchKind: "any",
						dialPatterns: [],
						tollClass: "local",
					}),
				],
			}),
		);
		expect(
			resolveOutbound(overlapping, { from: "1001", dialed: "+15551230001", now: NOW })
				.matchedRuleId,
		).toBe("out-local");
	});

	it("refuses a caller that is not an extension of this organization", () => {
		const route = resolveOutbound(artifact, {
			from: "+447700900000",
			dialed: "+15551230001",
			now: NOW,
		});
		expect(route.matched).toBe(false);
		expect(route.diagnostics.map((entry) => entry.code)).toContain("caller-not-internal");
	});

	it("accepts an explicit toll class for a caller that is not an extension", () => {
		expect(
			resolveOutbound(artifact, {
				from: "queue-callback",
				dialed: "+15551230001",
				now: NOW,
				tollClass: "national",
			}).matched,
		).toBe(true);
	});

	it("ignores an explicit toll class for a caller that is an extension", () => {
		// Otherwise an extension could escape its own class by asking nicely.
		const route = resolveOutbound(artifact, {
			from: "1002",
			dialed: "+442071234567",
			now: NOW,
			tollClass: "premium",
		});
		expect(route.matched).toBe(false);
	});

	it("refuses everything when outbound is switched off for the organization", () => {
		const disabled = compiled(
			aSnapshot({
				settings: { outboundEnabled: false },
				extensions: [anExtension()],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute()],
			}),
		);
		expect(
			resolveOutbound(disabled, { from: "1001", dialed: "+15551230001", now: NOW }).matched,
		).toBe(false);
	});
});

describe("resolveOutbound — digits and identity", () => {
	const artifact = compiled(
		aSnapshot({
			settings: { outboundCallerIdNumber: "+15550000000" },
			extensions: [
				anExtension(),
				anExtension({ id: "ext-2", number: "1002", outboundCallerIdNumber: "+15552220000" }),
			],
			trunks: [aTrunk()],
			outboundRoutes: [
				anOutboundRoute({
					id: "out-trunk9",
					name: "Trunk nine",
					matchKind: "prefix",
					dialPatterns: ["9"],
					stripDigits: 1,
					prependDigits: "+1",
				}),
			],
		}),
	);

	it("strips and prepends per the route", () => {
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "95551230001", now: NOW }).dialedNumber,
		).toBe("+15551230001");
	});

	it("skips a route whose manipulation would empty the number", () => {
		const greedy = compiled(
			aSnapshot({
				extensions: [anExtension()],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute({ matchKind: "any", dialPatterns: [], stripDigits: 20 })],
			}),
		);
		// Not `911`: that is in the emergency table now and never reaches an outbound rule at all.
		const route = resolveOutbound(greedy, { from: "1001", dialed: "5551230001", now: NOW });
		expect(route.matched).toBe(false);
		expect(route.diagnostics.map((entry) => entry.code)).toContain("digit-manipulation-underflow");
	});

	it("falls back to the organization caller id", () => {
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "95551230001", now: NOW }).callerIdNumber,
		).toBe("+15550000000");
	});

	it("prefers the extension's own outbound caller id", () => {
		expect(
			resolveOutbound(artifact, { from: "1002", dialed: "95551230001", now: NOW }).callerIdNumber,
		).toBe("+15552220000");
	});

	it("lets the route override every caller id", () => {
		const overridden = compiled(
			aSnapshot({
				extensions: [anExtension({ outboundCallerIdNumber: "+15551110000" })],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute({ callerIdNumberOverride: "+15559990000" })],
			}),
		);
		expect(
			resolveOutbound(overridden, { from: "1001", dialed: "+15551230001", now: NOW })
				.callerIdNumber,
		).toBe("+15559990000");
	});

	it("returns regex captures from the matching dial pattern", () => {
		const regexRoute = compiled(
			aSnapshot({
				extensions: [anExtension()],
				trunks: [aTrunk()],
				outboundRoutes: [
					anOutboundRoute({ matchKind: "regex", dialPatterns: ["^\\+1(\\d{10})$"] }),
				],
			}),
		);
		expect(
			resolveOutbound(regexRoute, { from: "1001", dialed: "+15551230001", now: NOW }).captures,
		).toEqual(["5551230001"]);
	});

	it("takes the first matching pattern in a route's list", () => {
		const multi = compiled(
			aSnapshot({
				extensions: [anExtension()],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute({ dialPatterns: ["+44", "+1"] })],
			}),
		);
		expect(resolveOutbound(multi, { from: "1001", dialed: "+15551230001", now: NOW }).matched).toBe(
			true,
		);
	});

	it("reports no match when nothing applies", () => {
		const route = resolveOutbound(artifact, { from: "1001", dialed: "+445551212", now: NOW });
		expect(route.matched).toBe(false);
		expect(route.diagnostics.map((entry) => entry.code)).toContain("no-match");
	});

	it("blocks an outbound call by rule", () => {
		const blocked = compiled(
			aSnapshot({
				extensions: [anExtension()],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute()],
				callBlockRules: [
					aCallBlockRule({ pattern: "+1900", matchKind: "prefix", direction: "outbound" }),
				],
			}),
		);
		expect(
			resolveOutbound(blocked, { from: "1001", dialed: "+19005551212", now: NOW }).blocked,
		).toMatchObject({ action: "block" });
	});

	it("does not apply an inbound-only block rule to an outbound call", () => {
		const blocked = compiled(
			aSnapshot({
				extensions: [anExtension()],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute()],
				callBlockRules: [
					aCallBlockRule({ pattern: "+1555", matchKind: "prefix", direction: "inbound" }),
				],
			}),
		);
		expect(
			resolveOutbound(blocked, { from: "1001", dialed: "+15551230001", now: NOW }).blocked,
		).toBeUndefined();
	});

	it("lands on the route's trunk-dial node", () => {
		const route = resolveOutbound(artifact, { from: "1001", dialed: "95551230001", now: NOW });
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({ kind: "trunk-dial" });
	});
});

describe("resolveOutbound — time gates", () => {
	const artifact = compiled(
		aSnapshot({
			extensions: [anExtension()],
			trunks: [aTrunk()],
			timeConditions: [
				aTimeCondition({ nomatchDestinationType: "hangup", nomatchDestinationData: {} }),
			],
			timeConditionRules: [
				aTimeRule({ predicates: [{ timeOfDay: { from: "09:00", to: "17:00" } }] }),
			],
			outboundRoutes: [anOutboundRoute({ timeConditionId: "tc-1" })],
		}),
	);

	it("dials out during the open window", () => {
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "+15551230001", now: NOW }).matched,
		).toBe(true);
	});

	it("takes the closed branch outside it", () => {
		const route = resolveOutbound(artifact, {
			from: "1001",
			dialed: "+15551230001",
			now: at("2026-08-05T22:00:00Z"),
		});
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({
			cause: "NORMAL_CLEARING",
		});
	});
});

describe("resolvers — behaviour on an artifact with warnings", () => {
	const withWarnings = compiled(
		aSnapshot({
			extensions: [anExtension()],
			phoneNumbers: [aPhoneNumber({ destinationType: "ring-group", destinationRef: "rg-1" })],
			// No members: compiles with `empty-ring-group`, and must still route.
			ringGroups: [aRingGroup()],
			trunks: [],
			outboundRoutes: [anOutboundRoute({ trunkPriority: [] })],
		}),
	);

	it("still compiles", () => {
		expect(withWarnings.diagnostics.some((entry) => entry.code === "empty-ring-group")).toBe(true);
	});

	it("still routes an inbound call to the empty group", () => {
		expect(resolveInbound(withWarnings, { did: "+15551230001", now: NOW }).plan?.entryNodeId).toBe(
			"ring-group:rg-1",
		);
	});

	it("still matches an outbound route whose trunk list is empty", () => {
		const route = resolveOutbound(withWarnings, { from: "1001", dialed: "+15551230001", now: NOW });
		expect(route.matched).toBe(true);
		expect(withWarnings.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({ attempts: [] });
	});

	it("keeps compile-time warnings on the artifact, not on the resolved route", () => {
		const route = resolveInbound(withWarnings, { did: "+15551230001", now: NOW });
		expect(route.diagnostics.map((entry) => entry.code)).not.toContain("empty-ring-group");
	});
});

describe("resolvers — determinism", () => {
	const artifact = inboundArtifact();

	it("returns the same answer for the same inputs", () => {
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW })).toEqual(
			resolveInbound(artifact, { did: "+15551230001", now: NOW }),
		);
	});

	it("omits absent fields rather than carrying undefined", () => {
		const route = resolveInbound(artifact, { did: "+15551230001", now: NOW });
		expect(Object.values(route).every((value) => value !== undefined)).toBe(true);
	});

	it("names its context", () => {
		expect(resolveInbound(artifact, { did: "+15551230001", now: NOW }).context).toBe("inbound");
		expect(resolveInternal(artifact, { from: "1001", dialed: "1002", now: NOW }).context).toBe(
			"internal",
		);
		expect(resolveOutbound(artifact, { from: "1001", dialed: "+441", now: NOW }).context).toBe(
			"outbound",
		);
	});
});
