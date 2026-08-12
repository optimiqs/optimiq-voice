import { describe, expect, it } from "bun:test";
import { createEntityId } from "@optimiq-voice/identifiers";
import {
	aorSubjectToken,
	CALL_EVENTS,
	EVENT_FAMILIES,
	eventFamilyForSubject,
	instanceSubjectToken,
	isCallEvent,
	isEventName,
	isQueueEvent,
	isRegistrationEvent,
	isSubjectToken,
	isTrunkEvent,
	matchesSubject,
	parseSubject,
	parseSubjectOrThrow,
	QUEUE_EVENTS,
	QUEUE_SCOPE_ALL,
	REGISTRATION_EVENTS,
	RPC_SUBJECTS,
	SUBJECT_ROOTS,
	SUBJECT_VERSION,
	subjectFilterFor,
	subjectFor,
	SubjectTokenError,
	TRUNK_EVENTS,
	UnknownSubjectError,
} from "./subjects";

const ORG = "018f2b7c-0000-7000-8000-0000000000aa";
const CALL = "018f2b7c-0000-7000-8000-0000000000bb";
const QUEUE = "018f2b7c-0000-7000-8000-0000000000cc";
const TRUNK = "018f2b7c-0000-7000-8000-0000000000dd";
const AOR_HASH = aorSubjectToken("sip:1001@acme.example.com");

describe("subject roots", () => {
	it("pins the taxonomy from plan §3.5", () => {
		expect(SUBJECT_VERSION).toBe("v1");
		expect(SUBJECT_ROOTS).toEqual({
			call: "calls.evt.v1",
			registration: "sip.reg.v1",
			queue: "queue.evt.v1",
			voicemail: "voicemail.evt.v1",
			media: "media.evt.v1",
			trunk: "trunk.evt.v1",
			cdrLeg: "cdr.leg.v1",
			audit: "audit.evt.v1",
			provision: "provision.evt.v1",
		});
		expect(RPC_SUBJECTS).toEqual({
			routingResolve: "rpc.routing.v1.resolve",
			authzCheck: "rpc.authz.v1.check",
			voicemailList: "rpc.voicemail.v1.list",
			pbxExtensionFeature: "rpc.pbx.v1.extension-feature",
			pbxLastCaller: "rpc.pbx.v1.last-caller",
			pbxFileGreeting: "rpc.pbx.v1.file-greeting",
			sipCredential: "rpc.sip.v1.credential",
			sipTransfer: "rpc.sip.v1.transfer",
			mediaAllocateSession: "rpc.media.v1.allocate-session",
			mediaBridgeSessions: "rpc.media.v1.bridge-sessions",
			mediaUnbridgeSessions: "rpc.media.v1.unbridge-sessions",
			mediaReleaseSession: "rpc.media.v1.release-session",
			mediaStartPlayback: "rpc.media.v1.start-playback",
			mediaStopPlayback: "rpc.media.v1.stop-playback",
			mediaSendDtmf: "rpc.media.v1.send-dtmf",
			mediaStartRecording: "rpc.media.v1.start-recording",
			mediaStopRecording: "rpc.media.v1.stop-recording",
			mediaTapSession: "rpc.media.v1.tap-session",
			mediaUntapSession: "rpc.media.v1.untap-session",
			engineOriginate: "rpc.engine.v1.originate",
			engineParkHandoff: "rpc.engine.v1.park-handoff",
		});
	});

	it("carries the major version in every root", () => {
		for (const root of Object.values(SUBJECT_ROOTS)) {
			expect(root.endsWith(`.${SUBJECT_VERSION}`)).toBe(true);
		}
		for (const subject of Object.values(RPC_SUBJECTS)) {
			expect(subject.split(".")).toContain(SUBJECT_VERSION);
		}
	});

	it("names one family per event root", () => {
		expect([...EVENT_FAMILIES].sort()).toEqual([
			"audit",
			"call",
			"cdr",
			"media",
			"provision",
			"queue",
			"registration",
			"trunk",
			"voicemail",
		]);
	});
});

