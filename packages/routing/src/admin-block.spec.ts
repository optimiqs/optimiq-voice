import { describe, expect, it } from "bun:test";
import {
	anAlias,
	anExtension,
	anOutboundRoute,
	aCallFlow,
	aDirectory,
	aPhoneNumber,
	aPhraseStep,
	aPinEntry,
	aPinSet,
	aPrompt,
	aSnapshot,
	aSpeedDial,
	aStream,
	aTimeCondition,
	aTimeRule,
	aTranslationRule,
	aTranslationRuleset,
	aTrunk,
	aVoicemailBox,
	aVoicemailGreeting,
	at,
	codesOf,
	compileAttempt,
	compiled,
	A_PIN_HASH,
} from "./fixtures";
import { resolveInbound, resolveInternal, resolveOutbound } from "./resolve";
import type {
	CallFlowPlanNode,
	DialByNamePlanNode,
	StreamPlanNode,
	TrunkDialPlanNode,
} from "./plan";

/**
 * The T2 admin block, compiled and resolved.
 *
 * One file rather than nine, because the features share a shape: each is an entity the compiler has
 * to turn into something the engine can walk without a database, and what is worth asserting about
 * each is the ONE decision that a later change could quietly reverse. The mechanics they share with
 * every other entity — that a dangling ref is an error, that a disabled row releases the call — are
 * `compile.spec.ts`'s subject and are not re-tested nine more times here.
 */

const NOON = at("2026-08-12T12:00:00.000Z");

// -----------------------------------------------------------------------------------------------
// Call flows
// -----------------------------------------------------------------------------------------------

describe("call flows", () => {
	function flowSnapshot(mode: "day" | "night") {
		return aSnapshot({
			extensions: [anExtension()],
			voicemailBoxes: [aVoicemailBox()],
			callFlows: [
				aCallFlow({
					mode,
					destinationType: "extension",
					destinationRef: "ext-1",
					nightDestinationType: "voicemail",
					nightDestinationRef: "vm-1",
				}),
			],
			phoneNumbers: [aPhoneNumber({ destinationType: "call-flow", destinationRef: "cf-1" })],
		});
	}

	/**
	 * THE decision this feature turns on. Compiling only the live branch would be smaller and would
	 * make flipping the switch a jump to a node that is not in the table — and would leave a
	 * call-flow inspector unable to show a tenant where the other position goes.
	 */
	it("compiles BOTH branches whatever the mode says", () => {
		const artifact = compiled(flowSnapshot("day"));
		const node = artifact.nodes["call-flow:cf-1"] as CallFlowPlanNode;
		expect(node.kind).toBe("call-flow");
		expect(node.mode).toBe("day");
		expect(node.dayNodeId).toBe("extension:ext-1");
		expect(node.nightNodeId).toBe("voicemail:vm-1:leave");
		// The inactive branch is in the table, not merely referenced.
		expect(artifact.nodes["voicemail:vm-1:leave"]).toBeDefined();
	});

	it("takes the branch the stored mode names, and says which in the walk's notes", () => {
		for (const [mode, node] of [
			["day", "extension:ext-1"],
			["night", "voicemail:vm-1:leave"],
		] as const) {
			const artifact = compiled(flowSnapshot(mode));
			const route = resolveInbound(artifact, { did: "+15551230001", now: NOON });
			expect(route.plan?.entryNodeId, mode).toBe(node);
			expect(
				route.diagnostics.some((entry) => entry.message.includes(`in ${mode} mode`)),
				mode,
			).toBe(true);
		}
	});

	/** The BLF key is provisioned with the code, so the presence key follows the code. */
	it("carries the toggle code as the presence key a lamp watches", () => {
		const artifact = compiled(flowSnapshot("day"));
		const node = artifact.nodes["call-flow:cf-1"] as CallFlowPlanNode;
		expect(node.featureCode).toBe("*281");
		expect(node.presenceKey).toBe("*281");
	});

	it("falls back to the dialable number when the flow has no code", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				callFlows: [
					aCallFlow({
						featureCode: null,
						extensionNumber: "500",
						nightDestinationType: "hangup",
					}),
				],
			}),
		);
		expect((artifact.nodes["call-flow:cf-1"] as CallFlowPlanNode).presenceKey).toBe("500");
	});

	it("claims its dialable number, so a flow and an extension cannot share one", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension({ number: "500" })],
				callFlows: [
					aCallFlow({ extensionNumber: "500", featureCode: null, nightDestinationType: "hangup" }),
				],
			}),
		);
		expect(codesOf(result)).toContain("duplicate-internal-number");
	});

	/**
	 * A toggle code is not a `feature_code` row, which is the cost of making it instance-specific.
	 * Two mechanisms answering the same digits has no runtime symptom beyond the wrong one winning,
	 * so it is an error rather than a warning.
	 */
	it("refuses a toggle code a feature code would swallow", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				featureCodes: [
					{ id: "fc-1", enabled: true, code: "*28", action: "intercom", label: "Intercom" },
				],
				callFlows: [aCallFlow({ featureCode: "*281", nightDestinationType: "hangup" })],
			}),
		);
		expect(codesOf(result)).toContain("conflicting-feature-code");
	});
});

