import { describe, expect, it } from "bun:test";
import { parseRoutingArtifact } from "./artifact";
import { isArtifactFresh, invalidationKeysFor, routingCacheKey } from "./cache";
import { canonicalJson } from "./canonical-json";
import { compileRoutingArtifact } from "./compile";
import { planNodeReferences, reachableNodeIds } from "./plan";
import { resolveInbound, resolveInternal, resolveOutbound } from "./resolve";
import type { IvrMenuPlanNode, RingGroupPlanNode, TrunkDialPlanNode } from "./plan";
import type { OrgRoutingSnapshot } from "./snapshot";

/**
 * One realistic tenant, end to end.
 *
 * The unit specs prove each mechanism; this one proves they compose into a phone system. It is the
 * spec to read first when changing the compiler, and the one whose failure means something real is
 * broken rather than a detail moved.
 *
 * Acme Ltd: a main line that plays an IVR during business hours and goes to voicemail at night, a
 * sales ring group, a support queue, three extensions, a star-code catalogue, two carriers with
 * failover, and a caller they never want to hear from again.
 */
const ACME: OrgRoutingSnapshot = {
	organizationId: "acme",
	settings: {
		defaultTimezone: "America/New_York",
		voicemailPrefix: "*99",
		voicemailCheckPrefix: "*98",
		outboundCallerIdNumber: "+12125550100",
		outboundEnabled: true,
	},
	extensions: [
		{
			id: "ext-reception",
			enabled: true,
			number: "100",
			label: "Reception",
			tollClass: "national",
			recordPolicy: "none",
			callTimeoutSeconds: 20,
			voicemailEnabled: true,
			doNotDisturb: false,
			forwardAllEnabled: false,
			forwardBusyEnabled: false,
			forwardNoAnswerEnabled: false,
			forwardUnregisteredEnabled: false,
		},
		{
			id: "ext-sales",
			enabled: true,
			number: "101",
			label: "Sales",
			tollClass: "international",
			recordPolicy: "all",
			callTimeoutSeconds: 30,
			voicemailEnabled: true,
			doNotDisturb: false,
			forwardAllEnabled: false,
			forwardBusyEnabled: false,
			forwardNoAnswerEnabled: false,
			forwardUnregisteredEnabled: true,
			forwardUnregisteredDestination: "+12125559999",
			outboundCallerIdNumber: "+12125550101",
		},
		{
			id: "ext-intern",
			enabled: true,
			number: "102",
			label: "Intern",
			tollClass: "local",
			recordPolicy: "none",
			callTimeoutSeconds: 30,
			voicemailEnabled: false,
			doNotDisturb: false,
			forwardAllEnabled: false,
			forwardBusyEnabled: false,
			forwardNoAnswerEnabled: false,
			forwardUnregisteredEnabled: false,
			// The intern sits in the warehouse, which has its own registered callback number.
			emergencyCallerIdNumber: "+12125550199",
		},
	],
	voicemailBoxes: [
		{
			id: "vm-100",
			enabled: true,
			mailboxNumber: "100",
			extensionId: "ext-reception",
			mwiEnabled: true,
			maxMessageSeconds: 300,
		},
		{
			id: "vm-101",
			enabled: true,
			mailboxNumber: "101",
			extensionId: "ext-sales",
			mwiEnabled: true,
			maxMessageSeconds: 300,
		},
		{
			id: "vm-main",
			enabled: true,
			mailboxNumber: "900",
			label: "Main line after hours",
			mwiEnabled: false,
			maxMessageSeconds: 180,
		},
	],
	phoneNumbers: [
		{
			id: "did-main",
			enabled: true,
			e164: "+12125550100",
			label: "Main line",
			callerIdNamePrefix: "[Acme] ",
			destinationType: "time-condition",
			destinationRef: "tc-hours",
			recordEnabled: false,
			voiceEnabled: true,
			emergencyAddressId: "addr-hq",
		},
		{
			id: "did-sales",
			enabled: true,
			e164: "+12125550101",
			destinationType: "ring-group",
			destinationRef: "rg-sales",
			recordEnabled: true,
			voiceEnabled: true,
			emergencyAddressId: "addr-hq",
		},
	],
	emergencyAddresses: [
		{ id: "addr-hq", label: "Acme HQ, 4th floor", validated: true },
		{ id: "addr-warehouse", label: "Acme warehouse", validated: false },
	],
	timeConditions: [
		{
			id: "tc-hours",
			enabled: true,
			name: "Business hours",
			timezone: "America/New_York",
			destinationType: "ivr",
			destinationRef: "ivr-main",
			nomatchDestinationType: "voicemail",
			nomatchDestinationRef: "vm-main",
		},
	],
	timeConditionRules: [
		{
			id: "tcr-weekday",
			enabled: true,
			timeConditionId: "tc-hours",
			ordinal: 1,
			label: "Mon-Fri 09:00-17:00",
			predicates: [{ weekdays: [1, 2, 3, 4, 5], timeOfDay: { from: "09:00", to: "17:00" } }],
		},
	],
	ivrMenus: [
		{
			id: "ivr-main",
			enabled: true,
			name: "Main menu",
			extensionNumber: "500",
			greetingPromptId: "prompt-greeting",
			digitTimeoutMs: 5000,
			interDigitTimeoutMs: 2000,
			maxDigits: 1,
			maxFailures: 3,
			maxTimeouts: 3,
			directDialEnabled: true,
			timeoutDestinationType: "extension",
			timeoutDestinationRef: "ext-reception",
			invalidDestinationType: "extension",
			invalidDestinationRef: "ext-reception",
		},
	],
	ivrMenuOptions: [
		{
			id: "opt-1",
			enabled: true,
			ivrMenuId: "ivr-main",
			ordinal: 1,
			matchKind: "digit",
			matchValue: "1",
			label: "Sales",
			destinationType: "ring-group",
			destinationRef: "rg-sales",
		},
		{
			id: "opt-2",
			enabled: true,
			ivrMenuId: "ivr-main",
			ordinal: 2,
			matchKind: "digit",
			matchValue: "2",
			label: "Support",
			destinationType: "queue",
			destinationRef: "q-support",
		},
		{
			id: "opt-0",
			enabled: true,
			ivrMenuId: "ivr-main",
			ordinal: 3,
			matchKind: "digit",
			matchValue: "0",
			label: "Operator",
			destinationType: "extension",
			destinationRef: "ext-reception",
		},
	],
	ringGroups: [
		{
			id: "rg-sales",
			enabled: true,
			name: "Sales team",
			extensionNumber: "200",
			strategy: "sequential",
			ringTimeoutSeconds: 45,
			ignoreBusy: true,
			confirmEnabled: false,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: "vm-101",
		},
	],
	ringGroupDestinations: [
		{
			id: "rgd-sales-1",
			enabled: true,
			ringGroupId: "rg-sales",
			ordinal: 1,
			destinationType: "extension",
			destinationRef: "ext-sales",
			delaySeconds: 0,
			timeoutSeconds: 20,
			confirmRequired: false,
		},
		{
			id: "rgd-sales-2",
			enabled: true,
			ringGroupId: "rg-sales",
			ordinal: 2,
			destinationType: "extension",
			destinationRef: "ext-reception",
			delaySeconds: 20,
			timeoutSeconds: 25,
			confirmRequired: false,
		},
	],
	queues: [
		{
			id: "q-support",
			enabled: true,
			name: "Support",
			extensionNumber: "300",
			strategy: "longest-idle",
			maxWaitSeconds: 900,
			maxWaitNoAgentSeconds: 60,
			announcePositionEnabled: true,
			announceFrequencySeconds: 60,
			recordEnabled: true,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: "vm-main",
		},
	],
	conferences: [
		{
			id: "conf-board",
			enabled: true,
			name: "Board room",
			roomNumber: "800",
			requiresPin: true,
			maxMembers: 20,
			waitForModerator: true,
			recordEnabled: false,
		},
	],
	parkLots: [
		{
			id: "lot-main",
			enabled: true,
			name: "Main lot",
			slotStart: 701,
			slotEnd: 720,
			timeoutSeconds: 120,
			timeoutDestinationType: "extension",
			timeoutDestinationRef: "ext-reception",
		},
	],
	trunks: [
		{
			id: "trunk-primary",
			enabled: true,
			name: "Primary",
			kind: "ip-auth",
			sipDomain: "primary.carrier.example",
			sipProxy: "sip.primary.carrier.example",
			transport: "udp",
			maxChannels: 30,
		},
		{
			id: "trunk-backup",
			enabled: true,
			name: "Backup",
			kind: "register",
			sipDomain: "backup.carrier.example",
			sipProxy: "sip.backup.carrier.example",
			transport: "tls",
		},
	],
	inboundRoutes: [
		{
			id: "in-vip",
			enabled: true,
			name: "VIP straight to sales",
			priority: 10,
			matchKind: "any",
			callerIdPattern: "+1415",
			destinationType: "extension",
			destinationRef: "ext-sales",
			recordEnabled: true,
		},
	],
	outboundRoutes: [
		{
			id: "out-emergency",
			enabled: true,
			name: "Emergency",
			priority: 1,
			matchKind: "exact",
			dialPatterns: ["911"],
			stripDigits: 0,
			tollClass: "internal",
			trunkPriority: [
				{ trunkId: "trunk-primary", order: 1 },
				{ trunkId: "trunk-backup", order: 2 },
			],
			recordEnabled: true,
		},
		{
			id: "out-national",
			enabled: true,
			name: "US national",
			priority: 100,
			matchKind: "regex",
			dialPatterns: ["^\\+1\\d{10}$"],
			stripDigits: 0,
			tollClass: "national",
			trunkPriority: [
				{ trunkId: "trunk-primary", order: 1 },
				{ trunkId: "trunk-backup", order: 2 },
			],
			recordEnabled: false,
		},
		{
			id: "out-intl",
			enabled: true,
			name: "International",
			priority: 200,
			matchKind: "prefix",
			dialPatterns: ["+"],
			stripDigits: 0,
			tollClass: "international",
			trunkPriority: [{ trunkId: "trunk-backup", order: 1 }],
			recordEnabled: false,
		},
	],
	featureCodes: [
		{ id: "fc-vm", enabled: true, code: "*97", action: "voicemail-check", label: "My voicemail" },
		{ id: "fc-pickup", enabled: true, code: "*8", action: "group-pickup", label: "Group pickup" },
		{
			id: "fc-directed",
			enabled: true,
			code: "**",
			action: "call-pickup",
			label: "Directed pickup",
		},
		{
			id: "fc-park",
			enabled: true,
			code: "*5",
			action: "call-park",
			params: { lotId: "lot-main" },
			label: "Park",
		},
		{ id: "fc-dnd", enabled: true, code: "*78", action: "do-not-disturb", label: "DND" },
	],
	callBlockRules: [
		{
			id: "cb-nuisance",
			enabled: true,
			pattern: "+1800",
			matchKind: "prefix",
			direction: "inbound",
			action: "block",
			label: "Cold callers",
		},
		{
			id: "cb-partner",
			enabled: true,
			pattern: "+18005550123",
			matchKind: "exact",
			direction: "inbound",
			action: "allow",
			label: "Our own 800 number",
		},
		{
			id: "cb-premium",
			enabled: true,
			pattern: "+1900",
			matchKind: "prefix",
			direction: "outbound",
			action: "block",
			label: "Premium rate",
		},
	],
};