describe("subjectFor", () => {
	it("builds every family's subject", () => {
		expect(subjectFor.call(ORG, CALL, "channel.answered")).toBe(
			`calls.evt.v1.${ORG}.${CALL}.channel.answered`,
		);
		expect(subjectFor.registration(ORG, AOR_HASH, "registered")).toBe(
			`sip.reg.v1.${ORG}.${AOR_HASH}.registered`,
		);
		expect(subjectFor.queue(ORG, QUEUE, "caller.joined")).toBe(
			`queue.evt.v1.${ORG}.${QUEUE}.caller.joined`,
		);
		expect(subjectFor.trunk(ORG, TRUNK, "status.changed")).toBe(
			`trunk.evt.v1.${ORG}.${TRUNK}.status.changed`,
		);
		expect(subjectFor.cdrLeg(ORG)).toBe(`cdr.leg.v1.${ORG}`);
		expect(subjectFor.audit(ORG)).toBe(`audit.evt.v1.${ORG}`);
		expect(subjectFor.provision(ORG)).toBe(`provision.evt.v1.${ORG}`);
		expect(subjectFor.routingResolveRpc()).toBe("rpc.routing.v1.resolve");
		expect(subjectFor.authzCheckRpc()).toBe("rpc.authz.v1.check");
		expect(subjectFor.pbxExtensionFeatureRpc()).toBe("rpc.pbx.v1.extension-feature");
		expect(subjectFor.pbxLastCallerRpc()).toBe("rpc.pbx.v1.last-caller");
		expect(subjectFor.pbxFileGreetingRpc()).toBe("rpc.pbx.v1.file-greeting");
		expect(subjectFor.sipCredentialRpc()).toBe("rpc.sip.v1.credential");
		expect(subjectFor.sipTransferRpc()).toBe("rpc.sip.v1.transfer");
	});

	it("keeps multi-token event names in the subject tail", () => {
		expect(subjectFor.call(ORG, CALL, "channel.record.started").split(".")).toHaveLength(8);
	});

	it("accepts the reserved org-wide queue scope", () => {
		expect(subjectFor.queue(ORG, QUEUE_SCOPE_ALL, "agent.state")).toBe(
			`queue.evt.v1.${ORG}._all.agent.state`,
		);
	});

	it.each([
		["a dot", "acme.example"],
		["a wildcard star", "*"],
		["a wildcard gt", ">"],
		["whitespace", "org id"],
		["empty", ""],
		["an at sign", "sip:1001@acme"],
	])("rejects an org token containing %s", (_label, value) => {
		expect(() => subjectFor.cdrLeg(value)).toThrow(SubjectTokenError);
	});

	it("rejects a wildcard smuggled into an event name", () => {
		expect(() => subjectFor.call(ORG, CALL, "channel.*")).toThrow(SubjectTokenError);
		expect(() => subjectFor.call(ORG, CALL, "channel..created")).toThrow(SubjectTokenError);
	});
});

describe("aorSubjectToken", () => {
	it("is a stable 32-character hex token", () => {
		expect(AOR_HASH).toMatch(/^[0-9a-f]{32}$/);
		expect(aorSubjectToken("sip:1001@acme.example.com")).toBe(AOR_HASH);
	});

	it("normalises case and surrounding whitespace", () => {
		expect(aorSubjectToken("  SIP:1001@ACME.example.com ")).toBe(AOR_HASH);
	});

	it("separates different AORs", () => {
		expect(aorSubjectToken("sip:1002@acme.example.com")).not.toBe(AOR_HASH);
	});

	it("is always a legal subject token", () => {
		expect(isSubjectToken(AOR_HASH)).toBe(true);
	});

	it("rejects an empty AOR", () => {
		expect(() => aorSubjectToken("   ")).toThrow(SubjectTokenError);
	});
});

describe("instanceSubjectToken", () => {
	it("passes a token-shaped instance id through verbatim, so the subject stays readable", () => {
		expect(instanceSubjectToken("engine")).toBe("engine");
		expect(instanceSubjectToken("engine-7d9f4c-xk2lp")).toBe("engine-7d9f4c-xk2lp");
		expect(instanceSubjectToken("  engine-2  ")).toBe("engine-2");
	});

	it("hashes an id that could not be one token, so an FQDN hostname does not become four", () => {
		const token = instanceSubjectToken("engine.eu-west.internal");
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		expect(isSubjectToken(token)).toBe(true);
		expect(instanceSubjectToken("engine.eu-west.internal")).toBe(token);
	});

	it("separates two instances that differ only by a separator", () => {
		expect(instanceSubjectToken("engine.a")).not.toBe(instanceSubjectToken("engine-a"));
	});

	it("rejects an empty instance id", () => {
		expect(() => instanceSubjectToken("   ")).toThrow(SubjectTokenError);
	});
});