// -----------------------------------------------------------------------------------------------
// Time-condition manual override
// -----------------------------------------------------------------------------------------------

describe("time condition manual override", () => {
	function conditionSnapshot(override: "auto" | "forced-match" | "forced-no-match") {
		return aSnapshot({
			extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
			timeConditions: [
				aTimeCondition({
					override,
					timezone: "UTC",
					destinationType: "extension",
					destinationRef: "ext-1",
					nomatchDestinationType: "extension",
					nomatchDestinationRef: "ext-2",
				}),
			],
			// Matches only in the morning, so noon takes the no-match branch under `auto`.
			timeConditionRules: [
				aTimeRule({ predicates: [{ timeOfDay: { from: "08:00", to: "11:00" } }] }),
			],
			phoneNumbers: [aPhoneNumber({ destinationType: "time-condition", destinationRef: "tc-1" })],
		});
	}

	it("obeys the clock when the override is auto", () => {
		const route = resolveInbound(compiled(conditionSnapshot("auto")), {
			did: "+15551230001",
			now: NOON,
		});
		expect(route.plan?.entryNodeId).toBe("extension:ext-2");
	});

	/** The whole feature: the office closed early, and no amount of "Tuesday 08:00–11:00" may argue. */
	it("takes the match branch under forced-match even outside every rule", () => {
		const route = resolveInbound(compiled(conditionSnapshot("forced-match")), {
			did: "+15551230001",
			now: NOON,
		});
		expect(route.plan?.entryNodeId).toBe("extension:ext-1");
	});

	it("takes the no-match branch under forced-no-match even inside a rule", () => {
		const route = resolveInbound(compiled(conditionSnapshot("forced-no-match")), {
			did: "+15551230001",
			now: at("2026-08-12T09:00:00.000Z"),
		});
		expect(route.plan?.entryNodeId).toBe("extension:ext-2");
	});

	/**
	 * "Closed at 14:32 on a Tuesday" is a confusing thing to read in a support ticket unless the next
	 * clause says somebody pressed a key.
	 */
	it("says in the walk's notes that the rules were not read", () => {
		const route = resolveInbound(compiled(conditionSnapshot("forced-no-match")), {
			did: "+15551230001",
			now: NOON,
		});
		expect(route.diagnostics.some((entry) => entry.message.includes("manually overridden"))).toBe(
			true,
		);
	});

	/** An overridden condition never reads its rules, so an empty rule list is not the usual trap. */
	it("does not warn about an empty rule list when the condition is overridden", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				timeConditions: [
					aTimeCondition({
						override: "forced-match",
						destinationType: "extension",
						destinationRef: "ext-1",
					}),
				],
			}),
		);
		expect(codesOf(result)).not.toContain("empty-time-condition");
	});

	/**
	 * `auto` is dropped from the compiled form rather than carried, which is what keeps this wave
	 * from moving the `snapshotHash` of every tenant that is not using the feature.
	 */
	it("carries no override field at all when the condition is on auto", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				timeConditions: [aTimeCondition({ destinationType: "extension", destinationRef: "ext-1" })],
				timeConditionRules: [aTimeRule()],
			}),
		);
		expect(Object.hasOwn(artifact.timeConditions["tc-1"] ?? {}, "override")).toBe(false);
	});
});

// -----------------------------------------------------------------------------------------------
// PIN numbers
// -----------------------------------------------------------------------------------------------