const COMPILED_AT = "2026-08-05T12:00:00.000Z";
const artifact = compileRoutingArtifact(ACME, { compiledAt: COMPILED_AT });

/** Wednesday 11:00 and 21:00 New York, expressed as instants. */
const DURING_HOURS = new Date("2026-08-05T15:00:00Z");
const AFTER_HOURS = new Date("2026-08-06T01:00:00Z");

describe("Acme — the artifact", () => {
	it("compiles cleanly", () => {
		expect(artifact.diagnostics).toEqual([]);
	});

	it("is closed under reference", () => {
		for (const node of Object.values(artifact.nodes)) {
			for (const reference of planNodeReferences(node)) {
				expect(artifact.nodes[reference]).toBeDefined();
			}
		}
	});

	it("survives the KV round trip it will actually take", () => {
		const round = parseRoutingArtifact(JSON.parse(JSON.stringify(artifact)));
		expect(canonicalJson(round)).toBe(canonicalJson(artifact));
	});

	it("recompiles byte-identically", () => {
		expect(canonicalJson(compileRoutingArtifact(ACME, { compiledAt: COMPILED_AT }))).toBe(
			canonicalJson(artifact),
		);
	});

	it("is addressed by one cache key", () => {
		expect(routingCacheKey(ACME.organizationId)).toBe("acme.artifact");
		expect(
			invalidationKeysFor({
				organizationId: ACME.organizationId,
				table: "ivr_menu_option",
				operation: "update",
			}),
		).toEqual(["acme.artifact"]);
	});

	it("knows it is fresh for the snapshot it came from", () => {
		expect(isArtifactFresh(artifact, ACME)).toBe(true);
	});
});

