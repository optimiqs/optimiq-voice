import { describe, expect, it } from "bun:test";
import { snapshotHash } from "./cache";
import { canonicalJson } from "./canonical-json";
import { compileRoutingArtifact } from "./compile";
import {
	A_PIN_HASH,
	aConference,
	anExtension,
	aMohClass,
	aParkLot,
	aQueue,
	aRingGroup,
	aRingGroupMember,
	aSnapshot,
	aVoicemailBox,
	aVoicemailGreeting,
	codesOf,
	compileAttempt,
	compiled,
	COMPILED_AT,
	ORG_ID,
} from "./fixtures";
import { emptySnapshot } from "./snapshot";
import type {
	ConferencePlanNode,
	ExtensionPlanNode,
	ParkPlanNode,
	QueuePlanNode,
	RingGroupPlanNode,
	VoicemailPlanNode,
} from "./plan";

/**
 * The two compile-time embeddings the engine cannot do without.
 *
 * Both exist for the same reason: the engine holds no database handle, so a fact it needs at the
 * moment a call arrives either travels in the artifact or does not exist. A `moh_class` row id is
 * useless to a media server that addresses classes by name, and a mailbox greeting that lives in
 * `voicemail_greeting` is a row nobody on the call path can read.
 *
 * These specs pin the resolution, the dangling-reference behaviour and — the part that is easy to
 * lose — the determinism of both, because a compiler that embedded these in map-iteration order
 * would produce a different artifact every time and thrash the cache on every recompile.
 */

const QUEUE_NODE = "queue:q-1";
const LEAVE_NODE = "voicemail:vm-1:leave";
const CHECK_NODE = "voicemail:vm-1:check";

function queueOf(snapshot: Parameters<typeof compiled>[0]): QueuePlanNode {
	return compiled(snapshot).nodes[QUEUE_NODE] as QueuePlanNode;
}

function leaveOf(snapshot: Parameters<typeof compiled>[0]): VoicemailPlanNode {
	return compiled(snapshot).nodes[LEAVE_NODE] as VoicemailPlanNode;
}

// -------------------------------------------------------------------------------------------
// Music on hold
// -------------------------------------------------------------------------------------------