describe("outbound PIN sets", () => {
	function pinSnapshot(overrides: Record<string, unknown> = {}) {
		return aSnapshot({
			extensions: [anExtension({ tollClass: "international" })],
			trunks: [aTrunk()],
			outboundRoutes: [anOutboundRoute({ pinSetId: "pin-1" })],
			pinSets: [aPinSet()],
			pinSetEntries: [aPinEntry()],
			...overrides,
		});
	}

	it("compiles the gate onto the trunk-dial node the engine walks", () => {
		const artifact = compiled(pinSnapshot());
		const node = artifact.nodes["trunk-dial:out-1"] as TrunkDialPlanNode;
		expect(node.pinSet?.pinSetId).toBe("pin-1");
		expect(node.pinSet?.maxAttempts).toBe(3);
		expect(node.pinSet?.entries).toHaveLength(1);
	});

	/** What the CDR names — never the digits. That is all upstream's plaintext column was needed for. */
	it("carries an ordinal and a label per code, and the digest, and nothing else", () => {
		const entry = (compiled(pinSnapshot()).nodes["trunk-dial:out-1"] as TrunkDialPlanNode).pinSet
			?.entries[0];
		expect(entry).toEqual({
			pinSetEntryId: "pin-entry-1",
			ordinal: 1,
			label: "Night desk",
			pinHash: A_PIN_HASH,
		});
	});

	/**
	 * Fails OPEN with a warning, like the mailbox PIN and for the same reason: refusing every call on
	 * a route because a digest format changed takes the tenant's phones down to protect a gate they
	 * can re-create in a form.
	 */
	it("warns and leaves the route ungated when every digest is unreadable", () => {
		const result = compileAttempt(
			pinSnapshot({ pinSetEntries: [aPinEntry({ pinHash: "not-a-digest" })] }),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("unusable-pin-set");
		const artifact = result.ok ? result.artifact : undefined;
		expect((artifact?.nodes["trunk-dial:out-1"] as TrunkDialPlanNode | undefined)?.pinSet).toBe(
			undefined,
		);
	});

	it("warns and leaves the route ungated when the set is disabled", () => {
		const result = compileAttempt(pinSnapshot({ pinSets: [aPinSet({ enabled: false })] }));
		expect(codesOf(result)).toContain("unusable-pin-set");
	});

	/**
	 * The dangling case, which became reachable the moment `pinSetId` gained a write DTO: the
	 * snapshot is tenant-scoped, so a set belonging to another organization and a set that was
	 * deleted are the same fact here — an id that is not in this snapshot. It fails OPEN like the
	 * other two, and the warning is what tells the admin the gate they think they configured is not
	 * there. An error would be worse: it would take every unrelated route in the tenant down.
	 */
	it("warns and leaves the route ungated when the set is not in this snapshot", () => {
		const result = compileAttempt(
			pinSnapshot({ outboundRoutes: [anOutboundRoute({ pinSetId: "pin-from-another-tenant" })] }),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("unusable-pin-set");
		const artifact = result.ok ? result.artifact : undefined;
		expect((artifact?.nodes["trunk-dial:out-1"] as TrunkDialPlanNode | undefined)?.pinSet).toBe(
			undefined,
		);
	});

	/**
	 * Kari's Law: `911` is dialable from any station with no prefix and no permission, and an
	 * authorisation code is a permission. The emergency node is built from no route at all, so this
	 * falls out — which is exactly why it is worth pinning.
	 */
	it("never gates the emergency node", () => {
		const artifact = compiled(pinSnapshot());
		const emergency = artifact.nodes["trunk-dial:emergency"] as TrunkDialPlanNode | undefined;
		expect(emergency?.emergency).toBe(true);
		expect(emergency?.pinSet).toBe(undefined);
	});
});

// -----------------------------------------------------------------------------------------------
// Number translations
// -----------------------------------------------------------------------------------------------

describe("number translation rulesets", () => {
	it("applies the ruleset AFTER the route's own strip and prepend", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension({ tollClass: "international" })],
				trunks: [aTrunk()],
				outboundRoutes: [
					anOutboundRoute({
						matchKind: "prefix",
						dialPatterns: ["9"],
						stripDigits: 1,
						translationRulesetId: "tr-1",
					}),
				],
				translationRulesets: [aTranslationRuleset()],
				translationRules: [aTranslationRule()],
			}),
		);
		// The user dialed `9` for an outside line, then `0044…`. Strip removes the 9; the ruleset then
		// sees the real number and normalises it. A ruleset running first would have to know about the
		// 9, which is exactly the coupling the shared layer removes.
		const route = resolveOutbound(artifact, {
			from: "1001",
			dialed: "90044201234567",
			now: NOON,
		});
		expect(route.dialedNumber).toBe("+44201234567");
		expect(route.diagnostics.some((entry) => entry.code === "number-translated")).toBe(true);
	});

	it("normalises the inbound caller id of the trunk the call arrived on", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				trunks: [aTrunk({ inboundTranslationRulesetId: "tr-1" })],
				translationRulesets: [aTranslationRuleset()],
				translationRules: [aTranslationRule()],
				phoneNumbers: [aPhoneNumber({ destinationType: "extension", destinationRef: "ext-1" })],
			}),
		);
		const route = resolveInbound(artifact, {
			did: "+15551230001",
			callerNumber: "0044201234567",
			trunkId: "trunk-1",
			now: NOON,
		});
		expect(route.callerIdNumber).toBe("+44201234567");
	});

	/** A caller that has not learned to pass the trunk is a rollout state, not a bug. */
	it("leaves the caller id alone when the resolver was not told the trunk", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				trunks: [aTrunk({ inboundTranslationRulesetId: "tr-1" })],
				translationRulesets: [aTranslationRuleset()],
				translationRules: [aTranslationRule()],
				phoneNumbers: [aPhoneNumber({ destinationType: "extension", destinationRef: "ext-1" })],
			}),
		);
		const route = resolveInbound(artifact, {
			did: "+15551230001",
			callerNumber: "0044201234567",
			now: NOON,
		});
		expect(route.callerIdNumber).toBe("0044201234567");
	});

	it("refuses a rule whose replacement could emit SIP syntax", () => {
		const result = compileAttempt(
			aSnapshot({
				translationRulesets: [aTranslationRuleset()],
				translationRules: [aTranslationRule({ replacement: "$1@evil.example" })],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("invalid-translation-rule");
	});

	/** Cosmetics on the wire, not a routing failure: the call still completes, as dialed. */
	it("warns rather than failing when a route names a ruleset that is gone", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension({ tollClass: "international" })],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute({ translationRulesetId: "missing" })],
				translationRulesets: [aTranslationRuleset()],
			}),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("dangling-translation-ruleset");
	});
});