describe("subjectFor.engineParkHandoffRpc", () => {
	it("addresses the owning instance, and both ends build the same subject", () => {
		expect(subjectFor.engineParkHandoffRpc("engine-2")).toBe("rpc.engine.v1.park-handoff.engine-2");
		expect(subjectFor.engineParkHandoffRpc("engine.eu-west.internal")).toBe(
			`${RPC_SUBJECTS.engineParkHandoff}.${instanceSubjectToken("engine.eu-west.internal")}`,
		);
	});

	it("is covered by the wildcard an operator would grant or subscribe with", () => {
		expect(
			matchesSubject(`${RPC_SUBJECTS.engineParkHandoff}.*`, subjectFor.engineParkHandoffRpc("e1")),
		).toBe(true);
	});
});

describe("parseSubject round trip", () => {
	it("reverses a call subject", () => {
		const subject = subjectFor.call(ORG, CALL, "channel.record.stopped");
		const parsed = parseSubjectOrThrow(subject);
		expect(parsed).toEqual({
			kind: "call",
			family: "call",
			version: "v1",
			orgId: ORG,
			callId: CALL,
			event: "channel.record.stopped",
		});
		if (parsed.kind !== "call") throw new Error("unreachable");
		expect(subjectFor.call(parsed.orgId, parsed.callId, parsed.event)).toBe(subject);
	});

	it("reverses a registration subject", () => {
		const subject = subjectFor.registration(ORG, AOR_HASH, "expired");
		const parsed = parseSubjectOrThrow(subject);
		if (parsed.kind !== "registration") throw new Error("unreachable");
		expect(parsed.aorHash).toBe(AOR_HASH);
		expect(subjectFor.registration(parsed.orgId, parsed.aorHash, parsed.event)).toBe(subject);
	});

	it("reverses a queue subject", () => {
		const subject = subjectFor.queue(ORG, QUEUE, "agent.state");
		const parsed = parseSubjectOrThrow(subject);
		if (parsed.kind !== "queue") throw new Error("unreachable");
		expect(parsed.queueId).toBe(QUEUE);
		expect(subjectFor.queue(parsed.orgId, parsed.queueId, parsed.event)).toBe(subject);
	});

	it("reverses a trunk subject, rejoining the dotted event tail", () => {
		const subject = subjectFor.trunk(ORG, TRUNK, "status.changed");
		const parsed = parseSubjectOrThrow(subject);
		if (parsed.kind !== "trunk") throw new Error("unreachable");
		expect(parsed.trunkId).toBe(TRUNK);
		expect(parsed.event).toBe("status.changed");
		expect(subjectFor.trunk(parsed.orgId, parsed.trunkId, parsed.event)).toBe(subject);
	});

	it.each([
		["cdr-leg", subjectFor.cdrLeg(ORG), subjectFor.cdrLeg],
		["audit", subjectFor.audit(ORG), subjectFor.audit],
		["provision", subjectFor.provision(ORG), subjectFor.provision],
	])("reverses the single-token %s subject", (kind, subject, rebuild) => {
		const parsed = parseSubjectOrThrow(subject);
		expect(parsed.kind).toBe(kind as never);
		if (parsed.kind === "rpc") throw new Error("unreachable");
		expect(parsed.orgId).toBe(ORG);
		expect(rebuild(parsed.orgId)).toBe(subject);
	});

	it("reverses an rpc subject", () => {
		expect(parseSubjectOrThrow(RPC_SUBJECTS.routingResolve)).toEqual({
			kind: "rpc",
			family: "rpc",
			version: "v1",
			service: "routing",
			method: "resolve",
		});
	});

	it("round-trips every call event name", () => {
		for (const event of CALL_EVENTS) {
			const parsed = parseSubjectOrThrow(subjectFor.call(ORG, CALL, event));
			if (parsed.kind !== "call") throw new Error("unreachable");
			expect(parsed.event).toBe(event);
		}
	});

	it.each([
		["a wildcard subject", "calls.evt.v1.org.call.>"],
		["a single-token wildcard", "cdr.leg.v1.*"],
		["a future major version", `calls.evt.v2.${ORG}.${CALL}.channel.created`],
		["a foreign namespace", "acme.telemetry.v1.thing"],
		["a truncated call subject", `calls.evt.v1.${ORG}.${CALL}`],
		["a too-long cdr subject", `cdr.leg.v1.${ORG}.extra`],
		["nonsense", "x"],
	])("returns undefined for %s", (_label, subject) => {
		expect(parseSubject(subject)).toBeUndefined();
	});

	it("throws UnknownSubjectError from the strict variant", () => {
		expect(() => parseSubjectOrThrow("nope.nope.nope.nope")).toThrow(UnknownSubjectError);
	});

	it("maps a subject to its event family and ignores rpc", () => {
		expect(eventFamilyForSubject(subjectFor.audit(ORG))).toBe("audit");
		expect(eventFamilyForSubject(subjectFor.call(ORG, CALL, "channel.held"))).toBe("call");
		expect(eventFamilyForSubject(RPC_SUBJECTS.authzCheck)).toBeUndefined();
	});

	it("survives a real uuid v7 org id", () => {
		const orgId = createEntityId();
		const parsed = parseSubjectOrThrow(subjectFor.audit(orgId));
		if (parsed.kind === "rpc") throw new Error("unreachable");
		expect(parsed.orgId).toBe(orgId);
	});
});