describe("Acme — inbound during business hours", () => {
	it("sends the main line to the IVR", () => {
		const route = resolveInbound(artifact, { did: "+12125550100", now: DURING_HOURS });
		expect(route.plan?.entryNodeId).toBe("ivr-menu:ivr-main");
	});

	it("prefixes the caller name with the DID's label", () => {
		expect(
			resolveInbound(artifact, { did: "+12125550100", callerName: "Ada", now: DURING_HOURS })
				.callerIdName,
		).toBe("[Acme] Ada");
	});

	it("offers sales, support and the operator from the menu", () => {
		const menu = artifact.nodes["ivr-menu:ivr-main"] as IvrMenuPlanNode;
		expect(menu.options.map((option) => option.targetNodeId)).toEqual([
			"ring-group:rg-sales",
			"queue:q-support",
			"extension:ext-reception",
		]);
	});

	it("sends an unanswered menu to reception", () => {
		const menu = artifact.nodes["ivr-menu:ivr-main"] as IvrMenuPlanNode;
		expect(menu.timeoutNodeId).toBe("extension:ext-reception");
		expect(menu.invalidNodeId).toBe("extension:ext-reception");
	});

	it("routes a VIP caller straight past the menu", () => {
		const route = resolveInbound(artifact, {
			did: "+12125550100",
			callerNumber: "+14155550000",
			now: DURING_HOURS,
		});
		expect(route.matchedRuleId).toBe("in-vip");
		expect(route.plan?.entryNodeId).toBe("extension:ext-sales");
	});

	it("sends the sales DID to the ring group without a route", () => {
		const route = resolveInbound(artifact, { did: "+12125550101", now: DURING_HOURS });
		expect(route.plan?.entryNodeId).toBe("ring-group:rg-sales");
		expect(route.recordEnabled).toBe(true);
	});
});