// -----------------------------------------------------------------------------------------------
// Destination aliases
// -----------------------------------------------------------------------------------------------

describe("destination aliases", () => {
	/**
	 * FLAT, which is the whole design: the artifact and the inspector show the real destination, and
	 * the engine gains no node kind. A reader looking for an `alias` node needs to be told there is
	 * not one.
	 */
	it("expands to the target's node and emits no node of its own", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				destinationAliases: [anAlias()],
				phoneNumbers: [aPhoneNumber({ destinationType: "alias", destinationRef: "alias-1" })],
			}),
		);
		expect(Object.keys(artifact.nodes).some((id) => id.startsWith("alias:"))).toBe(false);
		expect(artifact.inbound.didDefaults["+15551230001"]?.destinationNodeId).toBe("extension:ext-1");
	});

	it("expands a chain of aliases", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				destinationAliases: [
					anAlias({
						id: "alias-1",
						name: "Front",
						destinationType: "alias",
						destinationRef: "alias-2",
					}),
					anAlias({ id: "alias-2", name: "Reception" }),
				],
				phoneNumbers: [aPhoneNumber({ destinationType: "alias", destinationRef: "alias-1" })],
			}),
		);
		expect(artifact.inbound.didDefaults["+15551230001"]?.destinationNodeId).toBe("extension:ext-1");
	});

	/** Flatness has exactly one cost, and this is it. An error, because there is no sound artifact. */
	it("refuses a loop rather than expanding forever", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				destinationAliases: [
					anAlias({
						id: "alias-1",
						name: "A",
						destinationType: "alias",
						destinationRef: "alias-2",
					}),
					anAlias({
						id: "alias-2",
						name: "B",
						destinationType: "alias",
						destinationRef: "alias-1",
					}),
				],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("alias-cycle");
	});
});

