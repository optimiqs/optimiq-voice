/**
 * Snapshot builders for the specs.
 *
 * Excluded from the build (`tsconfig.build.json`) and never re-exported from `index.ts`: this is
 * test scaffolding, not public API. It lives in `src/` rather than a `test/` directory so the
 * builders sit next to the types they build and move with them.
 *
 * Every builder supplies a complete, valid row and takes a partial override, so a spec states only
 * the field it is about. That is the difference between a test that reads as an assertion and a
 * test that reads as a fixture dump.
 */

import { compileRoutingArtifact, tryCompileRoutingArtifact } from "./compile";
import { emptySnapshot } from "./snapshot";
import {
	DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
	DERIVED_KEY_BYTES,
	formatVoicemailPinHash,
	MIN_SALT_BYTES,
} from "./voicemail-pin";
import type { RoutingArtifact } from "./artifact";
import type { CompileResult } from "./compile";
import type {
	AudioStreamInput,
	CallBlockRuleInput,
	CallFlowInput,
	ConferenceInput,
	DestinationAliasInput,
	DialByNameDirectoryInput,
	EmergencyAddressInput,
	ExtensionInput,
	FeatureCodeInput,
	InboundRouteInput,
	IvrMenuInput,
	IvrMenuOptionInput,
	MohClassInput,
	OrgRoutingSnapshot,
	OutboundRouteInput,
	PagingGroupInput,
	ParkLotInput,
	PhoneNumberInput,
	PhraseStepInput,
	PinSetEntryInput,
	PinSetInput,
	PromptInput,
	QueueInput,
	RingGroupDestinationInput,
	RingGroupInput,
	SpeedDialInput,
	TimeConditionInput,
	TimeConditionRuleInput,
	TranslationRuleInput,
	TranslationRulesetInput,
	TrunkInput,
	VoicemailBoxInput,
	VoicemailGreetingInput,
} from "./snapshot";

export const ORG_ID = "org-0001";

/** A fixed instant so artifacts are comparable byte for byte across specs. */
export const COMPILED_AT = "2026-08-05T12:00:00.000Z";

export function anExtension(overrides: Partial<ExtensionInput> = {}): ExtensionInput {
	return {
		id: "ext-1",
		enabled: true,
		number: "1001",
		label: "Reception",
		voicemailEnabled: false,
		doNotDisturb: false,
		forwardAllEnabled: false,
		forwardBusyEnabled: false,
		forwardNoAnswerEnabled: false,
		forwardUnregisteredEnabled: false,
		recordPolicy: "none",
		tollClass: "national",
		callTimeoutSeconds: 30,
		...overrides,
	};
}

export function aPhoneNumber(overrides: Partial<PhoneNumberInput> = {}): PhoneNumberInput {
	return {
		id: "did-1",
		enabled: true,
		e164: "+15551230001",
		destinationType: "extension",
		destinationRef: "ext-1",
		recordEnabled: false,
		voiceEnabled: true,
		...overrides,
	};
}

export function aTrunk(overrides: Partial<TrunkInput> = {}): TrunkInput {
	return {
		id: "trunk-1",
		enabled: true,
		name: "Primary carrier",
		kind: "ip-auth",
		sipDomain: "carrier.example",
		sipProxy: "sip.carrier.example",
		transport: "udp",
		...overrides,
	};
}

export function anInboundRoute(overrides: Partial<InboundRouteInput> = {}): InboundRouteInput {
	return {
		id: "in-1",
		enabled: true,
		name: "Main line",
		priority: 100,
		matchKind: "exact",
		matchPattern: "+15551230001",
		destinationType: "extension",
		destinationRef: "ext-1",
		recordEnabled: false,
		...overrides,
	};
}

export function anOutboundRoute(overrides: Partial<OutboundRouteInput> = {}): OutboundRouteInput {
	return {
		id: "out-1",
		enabled: true,
		name: "National",
		priority: 100,
		matchKind: "prefix",
		dialPatterns: ["+1"],
		stripDigits: 0,
		tollClass: "national",
		trunkPriority: [{ trunkId: "trunk-1", order: 1 }],
		recordEnabled: false,
		...overrides,
	};
}

export function aTimeCondition(overrides: Partial<TimeConditionInput> = {}): TimeConditionInput {
	return {
		id: "tc-1",
		enabled: true,
		name: "Business hours",
		timezone: "UTC",
		destinationType: "extension",
		destinationRef: "ext-1",
		...overrides,
	};
}

export function aTimeRule(overrides: Partial<TimeConditionRuleInput> = {}): TimeConditionRuleInput {
	return {
		id: "tcr-1",
		enabled: true,
		timeConditionId: "tc-1",
		ordinal: 1,
		predicates: [{ weekdays: [1, 2, 3, 4, 5], timeOfDay: { from: "09:00", to: "17:00" } }],
		...overrides,
	};
}