describe("Acme — inbound after hours", () => {
	it("sends the main line to the after-hours mailbox", () => {
		const route = resolveInbound(artifact, { did: "+12125550100", now: AFTER_HOURS });
		expect(route.plan?.entryNodeId).toBe("voicemail:vm-main:leave");
	});

	it("says why", () => {
		const route = resolveInbound(artifact, { did: "+12125550100", now: AFTER_HOURS });
		expect(route.diagnostics.map((entry) => entry.code)).toContain("time-condition-closed");
	});

	it("still routes a VIP, because their rule has no time gate", () => {
		expect(
			resolveInbound(artifact, {
				did: "+12125550100",
				callerNumber: "+14155550000",
				now: AFTER_HOURS,
			}).plan?.entryNodeId,
		).toBe("extension:ext-sales");
	});

	it("uses the tenant's zone, not the server's", () => {
		// 2026-08-06T01:00Z is 21:00 on 5 August in New York: after hours there, next day in UTC.
		const route = resolveInbound(artifact, { did: "+12125550100", now: AFTER_HOURS });
		expect(route.plan?.entryNodeId).not.toBe("ivr-menu:ivr-main");
	});
});

describe("Acme — inbound screening", () => {
	it("blocks a cold caller", () => {
		const route = resolveInbound(artifact, {
			did: "+12125550100",
			callerNumber: "+18005559999",
			now: DURING_HOURS,
		});
		expect(route.blocked?.ruleId).toBe("cb-nuisance");
	});

	it("lets the company's own 800 number through the same prefix block", () => {
		const route = resolveInbound(artifact, {
			did: "+12125550100",
			callerNumber: "+18005550123",
			now: DURING_HOURS,
		});
		expect(route.blocked).toBeUndefined();
		expect(route.plan?.entryNodeId).toBe("ivr-menu:ivr-main");
	});
});

describe("Acme — the sales ring group", () => {
	const group = artifact.nodes["ring-group:rg-sales"] as RingGroupPlanNode;

	it("rings sales first, then reception after a delay", () => {
		expect(group.members).toEqual([
			{
				ordinal: 1,
				delaySeconds: 0,
				timeoutSeconds: 20,
				confirmRequired: false,
				targetNodeId: "extension:ext-sales",
			},
			{
				ordinal: 2,
				delaySeconds: 20,
				timeoutSeconds: 25,
				confirmRequired: false,
				targetNodeId: "extension:ext-reception",
			},
		]);
	});

	it("falls to the sales mailbox when nobody answers", () => {
		expect(group.timeoutNodeId).toBe("voicemail:vm-101:leave");
	});

	it("reaches a mailbox from the group without leaving the artifact", () => {
		expect(reachableNodeIds(artifact.nodes, "ring-group:rg-sales")).toContain(
			"voicemail:vm-101:leave",
		);
	});

	it("sends a call to an unregistered sales phone to their mobile", () => {
		expect(artifact.nodes["extension:ext-sales"]).toMatchObject({
			notRegisteredNodeId: "external:+12125559999",
		});
	});

	it("routes that mobile back out through outbound routing", () => {
		expect(artifact.nodes["external:+12125559999"]).toMatchObject({ viaOutboundRouting: true });
	});
});