// -----------------------------------------------------------------------------------------------
// Streams
// -----------------------------------------------------------------------------------------------

describe("audio streams", () => {
	it("compiles a stream node carrying the URL and its fallback", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				audioStreams: [
					aStream({ fallbackDestinationType: "extension", fallbackDestinationRef: "ext-1" }),
				],
			}),
		);
		const node = artifact.nodes["stream:stream-1"] as StreamPlanNode;
		expect(node.kind).toBe("stream");
		expect(node.url).toBe("https://media.example.com/radio.mp3");
		expect(node.fallbackNodeId).toBe("extension:ext-1");
	});

	/**
	 * The set of things a tenant may cause the media server to open is a security decision. The DTO
	 * checks it too; the compiler re-checks because the snapshot is data rather than a database.
	 */
	it("refuses a URL that is not http or https", () => {
		for (const url of ["file:///etc/passwd", "sofia/gateway/x/1", "media.example.com/radio.mp3"]) {
			const result = compileAttempt(aSnapshot({ audioStreams: [aStream({ url })] }));
			expect(result.ok, url).toBe(false);
			expect(codesOf(result), url).toContain("invalid-stream-url");
		}
	});
});

// -----------------------------------------------------------------------------------------------
// Phrases
// -----------------------------------------------------------------------------------------------