describe("compile — music-on-hold class names", () => {
	it("resolves a queue's class id to the name the media server wants", () => {
		const node = queueOf(
			aSnapshot({
				queues: [aQueue({ mohClassId: "moh-1" })],
				mohClasses: [aMohClass({ id: "moh-1", name: "jazz" })],
			}),
		);
		expect(node.mohClass).toBe("jazz");
	});

	it("keeps the row id alongside the name, so an inspector can still link back", () => {
		const node = queueOf(
			aSnapshot({
				queues: [aQueue({ mohClassId: "moh-1" })],
				mohClasses: [aMohClass({ id: "moh-1", name: "jazz" })],
			}),
		);
		expect(node.mohClassId).toBe("moh-1");
	});

	it("resolves the name on every node kind that can hold a caller", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension({ mohClassId: "moh-1" })],
				ringGroups: [aRingGroup({ mohClassId: "moh-1" })],
				ringGroupDestinations: [aRingGroupMember()],
				queues: [aQueue({ mohClassId: "moh-1" })],
				conferences: [aConference({ mohClassId: "moh-1" })],
				parkLots: [aParkLot({ mohClassId: "moh-1" })],
				mohClasses: [aMohClass({ id: "moh-1", name: "jazz" })],
			}),
		);
		expect((artifact.nodes["extension:ext-1"] as ExtensionPlanNode).mohClass).toBe("jazz");
		expect((artifact.nodes["ring-group:rg-1"] as RingGroupPlanNode).mohClass).toBe("jazz");
		expect((artifact.nodes[QUEUE_NODE] as QueuePlanNode).mohClass).toBe("jazz");
		expect((artifact.nodes["conference:conf-1"] as ConferencePlanNode).mohClass).toBe("jazz");
		expect((artifact.nodes["park:park-1"] as ParkPlanNode).mohClass).toBe("jazz");
	});

	it("warns about a dangling class and leaves the name off", () => {
		const result = compileAttempt(
			aSnapshot({ queues: [aQueue({ mohClassId: "gone" })], mohClasses: [aMohClass()] }),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("dangling-moh-class");
		const node = (result.ok ? result.artifact.nodes[QUEUE_NODE] : undefined) as QueuePlanNode;
		expect(node.mohClassId).toBe("gone");
		expect(node.mohClass).toBeUndefined();
	});

	it("does not block a save on a dangling class — hold music is decoration", () => {
		const result = compileAttempt(
			aSnapshot({ queues: [aQueue({ mohClassId: "gone" })], mohClasses: [] }),
		);
		expect(result.ok).toBe(true);
	});

	it("warns about a disabled class and falls back to the media server's default", () => {
		const result = compileAttempt(
			aSnapshot({
				queues: [aQueue({ mohClassId: "moh-1" })],
				mohClasses: [aMohClass({ id: "moh-1", enabled: false })],
			}),
		);
		expect(codesOf(result)).toContain("dangling-moh-class");
		const node = (result.ok ? result.artifact.nodes[QUEUE_NODE] : undefined) as QueuePlanNode;
		expect(node.mohClass).toBeUndefined();
	});

	it("names the class in the disabled warning, so the operator knows which one", () => {
		const result = compileAttempt(
			aSnapshot({
				queues: [aQueue({ mohClassId: "moh-1" })],
				mohClasses: [aMohClass({ id: "moh-1", name: "jazz", enabled: false })],
			}),
		);
		expect(
			result.diagnostics.find((entry) => entry.code === "dangling-moh-class")?.message,
		).toContain("jazz");
	});

	it("stays silent when the loader supplies no classes at all", () => {
		// A loader that has not learned to load `moh_class` yet is a rollout state, not a tenant with
		// four broken references. Reporting one warning per MOH id would bury the real diagnostics.
		const snapshot = { ...aSnapshot({ queues: [aQueue({ mohClassId: "moh-1" })] }) };
		delete (snapshot as { mohClasses?: unknown }).mohClasses;
		const result = compileAttempt(snapshot);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).not.toContain("dangling-moh-class");
		expect(
			((result.ok ? result.artifact.nodes[QUEUE_NODE] : undefined) as QueuePlanNode).mohClass,
		).toBeUndefined();
	});

	it("leaves both fields off when nothing names a class", () => {
		const node = queueOf(aSnapshot({ queues: [aQueue()], mohClasses: [aMohClass()] }));
		expect(node.mohClassId).toBeUndefined();
		expect(node.mohClass).toBeUndefined();
	});
});

// -------------------------------------------------------------------------------------------
// Voicemail greetings
// -------------------------------------------------------------------------------------------