export function anIvrMenu(overrides: Partial<IvrMenuInput> = {}): IvrMenuInput {
	return {
		id: "ivr-1",
		enabled: true,
		name: "Main menu",
		digitTimeoutMs: 5000,
		interDigitTimeoutMs: 2000,
		maxDigits: 1,
		maxFailures: 3,
		maxTimeouts: 3,
		directDialEnabled: false,
		...overrides,
	};
}

export function anIvrOption(overrides: Partial<IvrMenuOptionInput> = {}): IvrMenuOptionInput {
	return {
		id: "ivro-1",
		enabled: true,
		ivrMenuId: "ivr-1",
		ordinal: 1,
		matchKind: "digit",
		matchValue: "1",
		destinationType: "extension",
		destinationRef: "ext-1",
		...overrides,
	};
}

export function aRingGroup(overrides: Partial<RingGroupInput> = {}): RingGroupInput {
	return {
		id: "rg-1",
		enabled: true,
		name: "Sales",
		strategy: "simultaneous",
		ringTimeoutSeconds: 30,
		ignoreBusy: true,
		confirmEnabled: false,
		...overrides,
	};
}

export function aRingGroupMember(
	overrides: Partial<RingGroupDestinationInput> = {},
): RingGroupDestinationInput {
	return {
		id: "rgd-1",
		enabled: true,
		ringGroupId: "rg-1",
		ordinal: 1,
		destinationType: "extension",
		destinationRef: "ext-1",
		delaySeconds: 0,
		timeoutSeconds: 30,
		confirmRequired: false,
		...overrides,
	};
}

export function aQueue(overrides: Partial<QueueInput> = {}): QueueInput {
	return {
		id: "q-1",
		enabled: true,
		name: "Support",
		strategy: "longest-idle",
		maxWaitSeconds: 600,
		maxWaitNoAgentSeconds: 0,
		announcePositionEnabled: false,
		announceFrequencySeconds: 60,
		recordPolicy: "none",
		...overrides,
	};
}

export function aVoicemailBox(overrides: Partial<VoicemailBoxInput> = {}): VoicemailBoxInput {
	return {
		id: "vm-1",
		enabled: true,
		mailboxNumber: "1001",
		extensionId: "ext-1",
		mwiEnabled: true,
		maxMessageSeconds: 300,
		...overrides,
	};
}

export function aVoicemailGreeting(
	overrides: Partial<VoicemailGreetingInput> = {},
): VoicemailGreetingInput {
	return {
		id: "vmg-1",
		voicemailBoxId: "vm-1",
		kind: "unavailable",
		objectKey: "org-0001/voicemail/vm-1/unavailable.wav",
		active: true,
		...overrides,
	};
}

export function aMohClass(overrides: Partial<MohClassInput> = {}): MohClassInput {
	return {
		id: "moh-1",
		enabled: true,
		name: "default-hold",
		...overrides,
	};
}

/**
 * A syntactically valid PIN digest.
 *
 * The bytes are not the digest of any PIN — nothing in this package hashes, and a fixture that
 * pretended otherwise would be a lie a spec could come to depend on. What it is valid *for* is the
 * only thing the compiler checks: the format contract in `voicemail-pin.ts`.
 */
export const A_PIN_HASH = formatVoicemailPinHash(
	DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
	base64Zeroes(MIN_SALT_BYTES),
	base64Zeroes(DERIVED_KEY_BYTES),
);

/** Base64 of `bytes` zero bytes — `A` is the zero sextet, `=` is the padding. */
function base64Zeroes(bytes: number): string {
	const groups = Math.ceil(bytes / 3);
	const padding = groups * 3 - bytes;
	return "A".repeat(groups * 4 - padding) + "=".repeat(padding);
}

export function aConference(overrides: Partial<ConferenceInput> = {}): ConferenceInput {
	return {
		id: "conf-1",
		enabled: true,
		name: "Board room",
		roomNumber: "3001",
		requiresPin: false,
		maxMembers: 50,
		waitForModerator: false,
		recordPolicy: "none",
		...overrides,
	};
}

export function anEmergencyAddress(
	overrides: Partial<EmergencyAddressInput> = {},
): EmergencyAddressInput {
	return {
		id: "addr-1",
		label: "Head office, floor 2",
		validated: true,
		...overrides,
	};
}

export function aParkLot(overrides: Partial<ParkLotInput> = {}): ParkLotInput {
	return {
		id: "park-1",
		enabled: true,
		name: "Main lot",
		slotStart: 701,
		slotEnd: 720,
		timeoutSeconds: 120,
		...overrides,
	};
}

export function aPagingGroup(overrides: Partial<PagingGroupInput> = {}): PagingGroupInput {
	return {
		id: "pg-1",
		enabled: true,
		name: "All handsets",
		duplex: false,
		timeoutSeconds: 30,
		members: [{ extensionId: "ext-1", ordinal: 1, enabled: true }],
		...overrides,
	};
}