describe("phrases", () => {
	it("compiles an ordered sequence keyed by the phrase's own prompt id", () => {
		const artifact = compiled(
			aSnapshot({
				prompts: [
					aPrompt({ id: "phrase-1", name: "Position", kind: "phrase" }),
					aPrompt({ id: "prompt-1", name: "Your call is number" }),
					aPrompt({ id: "prompt-2", name: "seven" }),
				],
				phraseSteps: [
					aPhraseStep({ id: "step-1", promptId: "prompt-1", ordinal: 1 }),
					aPhraseStep({ id: "step-2", promptId: "prompt-2", ordinal: 2 }),
				],
			}),
		);
		expect(artifact.phrases?.["phrase-1"]?.steps).toEqual(["prompt-1", "prompt-2"]);
	});

	/**
	 * Nesting is refused rather than bounded: it would make the media layer recurse, and composition
	 * is expressible by listing the steps twice.
	 */
	it("refuses a step that names another phrase", () => {
		const result = compileAttempt(
			aSnapshot({
				prompts: [
					aPrompt({ id: "phrase-1", name: "Outer", kind: "phrase" }),
					aPrompt({ id: "phrase-2", name: "Inner", kind: "phrase" }),
					aPrompt({ id: "prompt-1", name: "One" }),
				],
				phraseSteps: [
					aPhraseStep({ id: "step-1", phraseId: "phrase-1", promptId: "phrase-2", ordinal: 1 }),
					aPhraseStep({ id: "step-2", phraseId: "phrase-2", promptId: "prompt-1", ordinal: 1 }),
				],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("invalid-phrase");
	});

	/**
	 * A reader's MISS must always mean "play this id as a single file" and never "play nothing", so
	 * an empty phrase is absent from the table rather than present and empty.
	 */
	it("writes no entry at all for a phrase with no playable steps", () => {
		const result = compileAttempt(
			aSnapshot({ prompts: [aPrompt({ id: "phrase-1", name: "Empty", kind: "phrase" })] }),
		);
		expect(codesOf(result)).toContain("invalid-phrase");
		expect(result.ok ? result.artifact.phrases?.["phrase-1"] : undefined).toBe(undefined);
	});

	it("skips a step whose audio is gone, rather than failing the compile", () => {
		const result = compileAttempt(
			aSnapshot({
				prompts: [
					aPrompt({ id: "phrase-1", name: "Position", kind: "phrase" }),
					aPrompt({ id: "prompt-1", name: "One" }),
				],
				phraseSteps: [
					aPhraseStep({ id: "step-1", promptId: "prompt-1", ordinal: 1 }),
					aPhraseStep({ id: "step-2", promptId: "gone", ordinal: 2 }),
				],
			}),
		);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("dangling-phrase-step");
		expect(result.ok ? result.artifact.phrases?.["phrase-1"]?.steps : []).toEqual(["prompt-1"]);
	});
});

// -----------------------------------------------------------------------------------------------
// Dial-by-name directory
// -----------------------------------------------------------------------------------------------

describe("dial-by-name directory", () => {
	function directorySnapshot(overrides: Record<string, unknown> = {}) {
		return aSnapshot({
			extensions: [
				anExtension({ id: "ext-1", number: "1001", label: "Jane Smith", voicemailEnabled: true }),
				anExtension({ id: "ext-2", number: "1002", label: "John Brown", voicemailEnabled: true }),
			],
			voicemailBoxes: [
				aVoicemailBox({ id: "vm-1", mailboxNumber: "1001", extensionId: "ext-1" }),
				aVoicemailBox({ id: "vm-2", mailboxNumber: "1002", extensionId: "ext-2" }),
			],
			voicemailGreetings: [
				aVoicemailGreeting({ id: "vg-1", voicemailBoxId: "vm-1", kind: "name", active: true }),
				aVoicemailGreeting({ id: "vg-2", voicemailBoxId: "vm-2", kind: "name", active: true }),
			],
			directories: [aDirectory()],
			...overrides,
		});
	}

	it("compiles one entry per extension whose name can be spoken", () => {
		const node = compiled(directorySnapshot()).nodes["dial-by-name:dir-1"] as DialByNamePlanNode;
		expect(node.kind).toBe("dial-by-name");
		expect(node.entries.map((entry) => entry.extensionNumber).sort()).toEqual(["1001", "1002"]);
		for (const entry of node.entries) {
			expect(entry.nameMedia.startsWith("object://")).toBe(true);
			expect(entry.targetNodeId.startsWith("extension:")).toBe(true);
		}
	});

	/**
	 * There is no text-to-speech, so an extension whose name cannot be SPOKEN cannot be offered. The
	 * warning is what turns "why is Jane not in the directory" from a mystery into a sentence.
	 */
	it("skips an extension whose mailbox has no recorded name, and says which", () => {
		const result = compileAttempt(directorySnapshot({ voicemailGreetings: [] }));
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("directory-entry-skipped");
		expect(codesOf(result)).toContain("empty-directory");
	});

	/** No runtime symptom — the caller just hears two options — so it is reported where it is visible. */
	it("reports two names that spell to the same digits", () => {
		const result = compileAttempt(
			directorySnapshot({
				extensions: [
					anExtension({ id: "ext-1", number: "1001", label: "Jane Smith", voicemailEnabled: true }),
					anExtension({ id: "ext-2", number: "1002", label: "John Smith", voicemailEnabled: true }),
				],
			}),
		);
		expect(codesOf(result)).toContain("directory-name-collision");
	});

	it("sorts the entries so a prefix scan is a linear walk", () => {
		const node = compiled(directorySnapshot()).nodes["dial-by-name:dir-1"] as DialByNamePlanNode;
		const digits = node.entries.map((entry) => entry.digits);
		expect([...digits].sort()).toEqual(digits);
	});
});

// -----------------------------------------------------------------------------------------------
// Speed dials
// -----------------------------------------------------------------------------------------------

describe("organization speed dials", () => {
	it("resolves a star-prefixed code to its destination", () => {
		const artifact = compiled(
			aSnapshot({ extensions: [anExtension()], speedDials: [aSpeedDial()] }),
		);
		const route = resolveInternal(artifact, { from: "1001", dialed: "*01", now: NOON });
		expect(route.matched).toBe(true);
		expect(route.plan?.entryNodeId).toBe("extension:ext-1");
		expect(route.matchedRuleName).toBe("*01");
	});

	/**
	 * The ordering argument, made executable. `*0` is seeded as eavesdrop with a REQUIRED argument,
	 * so an unguarded `*01` would be consumed as "eavesdrop on extension 1" — the wrong thing
	 * happening rather than nothing, which is the worst failure mode of the three available.
	 */
	it("refuses a code a feature code would swallow", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				featureCodes: [
					{ id: "fc-1", enabled: true, code: "*0", action: "eavesdrop", label: "Monitor" },
				],
				speedDials: [aSpeedDial({ code: "*01" })],
			}),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("conflicting-speed-dial");
	});

	it("collides loudly with an extension when the code is bare digits", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension({ number: "1001" })],
				speedDials: [aSpeedDial({ code: "1001" })],
			}),
		);
		expect(codesOf(result)).toContain("duplicate-internal-number");
	});

	it("refuses a code that is not dialable", () => {
		const result = compileAttempt(
			aSnapshot({ extensions: [anExtension()], speedDials: [aSpeedDial({ code: "not a code" })] }),
		);
		expect(result.ok).toBe(false);
		expect(codesOf(result)).toContain("conflicting-speed-dial");
	});

	/** A feature code still wins at RESOLUTION time, not only at compile time. */
	it("is consulted after the feature codes", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				featureCodes: [
					{ id: "fc-1", enabled: true, code: "*97", action: "voicemail-check", label: "Check" },
				],
				speedDials: [aSpeedDial({ code: "*02" })],
			}),
		);
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "*97", now: NOON }).matchedRuleName,
		).toBe("*97");
		expect(
			resolveInternal(artifact, { from: "1001", dialed: "*02", now: NOON }).matchedRuleName,
		).toBe("*02");
	});
});