describe("subject filters", () => {
	it("builds the stream-level filters", () => {
		expect(subjectFilterFor.allCalls()).toBe("calls.evt.v1.>");
		expect(subjectFilterFor.allRegistrations()).toBe("sip.reg.v1.>");
		expect(subjectFilterFor.allQueues()).toBe("queue.evt.v1.>");
		expect(subjectFilterFor.allTrunks()).toBe("trunk.evt.v1.>");
		expect(subjectFilterFor.allCdrLegs()).toBe("cdr.leg.v1.*");
		expect(subjectFilterFor.allAudit()).toBe("audit.evt.v1.*");
		expect(subjectFilterFor.allProvision()).toBe("provision.evt.v1.*");
	});

	it("matches every subject of its own family and nothing else", () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			[subjectFilterFor.allCalls(), subjectFor.call(ORG, CALL, "channel.record.started")],
			[subjectFilterFor.allRegistrations(), subjectFor.registration(ORG, AOR_HASH, "registered")],
			[subjectFilterFor.allQueues(), subjectFor.queue(ORG, QUEUE, "caller.joined")],
			[subjectFilterFor.allTrunks(), subjectFor.trunk(ORG, TRUNK, "status.changed")],
			[subjectFilterFor.allCdrLegs(), subjectFor.cdrLeg(ORG)],
			[subjectFilterFor.allAudit(), subjectFor.audit(ORG)],
			[subjectFilterFor.allProvision(), subjectFor.provision(ORG)],
		];
		for (const [filter, subject] of cases) {
			expect(matchesSubject(filter, subject)).toBe(true);
			for (const [otherFilter] of cases) {
				if (otherFilter === filter) continue;
				expect(matchesSubject(otherFilter, subject)).toBe(false);
			}
		}
	});

	it("scopes to one org", () => {
		const mine = subjectFor.call(ORG, CALL, "channel.hangup");
		const theirs = subjectFor.call("018f2b7c-0000-7000-8000-0000000000ff", CALL, "channel.hangup");
		expect(matchesSubject(subjectFilterFor.callsInOrg(ORG), mine)).toBe(true);
		expect(matchesSubject(subjectFilterFor.callsInOrg(ORG), theirs)).toBe(false);
	});

	it("scopes to one call", () => {
		const filter = subjectFilterFor.call(ORG, CALL);
		expect(matchesSubject(filter, subjectFor.call(ORG, CALL, "channel.created"))).toBe(true);
		expect(matchesSubject(filter, subjectFor.call(ORG, QUEUE, "channel.created"))).toBe(false);
	});

	it("selects one event name across every call", () => {
		const filter = subjectFilterFor.callEventInOrg(ORG, "channel.hangup");
		expect(matchesSubject(filter, subjectFor.call(ORG, CALL, "channel.hangup"))).toBe(true);
		expect(matchesSubject(filter, subjectFor.call(ORG, CALL, "channel.held"))).toBe(false);
		// A multi-token event still lines up because the filter carries all of its tokens.
		const record = subjectFilterFor.callEventInOrg(ORG, "channel.record.started");
		expect(matchesSubject(record, subjectFor.call(ORG, CALL, "channel.record.started"))).toBe(true);
		expect(matchesSubject(record, subjectFor.call(ORG, CALL, "channel.record.stopped"))).toBe(
			false,
		);
	});

	it("selects one event name across every org", () => {
		const filter = subjectFilterFor.callEvent("channel.answered");
		expect(matchesSubject(filter, subjectFor.call(ORG, CALL, "channel.answered"))).toBe(true);
		expect(matchesSubject(filter, subjectFor.call("other-org", CALL, "channel.answered"))).toBe(
			true,
		);
	});

	it("scopes registrations to one AOR", () => {
		const filter = subjectFilterFor.registrationsForAor(ORG, AOR_HASH);
		expect(matchesSubject(filter, subjectFor.registration(ORG, AOR_HASH, "expired"))).toBe(true);
		expect(
			matchesSubject(filter, subjectFor.registration(ORG, aorSubjectToken("sip:2@x"), "expired")),
		).toBe(false);
	});

	it("scopes trunks to one org, and status transitions across its trunks", () => {
		const otherOrg = "018f2b7c-0000-7000-8000-0000000000ff";
		const mine = subjectFor.trunk(ORG, TRUNK, "status.changed");
		expect(matchesSubject(subjectFilterFor.trunksInOrg(ORG), mine)).toBe(true);
		expect(
			matchesSubject(
				subjectFilterFor.trunksInOrg(ORG),
				subjectFor.trunk(otherOrg, TRUNK, "status.changed"),
			),
		).toBe(false);
		// The dotted-tail arithmetic the filter's own comment describes: the event is TWO tokens,
		// so the trunk wildcard is a `*` followed by the literal tail, never a `>`.
		expect(subjectFilterFor.trunkStatusInOrg(ORG)).toBe(`trunk.evt.v1.${ORG}.*.status.changed`);
		expect(matchesSubject(subjectFilterFor.trunkStatusInOrg(ORG), mine)).toBe(true);
		expect(
			matchesSubject(subjectFilterFor.trunkStatusInOrg(ORG), `trunk.evt.v1.${ORG}.${TRUNK}.other`),
		).toBe(false);
	});

	it("scopes single-token families to one org", () => {
		expect(subjectFilterFor.cdrLegsInOrg(ORG)).toBe(subjectFor.cdrLeg(ORG));
		expect(subjectFilterFor.auditInOrg(ORG)).toBe(subjectFor.audit(ORG));
		expect(subjectFilterFor.provisionInOrg(ORG)).toBe(subjectFor.provision(ORG));
	});
});