describe("Acme — internal dialing", () => {
	it("dials an extension", () => {
		expect(
			resolveInternal(artifact, { from: "100", dialed: "101", now: DURING_HOURS }).plan
				?.entryNodeId,
		).toBe("extension:ext-sales");
	});

	it("dials the ring group, the queue, the IVR and the conference by number", () => {
		const expected: Record<string, string> = {
			"200": "ring-group:rg-sales",
			"300": "queue:q-support",
			"500": "ivr-menu:ivr-main",
			"800": "conference:conf-board",
		};
		for (const [dialed, nodeId] of Object.entries(expected)) {
			expect(
				resolveInternal(artifact, { from: "100", dialed, now: DURING_HOURS }).plan?.entryNodeId,
			).toBe(nodeId);
		}
	});

	it("checks your own voicemail with *97", () => {
		expect(
			resolveInternal(artifact, { from: "100", dialed: "*97", now: DURING_HOURS }).plan
				?.entryNodeId,
		).toBe("feature-code:fc-vm");
	});

	it("picks up a specific extension with **101", () => {
		const route = resolveInternal(artifact, { from: "100", dialed: "**101", now: DURING_HOURS });
		expect(route.plan?.entryNodeId).toBe("feature-code:fc-directed");
		expect(route.featureArgument).toBe("101");
	});

	it("parks a call into the configured lot", () => {
		expect(artifact.nodes["feature-code:fc-park"]).toMatchObject({
			targetNodeId: "park:lot-main",
		});
	});

	it("retrieves a parked call from a slot", () => {
		expect(
			resolveInternal(artifact, { from: "100", dialed: "710", now: DURING_HOURS }).plan
				?.entryNodeId,
		).toBe("park:lot-main");
	});

	it("leaves a message directly with *99101", () => {
		expect(
			resolveInternal(artifact, { from: "100", dialed: "*99101", now: DURING_HOURS }).plan
				?.entryNodeId,
		).toBe("voicemail:vm-101:leave");
	});

	it("opens a mailbox with *98101", () => {
		expect(
			resolveInternal(artifact, { from: "100", dialed: "*98101", now: DURING_HOURS }).plan
				?.entryNodeId,
		).toBe("voicemail:vm-101:check");
	});

	it("reports no match for an external number so the engine tries outbound", () => {
		expect(
			resolveInternal(artifact, { from: "100", dialed: "+12125559999", now: DURING_HOURS }).matched,
		).toBe(false);
	});
});