// -----------------------------------------------------------------------------------------------
// The organization's simultaneous-call ceiling
// -----------------------------------------------------------------------------------------------

/**
 * `org_limit.max_concurrent_calls`, compiled into the artifact for the engine to enforce.
 *
 * It rides `settings` rather than being a top-level field, and that is a mechanical decision worth
 * a spec of its own: `canonicalizeSnapshot` hashes `organizationId`, `settings` and the members of
 * `SNAPSHOT_COLLECTIONS`, naming `settings` on an explicit line. A sibling field would be OUTSIDE
 * the hash, which means a tenant whose cap changed would keep serving the artifact compiled before
 * it did — the dead-column trap the loader's header describes, one level up and correspondingly
 * harder to notice.
 *
 * The rest is about what "unlimited" means, because four different inputs mean it and only one of
 * them is a mistake.
 */
describe("the concurrent-call ceiling", () => {
	function withCeiling(maxConcurrentCalls: number | null | undefined) {
		return compiled(
			aSnapshot({
				extensions: [anExtension()],
				...(maxConcurrentCalls === undefined ? {} : { settings: { maxConcurrentCalls } }),
			}),
		);
	}

	it("compiles a ceiling onto the artifact's settings", () => {
		expect(withCeiling(25).settings.maxConcurrentCalls).toBe(25);
	});

	/**
	 * All three absences collapse to an absent KEY rather than to a zero or a null, which is what
	 * keeps a tenant with no quota row byte-identical to what they compiled to before this field
	 * existed — and is why adding it was not an artifact version bump.
	 */
	it("omits the key entirely for a tenant with no ceiling", () => {
		for (const value of [undefined, null] as const) {
			const settings = withCeiling(value).settings;
			expect(Object.hasOwn(settings, "maxConcurrentCalls")).toBe(false);
		}
	});

	/**
	 * Zero is UNLIMITED, not "refuse every call" — the same reading `TrunkCapacityPort.reserve`
	 * gives `maxChannels`. A tenant who typed a zero into a quota field meant "no limit", and the
	 * other interpretation takes their phone system down on a keystroke.
	 */
	it("reads a zero as unlimited rather than as a refusal of every call", () => {
		expect(Object.hasOwn(withCeiling(0).settings, "maxConcurrentCalls")).toBe(false);
	});

	/**
	 * A warning and not an error: the artifact is perfectly routable without a ceiling, and refusing
	 * the compile would take every call in the tenant down to report a quota nobody is hitting.
	 */
	it("warns and applies no ceiling for a value that is not a whole number of calls", () => {
		for (const value of [-5, 2.5]) {
			const result = compileAttempt(
				aSnapshot({ extensions: [anExtension()], settings: { maxConcurrentCalls: value } }),
			);
			expect(result.ok, String(value)).toBe(true);
			expect(codesOf(result), String(value)).toContain("invalid-org-limit");
			const artifact = result.ok ? result.artifact : undefined;
			expect(Object.hasOwn(artifact?.settings ?? {}, "maxConcurrentCalls")).toBe(false);
		}
	});

	/** The whole reason it lives on `settings`: a changed cap has to move the snapshot hash. */
	it("moves the snapshot hash, so a raised cap reaches a running engine", () => {
		expect(withCeiling(10).snapshotHash).not.toBe(withCeiling(20).snapshotHash);
	});
});