describe("matchesSubject", () => {
	it.each([
		["a.b.c", "a.b.c", true],
		["a.*.c", "a.b.c", true],
		["a.*.c", "a.b.d", false],
		["a.*", "a.b.c", false],
		["a.>", "a.b.c", true],
		["a.>", "a.b", true],
		["a.>", "a", false],
		[">", "a", true],
		["a.b.c", "a.b", false],
		["a.b", "a.b.c", false],
		["*.b", "a.b", true],
	])("filter %p vs subject %p is %p", (filter, subject, expected) => {
		expect(matchesSubject(filter, subject)).toBe(expected);
	});
});

describe("event-name guards", () => {
	it("recognises the known vocabularies", () => {
		expect(CALL_EVENTS.every(isCallEvent)).toBe(true);
		expect(REGISTRATION_EVENTS.every(isRegistrationEvent)).toBe(true);
		expect(QUEUE_EVENTS.every(isQueueEvent)).toBe(true);
		expect(TRUNK_EVENTS.every(isTrunkEvent)).toBe(true);
		expect(isCallEvent("channel.teleported")).toBe(false);
		expect(isTrunkEvent("status.qualified")).toBe(false);
	});

	it("accepts hierarchical event names but not malformed ones", () => {
		expect(isEventName("channel.record.started")).toBe(true);
		expect(isEventName("registered")).toBe(true);
		expect(isEventName("channel.")).toBe(false);
		expect(isEventName("")).toBe(false);
	});

	it("pins the call vocabulary from plan §4.2", () => {
		expect([...CALL_EVENTS]).toEqual([
			"channel.created",
			"channel.ringing",
			"channel.early-media",
			"channel.answered",
			"channel.bridged",
			"channel.unbridged",
			"channel.held",
			"channel.unheld",
			"channel.dtmf",
			"channel.record.started",
			"channel.record.stopped",
			"channel.hangup",
			"channel.destroyed",
			// Additive, and therefore NOT a `v1` → `v2` subject bump: an existing consumer filters on
			// the event tokens it knows, and a JetStream consumer that does not name these never
			// sees them. See README's evolution rules.
			"conference.joined",
			"conference.left",
			"call.parked",
			"call.unparked",
			"call.transferred",
			"call.picked-up",
			"call.emergency.dialed",
			"call.tap.started",
			"call.tap.ended",
			"call.paging.started",
			"call.paging.ended",
		]);
	});
});