describe("Acme — outbound", () => {
	it("lets the intern dial an emergency number despite their local class", () => {
		// Not by matching the tenant's own `out-emergency` route: the compiled-in emergency table is
		// consulted before the rule list exists, so privilege never enters into it.
		const route = resolveOutbound(artifact, { from: "102", dialed: "911", now: DURING_HOURS });
		expect(route.matchedRuleId).toBe("emergency");
		expect(route.dialedNumber).toBe("911");
	});

	it("presents the intern's own registered callback number on 911", () => {
		expect(
			resolveOutbound(artifact, { from: "102", dialed: "911", now: DURING_HOURS }).callerIdNumber,
		).toBe("+12125550199");
	});

	it("presents the organization ELIN for an extension with no callback number of its own", () => {
		// `+12125550100` is the lowest-sorting DID carrying a VALIDATED emergency address.
		expect(
			resolveOutbound(artifact, { from: "100", dialed: "911", now: DURING_HOURS }).callerIdNumber,
		).toBe("+12125550100");
	});

	it("dials 911 with outbound calling switched off for the whole organization", () => {
		const dark = compileRoutingArtifact(
			{ ...ACME, settings: { ...ACME.settings, outboundEnabled: false } },
			{ compiledAt: COMPILED_AT },
		);
		expect(
			resolveOutbound(dark, { from: "100", dialed: "+12125559999", now: DURING_HOURS }).matched,
		).toBe(false);
		expect(resolveOutbound(dark, { from: "100", dialed: "911", now: DURING_HOURS }).matched).toBe(
			true,
		);
	});

	it("still reaches an emergency node from the tenant's own priority-1 route", () => {
		expect(artifact.outbound.rules[0]?.id).toBe("out-emergency");
	});

	it("routes a US number over the national route", () => {
		expect(
			resolveOutbound(artifact, { from: "100", dialed: "+12125559999", now: DURING_HOURS })
				.matchedRuleId,
		).toBe("out-national");
	});

	it("refuses the intern an international call", () => {
		const route = resolveOutbound(artifact, {
			from: "102",
			dialed: "+442071234567",
			now: DURING_HOURS,
		});
		expect(route.matched).toBe(false);
		expect(artifact.nodes[route.plan?.entryNodeId ?? ""]).toMatchObject({
			cause: "OUTGOING_CALL_BARRED",
		});
	});

	it("allows sales the same international call", () => {
		expect(
			resolveOutbound(artifact, { from: "101", dialed: "+442071234567", now: DURING_HOURS })
				.matchedRuleId,
		).toBe("out-intl");
	});

	it("refuses reception an international call, since national does not cover it", () => {
		expect(
			resolveOutbound(artifact, { from: "100", dialed: "+442071234567", now: DURING_HOURS })
				.matched,
		).toBe(false);
	});

	it("presents the extension's own caller id when it has one", () => {
		expect(
			resolveOutbound(artifact, { from: "101", dialed: "+12125559999", now: DURING_HOURS })
				.callerIdNumber,
		).toBe("+12125550101");
	});

	it("falls back to the organization's number otherwise", () => {
		expect(
			resolveOutbound(artifact, { from: "100", dialed: "+12125559999", now: DURING_HOURS })
				.callerIdNumber,
		).toBe("+12125550100");
	});

	it("blocks a premium-rate number outright", () => {
		expect(
			resolveOutbound(artifact, { from: "101", dialed: "+19005551212", now: DURING_HOURS }).blocked
				?.ruleId,
		).toBe("cb-premium");
	});

	it("tries the primary carrier before the backup", () => {
		const node = artifact.nodes["trunk-dial:out-national"] as TrunkDialPlanNode;
		expect(node.attempts.map((attempt) => attempt.name)).toEqual(["Primary", "Backup"]);
	});

	it("only continues to the backup on a retryable cause", () => {
		const node = artifact.nodes["trunk-dial:out-national"] as TrunkDialPlanNode;
		expect(node.continueOnCauses).toContain("GATEWAY_DOWN");
		expect(node.continueOnCauses).not.toContain("CALL_REJECTED");
		expect(node.continueOnCauses).not.toContain("USER_BUSY");
	});

	it("refuses an outside caller that somehow reached the outbound context", () => {
		// Toll-fraud rule #1: an unauthenticated leg has no toll class and therefore no route.
		const route = resolveOutbound(artifact, {
			from: "+447700900000",
			dialed: "+442071234567",
			now: DURING_HOURS,
		});
		expect(route.matched).toBe(false);
		expect(route.diagnostics.map((entry) => entry.code)).toContain("caller-not-internal");
	});
});

describe("Acme — invalidation", () => {
	it("goes stale when an IVR option moves", () => {
		const edited: OrgRoutingSnapshot = {
			...ACME,
			ivrMenuOptions: ACME.ivrMenuOptions.map((option) =>
				option.id === "opt-1" ? { ...option, matchValue: "3" } : option,
			),
		};
		expect(isArtifactFresh(artifact, edited)).toBe(false);
	});

	it("goes stale when an extension's toll class changes", () => {
		const promoted: OrgRoutingSnapshot = {
			...ACME,
			extensions: ACME.extensions.map((extension) =>
				extension.id === "ext-intern"
					? { ...extension, tollClass: "international" as const }
					: extension,
			),
		};
		expect(isArtifactFresh(artifact, promoted)).toBe(false);
		const recompiled = compileRoutingArtifact(promoted, { compiledAt: COMPILED_AT });
		expect(
			resolveOutbound(recompiled, { from: "102", dialed: "+442071234567", now: DURING_HOURS })
				.matched,
		).toBe(true);
	});

	it("stays fresh when nothing routing reads has changed", () => {
		expect(isArtifactFresh(artifact, { ...ACME })).toBe(true);
	});
});