describe("compile — voicemail greetings", () => {
	it("embeds the active greeting as an object media ref", () => {
		const node = leaveOf(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox()],
				voicemailGreetings: [aVoicemailGreeting({ objectKey: "org/vm-1/hello.wav" })],
			}),
		);
		expect(node.greetingMedia).toBe("object://org/vm-1/hello.wav");
		expect(node.greetingKind).toBe("unavailable");
	});

	it("strips a leading slash, so one loader's key style does not change the artifact", () => {
		const node = leaveOf(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox()],
				voicemailGreetings: [aVoicemailGreeting({ objectKey: "/org/vm-1/hello.wav" })],
			}),
		);
		expect(node.greetingMedia).toBe("object://org/vm-1/hello.wav");
	});

	it("prefers a temporary greeting over the standing one", () => {
		const node = leaveOf(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox()],
				voicemailGreetings: [
					aVoicemailGreeting({ id: "vmg-1", kind: "unavailable", objectKey: "standing.wav" }),
					aVoicemailGreeting({ id: "vmg-2", kind: "temporary", objectKey: "holiday.wav" }),
				],
			}),
		);
		expect(node.greetingMedia).toBe("object://holiday.wav");
		expect(node.greetingKind).toBe("temporary");
	});

	it("ignores an inactive greeting", () => {
		const node = leaveOf(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox()],
				voicemailGreetings: [
					aVoicemailGreeting({ id: "vmg-1", kind: "unavailable", objectKey: "standing.wav" }),
					aVoicemailGreeting({
						id: "vmg-2",
						kind: "temporary",
						objectKey: "holiday.wav",
						active: false,
					}),
				],
			}),
		);
		expect(node.greetingMedia).toBe("object://standing.wav");
	});

	it("never uses the directory-name recording as a call greeting", () => {
		const node = leaveOf(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox()],
				voicemailGreetings: [aVoicemailGreeting({ kind: "name", objectKey: "who.wav" })],
			}),
		);
		expect(node.greetingMedia).toBeUndefined();
	});

	it("leaves the greeting off a check node — a mailbox owner does not hear their own greeting", () => {
		const artifact = compiled(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox()],
				voicemailGreetings: [aVoicemailGreeting()],
			}),
		);
		expect((artifact.nodes[CHECK_NODE] as VoicemailPlanNode).greetingMedia).toBeUndefined();
	});

	it("says nothing about a box with no greeting — that is the normal state", () => {
		const result = compileAttempt(
			aSnapshot({ voicemailBoxes: [aVoicemailBox()], voicemailGreetings: [] }),
		);
		expect(codesOf(result)).not.toContain("dangling-voicemail-greeting");
		const node = (result.ok ? result.artifact.nodes[LEAVE_NODE] : undefined) as VoicemailPlanNode;
		expect(node.greetingMedia).toBeUndefined();
	});

	it("warns about a greeting whose mailbox is not in the snapshot", () => {
		const result = compileAttempt(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox()],
				voicemailGreetings: [aVoicemailGreeting({ id: "vmg-9", voicemailBoxId: "gone" })],
			}),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("dangling-voicemail-greeting");
	});

	it("ignores a greeting whose object key is blank rather than playing nothing at a caller", () => {
		const node = leaveOf(
			aSnapshot({
				voicemailBoxes: [aVoicemailBox()],
				voicemailGreetings: [aVoicemailGreeting({ objectKey: "  " })],
			}),
		);
		expect(node.greetingMedia).toBeUndefined();
	});

	it("picks the same greeting whatever order two active rows arrive in", () => {
		const rows = [
			aVoicemailGreeting({ id: "vmg-a", kind: "unavailable", objectKey: "a.wav" }),
			aVoicemailGreeting({ id: "vmg-b", kind: "unavailable", objectKey: "b.wav" }),
		];
		const forwards = leaveOf(
			aSnapshot({ voicemailBoxes: [aVoicemailBox()], voicemailGreetings: rows }),
		);
		const backwards = leaveOf(
			aSnapshot({ voicemailBoxes: [aVoicemailBox()], voicemailGreetings: [...rows].reverse() }),
		);
		expect(forwards.greetingMedia).toBe(backwards.greetingMedia);
	});
});

// -------------------------------------------------------------------------------------------
// Voicemail PIN
// -------------------------------------------------------------------------------------------

describe("compile — voicemail PIN digests", () => {
	it("embeds a well-formed digest on both modes", () => {
		const artifact = compiled(
			aSnapshot({ voicemailBoxes: [aVoicemailBox({ pinHash: A_PIN_HASH })] }),
		);
		expect((artifact.nodes[CHECK_NODE] as VoicemailPlanNode).pinHash).toBe(A_PIN_HASH);
		expect((artifact.nodes[LEAVE_NODE] as VoicemailPlanNode).pinHash).toBe(A_PIN_HASH);
	});

	it("leaves the field off when the box has no PIN", () => {
		const artifact = compiled(aSnapshot({ voicemailBoxes: [aVoicemailBox()] }));
		expect((artifact.nodes[CHECK_NODE] as VoicemailPlanNode).pinHash).toBeUndefined();
	});

	it("treats an empty digest as no PIN rather than as an unusable one", () => {
		const result = compileAttempt(
			aSnapshot({ voicemailBoxes: [aVoicemailBox({ pinHash: "  " })] }),
		);
		expect(codesOf(result)).not.toContain("invalid-pin-hash");
	});

	it("warns about a malformed digest and does NOT embed it", () => {
		const result = compileAttempt(
			aSnapshot({ voicemailBoxes: [aVoicemailBox({ pinHash: "1234" })] }),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("invalid-pin-hash");
		const node = (result.ok ? result.artifact.nodes[CHECK_NODE] : undefined) as VoicemailPlanNode;
		expect(node.pinHash).toBeUndefined();
	});

	it("says in the warning that the PIN is not being enforced", () => {
		const result = compileAttempt(
			aSnapshot({ voicemailBoxes: [aVoicemailBox({ pinHash: "$2b$12$notscrypt" })] }),
		);
		const warning = result.diagnostics.find((entry) => entry.code === "invalid-pin-hash");
		expect(warning?.severity).toBe("warning");
		expect(warning?.message).toContain("NOT enforced");
	});

	it("never fails a compile over one bad digest", () => {
		// Refusing to compile would take the tenant's whole call routing down over one mailbox.
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				voicemailBoxes: [aVoicemailBox({ pinHash: "nonsense" })],
			}),
		);
		expect(result.ok).toBe(true);
	});
});