export function aFeatureCode(overrides: Partial<FeatureCodeInput> = {}): FeatureCodeInput {
	return {
		id: "fc-1",
		enabled: true,
		code: "*97",
		action: "voicemail-check",
		...overrides,
	};
}

export function aCallBlockRule(overrides: Partial<CallBlockRuleInput> = {}): CallBlockRuleInput {
	return {
		id: "cb-1",
		enabled: true,
		pattern: "+1555000",
		matchKind: "prefix",
		direction: "inbound",
		action: "block",
		...overrides,
	};
}

export function aCallFlow(overrides: Partial<CallFlowInput> = {}): CallFlowInput {
	return {
		id: "cf-1",
		enabled: true,
		name: "Front desk",
		featureCode: "*281",
		mode: "day",
		destinationType: "extension",
		destinationRef: "ext-1",
		nightDestinationType: "hangup",
		...overrides,
	};
}

export function anAlias(overrides: Partial<DestinationAliasInput> = {}): DestinationAliasInput {
	return {
		id: "alias-1",
		enabled: true,
		name: "The front desk",
		destinationType: "extension",
		destinationRef: "ext-1",
		...overrides,
	};
}

export function aStream(overrides: Partial<AudioStreamInput> = {}): AudioStreamInput {
	return {
		id: "stream-1",
		enabled: true,
		name: "Shop radio",
		url: "https://media.example.com/radio.mp3",
		answerFirst: true,
		maxSeconds: 0,
		fallbackDestinationType: "hangup",
		...overrides,
	};
}

export function aDirectory(
	overrides: Partial<DialByNameDirectoryInput> = {},
): DialByNameDirectoryInput {
	return {
		id: "dir-1",
		enabled: true,
		name: "Company directory",
		searchField: "last-name",
		minDigits: 3,
		maxFailures: 3,
		...overrides,
	};
}

export function aSpeedDial(overrides: Partial<SpeedDialInput> = {}): SpeedDialInput {
	return {
		id: "sd-1",
		enabled: true,
		code: "*01",
		label: "Head office",
		destinationType: "extension",
		destinationRef: "ext-1",
		...overrides,
	};
}

export function aPinSet(overrides: Partial<PinSetInput> = {}): PinSetInput {
	return {
		id: "pin-1",
		enabled: true,
		name: "International codes",
		maxAttempts: 3,
		digitTimeoutMs: 8000,
		...overrides,
	};
}

export function aPinEntry(overrides: Partial<PinSetEntryInput> = {}): PinSetEntryInput {
	return {
		id: "pin-entry-1",
		enabled: true,
		pinSetId: "pin-1",
		ordinal: 1,
		label: "Night desk",
		pinHash: A_PIN_HASH,
		...overrides,
	};
}

export function aTranslationRuleset(
	overrides: Partial<TranslationRulesetInput> = {},
): TranslationRulesetInput {
	return {
		id: "tr-1",
		enabled: true,
		name: "E.164 normalisation",
		...overrides,
	};
}

export function aTranslationRule(
	overrides: Partial<TranslationRuleInput> = {},
): TranslationRuleInput {
	return {
		id: "trr-1",
		enabled: true,
		translationRulesetId: "tr-1",
		ordinal: 1,
		matchPattern: "^00(\\d+)$",
		replacement: "+$1",
		...overrides,
	};
}

export function aPrompt(overrides: Partial<PromptInput> = {}): PromptInput {
	return {
		id: "prompt-1",
		enabled: true,
		name: "Greeting",
		kind: "prompt",
		...overrides,
	};
}

export function aPhraseStep(overrides: Partial<PhraseStepInput> = {}): PhraseStepInput {
	return {
		id: "step-1",
		enabled: true,
		phraseId: "phrase-1",
		promptId: "prompt-1",
		ordinal: 1,
		...overrides,
	};
}

/** A complete snapshot with only the collections a spec names. */
export function aSnapshot(overrides: Partial<OrgRoutingSnapshot> = {}): OrgRoutingSnapshot {
	return { ...emptySnapshot(ORG_ID), ...overrides };
}

/** Compiles, asserting success. Throws {@link RoutingCompileError} with the diagnostics if not. */
export function compiled(snapshot: OrgRoutingSnapshot): RoutingArtifact {
	return compileRoutingArtifact(snapshot, { compiledAt: COMPILED_AT });
}

/** Compiles without asserting, for specs about diagnostics. */
export function compileAttempt(snapshot: OrgRoutingSnapshot): CompileResult {
	return tryCompileRoutingArtifact(snapshot, { compiledAt: COMPILED_AT });
}

/** Diagnostic codes produced by a compile, in order. */
export function codesOf(result: CompileResult): readonly string[] {
	return result.diagnostics.map((entry) => entry.code);
}

/** An instant, spelled as a UTC ISO string. */
export function at(iso: string): Date {
	return new Date(iso);
}