// -------------------------------------------------------------------------------------------
// Determinism and versioning
// -------------------------------------------------------------------------------------------

describe("compile — the embeddings are deterministic", () => {
	const snapshot = aSnapshot({
		extensions: [anExtension({ mohClassId: "moh-2" })],
		queues: [aQueue({ mohClassId: "moh-1" })],
		voicemailBoxes: [aVoicemailBox({ pinHash: A_PIN_HASH })],
		voicemailGreetings: [
			aVoicemailGreeting({ id: "vmg-2", kind: "temporary", objectKey: "b.wav" }),
			aVoicemailGreeting({ id: "vmg-1", kind: "unavailable", objectKey: "a.wav" }),
		],
		mohClasses: [
			aMohClass({ id: "moh-2", name: "classical" }),
			aMohClass({ id: "moh-1", name: "jazz" }),
		],
	});

	it("compiles to a byte-identical artifact twice", () => {
		expect(canonicalJson(compiled(snapshot))).toBe(canonicalJson(compiled(snapshot)));
	});

	it("does not depend on the order the new collections arrive in", () => {
		const reversed = {
			...snapshot,
			voicemailGreetings: [...(snapshot.voicemailGreetings ?? [])].reverse(),
			mohClasses: [...(snapshot.mohClasses ?? [])].reverse(),
		};
		expect(canonicalJson(compiled(reversed))).toBe(canonicalJson(compiled(snapshot)));
	});

	it("keeps the artifact version — an optional field an old reader ignores is not a break", () => {
		// The versioning rule is "bump when a reader compiled against the previous version could
		// MISinterpret the artifact". An older engine that has never heard of `mohClass` reads past
		// it and falls back to the media server's default, which is what it did before. What forces
		// the recompile instead is the snapshot hash, which moves the moment the input gains a field.
		expect(compiled(snapshot).artifactVersion).toBe(
			compiled(emptySnapshot(ORG_ID)).artifactVersion,
		);
	});

	it("hashes an absent optional collection exactly as an empty one", () => {
		const withEmpty = aSnapshot({ queues: [aQueue()] });
		const withAbsent = { ...withEmpty };
		delete (withAbsent as { mohClasses?: unknown }).mohClasses;
		delete (withAbsent as { voicemailGreetings?: unknown }).voicemailGreetings;
		expect(snapshotHash(withAbsent)).toBe(snapshotHash(withEmpty));
	});

	it("moves the snapshot hash when a greeting changes", () => {
		const before = aSnapshot({
			voicemailBoxes: [aVoicemailBox()],
			voicemailGreetings: [aVoicemailGreeting({ objectKey: "a.wav" })],
		});
		const after = aSnapshot({
			voicemailBoxes: [aVoicemailBox()],
			voicemailGreetings: [aVoicemailGreeting({ objectKey: "b.wav" })],
		});
		expect(snapshotHash(before)).not.toBe(snapshotHash(after));
	});

	it("moves the snapshot hash when a class is renamed", () => {
		const before = aSnapshot({ mohClasses: [aMohClass({ name: "jazz" })] });
		const after = aSnapshot({ mohClasses: [aMohClass({ name: "classical" })] });
		expect(snapshotHash(before)).not.toBe(snapshotHash(after));
	});

	it("compiles a snapshot that omits both optional collections", () => {
		const snapshotWithout = { ...aSnapshot({ queues: [aQueue()] }) };
		delete (snapshotWithout as { mohClasses?: unknown }).mohClasses;
		delete (snapshotWithout as { voicemailGreetings?: unknown }).voicemailGreetings;
		expect(() =>
			compileRoutingArtifact(snapshotWithout, { compiledAt: COMPILED_AT }),
		).not.toThrow();
	});
});
