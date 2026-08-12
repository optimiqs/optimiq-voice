/**
 * The routing compiler: `OrgRoutingSnapshot` → `RoutingArtifact`.
 *
 * # What "error" means here
 *
 * The compiler runs on the write path (compile-on-save) as well as on a cache miss, and that
 * decides the severity line:
 *
 * - **error** — the artifact would not be *sound*: a destination that resolves to nothing, a regex
 *   that cannot be compiled, two entities claiming the same internal number, an IVR menu whose
 *   option points at itself. These are states the CRUD layer must refuse to save, so the only way
 *   to reach one is a direct database edit. A compile with errors produces no artifact.
 * - **warning** — the artifact is sound but the configuration is probably not what the tenant
 *   meant: a ring group with no members, an outbound route whose trunks were all deleted, a route
 *   shadowed by an earlier one. These *must* compile, because half-built configuration is the
 *   normal state of an admin UI: you create the ring group, then you add members to it.
 *
 * The rule that falls out: a warning never blocks a save, an error always does.
 *
 * # Determinism
 *
 * Same snapshot in, byte-identical artifact out. Every collection is sorted before it is walked,
 * every node id is derived from the entity it came from rather than generated, and the only
 * non-derived field on the artifact — `compiledAt` — is supplied by the caller. Nothing here reads
 * a clock. That is what makes "recompile and compare hashes" a cheap way to decide whether a write
 * to the cache is needed at all.
 */

import { isHangupCause, RETRYABLE_HANGUP_CAUSES } from "@optimiq-voice/telephony";
import { ROUTING_ARTIFACT_VERSION } from "./artifact";
import { snapshotHash } from "./cache";
import { destinationShapeIssues, isDestinationType } from "./destinations";
import { DiagnosticBag } from "./diagnostics";
import { directoryDigits } from "./dial-by-name";
import {
	EMERGENCY_CONTINUE_ON_CAUSES,
	EMERGENCY_NODE_ID,
	EMERGENCY_ROUTE_ID,
	emergencyNumbers,
	invalidEmergencyNumbers,
} from "./emergency";
import { RoutingCompileError, RoutingSnapshotError } from "./errors";
import {
	FEATURE_CODE_ARGUMENT_MODE,
	featureCodeIssues,
	isWellFormedFeatureCode,
} from "./feature-codes";
import {
	applyDigitManipulation,
	compilePattern,
	matchPattern,
	patternSpecificity,
	patternSubsumes,
	validateDigitManipulation,
} from "./patterns";
import { planNodeReferences } from "./plan";
import { checkCallBlock } from "./resolve";
import {
	isOptionalSnapshotCollection,
	QUEUE_EXIT_KEYS,
	QUEUE_PRIORITY_MAX,
	QUEUE_PRIORITY_MIN,
	SNAPSHOT_COLLECTIONS,
	tollClassCovers,
	VOICEMAIL_LEAVE_GREETING_PRECEDENCE,
} from "./snapshot";
import { compileTimePredicate, isKnownTimezone, validateTimePredicate } from "./time-conditions";
import { validateTranslationRule } from "./translations";
import { voicemailPinHashIssue } from "./voicemail-pin";
import type {
	CompiledCallBlockRule,
	CompiledPhrase,
	CompiledRoutingSettings,
	EmergencyMatchTable,
	EmergencyRule,
	ExtensionIndexEntry,
	InboundDidDefault,
	InboundMatchTable,
	InboundRule,
	InternalMatchTable,
	InternalNumberEntry,
	MailboxEntry,
	OutboundMatchTable,
	OutboundRule,
	ParkSlotRange,
	RouteTimeGate,
	RoutingArtifact,
	SpeedDialEntry,
	VoicemailPrefixEntry,
} from "./artifact";
import type { Destination } from "./destinations";
import type { Diagnostic, DiagnosticSubject } from "./diagnostics";
import type { CompiledFeatureCode } from "./feature-codes";
import type { CompiledPattern } from "./patterns";
import type {
	CompiledPinEntry,
	CompiledPinSet,
	DirectoryEntry,
	ExtensionPlanNode,
	FollowMeDestination,
	FollowMePlan,
	PlanNode,
	PlanNodeId,
	RingGroupMember,
} from "./plan";
import type {
	AudioStreamInput,
	CallBlockAction,
	CallFlowInput,
	DestinationAliasInput,
	DialByNameDirectoryInput,
	EmergencyAddressInput,
	ExtensionInput,
	FollowMeTargetInput,
	IvrMenuOptionInput,
	MohClassInput,
	OrgRoutingSnapshot,
	PagingGroupInput,
	PhraseStepInput,
	PinSetEntryInput,
	PinSetInput,
	PromptInput,
	RingGroupDestinationInput,
	TimeConditionRuleInput,
	TranslationRuleInput,
	VoicemailGreetingInput,
	VoicemailGreetingKind,
} from "./snapshot";
import type { CompiledTimeCondition, CompiledTimeRule } from "./time-conditions";
import type { CompiledTranslationRule, CompiledTranslationRuleset } from "./translations";
import type { HangupCause } from "@optimiq-voice/telephony";

/** Everything the compiler needs that is not in the snapshot. */
export interface CompileOptions {
	/**
	 * The instant recorded on the artifact, ISO 8601. Supplied by the caller because a pure
	 * compiler must not read a clock — see the determinism note above.
	 */
	readonly compiledAt: string;
}

export type CompileResult =
	| {
			readonly ok: true;
			readonly artifact: RoutingArtifact;
			readonly diagnostics: readonly Diagnostic[];
	  }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * How deep an alias chain may be expanded.
 *
 * Aliases are macros and legitimately nest — "the front desk" pointing at "reception", pointing at a
 * ring group — but a chain longer than a handful is a tenant who has lost track rather than a tenant
 * who meant it, and the bound is what keeps a pathological configuration from being a compile that
 * never finishes. The cycle check catches loops; this catches depth.
 */
const MAX_ALIAS_DEPTH = 8;

/** What an organization speed-dial code may look like. Star-prefixed or bare digits, both dialable. */
const SPEED_DIAL_CODE_PATTERN = /^[*#]?[0-9*#]{1,10}$/u;

/**
 * Whether a stream URL is one a media server may be asked to open.
 *
 * `http` and `https` and nothing else. The set of things a tenant can cause the media server to
 * open is a security decision rather than a formatting one: `file:` would read the server's disk,
 * and a scheme-less string is one a driver might interpret as a local path.
 */
function isPlayableStreamUrl(url: string): boolean {
	try {
		const parsed = new URL(url.trim());
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/** Cause used when a destination points at something a tenant has switched off. */
const DISABLED_TARGET_CAUSE: HangupCause = "SERVICE_UNAVAILABLE";

/** Default caller-facing terminal for "this number does not exist here". */
const NO_MATCH_CAUSE: HangupCause = "UNALLOCATED_NUMBER";

/** Terminal for a call the toll-class gate refused. */
const TOLL_DENIED_CAUSE: HangupCause = "OUTGOING_CALL_BARRED";

/**
 * Terminals every artifact carries, referenced or not.
 *
 * `resolve.ts` reaches for `hangup:CALL_REJECTED` and `hangup:USER_BUSY` when a call-block rule
 * fires, and for `hangup:NORMAL_CLEARING` when a gate chain runs out — none of which any tenant
 * configuration has to mention.
 */
const WELL_KNOWN_TERMINAL_CAUSES: readonly HangupCause[] = [
	"NORMAL_CLEARING",
	"UNALLOCATED_NUMBER",
	"CALL_REJECTED",
	"USER_BUSY",
	"NO_ANSWER",
	"USER_NOT_REGISTERED",
	"OUTGOING_CALL_BARRED",
	"SERVICE_UNAVAILABLE",
];

/** Where a compiled call-block rule sends the caller, per action. */
export function callBlockHangupCause(action: CallBlockAction): HangupCause | null {
	switch (action) {
		// 603 Decline: an explicit "no".
		case "block": {
			return "CALL_REJECTED";
		}
		// 486 Busy Here: tells the caller the line is busy rather than that they are blocked, which
		// is what a tenant screening a nuisance caller usually wants.
		case "reject": {
			return "USER_BUSY";
		}
		// `allow` proceeds and `voicemail` is resolved by the engine against the callee's own
		// mailbox, which the artifact cannot know from a caller-screening rule.
		default: {
			return null;
		}
	}
}

/**
 * Compiles a snapshot, throwing {@link RoutingCompileError} when the configuration contains errors.
 *
 * Use this from the engine's cache-miss path, where an error is genuinely exceptional. Use
 * {@link tryCompileRoutingArtifact} from the API's save path, where the diagnostics *are* the
 * response body.
 */
export function compileRoutingArtifact(
	snapshot: OrgRoutingSnapshot,
	options: CompileOptions,
): RoutingArtifact {
	const result = tryCompileRoutingArtifact(snapshot, options);
	if (!result.ok) {
		throw new RoutingCompileError(snapshot.organizationId, result.diagnostics);
	}
	return result.artifact;
}

/** Compiles a snapshot, returning diagnostics instead of throwing. */
export function tryCompileRoutingArtifact(
	snapshot: OrgRoutingSnapshot,
	options: CompileOptions,
): CompileResult {
	assertSnapshotShape(snapshot);
	return new Compiler(snapshot, normaliseCompiledAt(options.compiledAt)).run();
}

function normaliseCompiledAt(compiledAt: string): string {
	const parsed = Date.parse(compiledAt);
	if (Number.isNaN(parsed)) {
		throw new RoutingSnapshotError("compiledAt", `${JSON.stringify(compiledAt)} is not an instant`);
	}
	return new Date(parsed).toISOString();
}

function assertSnapshotShape(snapshot: OrgRoutingSnapshot): void {
	if (typeof snapshot.organizationId !== "string" || snapshot.organizationId.length === 0) {
		throw new RoutingSnapshotError("organizationId", "must be a non-empty string");
	}
	for (const collection of SNAPSHOT_COLLECTIONS) {
		const rows = snapshot[collection];
		// An optional collection may be absent — that is the whole point of it being optional, and it
		// is how this package stays compilable against a loader that has not learned to load it yet.
		// A collection that is PRESENT and not an array is still a malformed snapshot.
		if (rows === undefined && isOptionalSnapshotCollection(collection)) {
			continue;
		}
		if (!Array.isArray(rows)) {
			throw new RoutingSnapshotError(collection, "must be an array");
		}
	}
}

interface OutboundTrunkPlan {
	readonly attempts: readonly import("./plan").TrunkAttempt[];
	readonly continueOnCauses: readonly HangupCause[];
}

class Compiler {
	private readonly snapshot: OrgRoutingSnapshot;
	private readonly compiledAt: string;
	private readonly bag = new DiagnosticBag();
	private readonly nodes = new Map<PlanNodeId, PlanNode>();
	/** Ids claimed but possibly still under construction; guards cyclic destination graphs. */
	private readonly claimed = new Set<PlanNodeId>();

	private readonly extensionsById = new Map<string, ExtensionInput>();
	private readonly extensionsByNumber = new Map<string, ExtensionInput>();
	private readonly ivrMenusById = new Map<string, OrgRoutingSnapshot["ivrMenus"][number]>();
	private readonly ringGroupsById = new Map<string, OrgRoutingSnapshot["ringGroups"][number]>();
	private readonly queuesById = new Map<string, OrgRoutingSnapshot["queues"][number]>();
	private readonly voicemailById = new Map<string, OrgRoutingSnapshot["voicemailBoxes"][number]>();
	private readonly voicemailByExtension = new Map<
		string,
		OrgRoutingSnapshot["voicemailBoxes"][number]
	>();
	private readonly conferencesById = new Map<string, OrgRoutingSnapshot["conferences"][number]>();
	private readonly parkLotsById = new Map<string, OrgRoutingSnapshot["parkLots"][number]>();
	private readonly pagingGroupsById = new Map<string, PagingGroupInput>();
	private readonly phoneNumbersById = new Map<string, OrgRoutingSnapshot["phoneNumbers"][number]>();
	private readonly trunksById = new Map<string, OrgRoutingSnapshot["trunks"][number]>();
	private readonly timeConditionsById = new Map<string, CompiledTimeCondition>();
	private readonly timeConditionInputsById = new Map<
		string,
		OrgRoutingSnapshot["timeConditions"][number]
	>();
	private readonly mohClassesById = new Map<string, MohClassInput>();
	private readonly emergencyAddressesById = new Map<string, EmergencyAddressInput>();
	/** Active greetings, keyed by `<voicemailBoxId>:<kind>` — at most one row per pair. */
	private readonly activeGreetings = new Map<string, VoicemailGreetingInput>();
	private readonly ivrOptionsByMenu = new Map<string, IvrMenuOptionInput[]>();
	private readonly ringMembersByGroup = new Map<string, RingGroupDestinationInput[]>();
	private readonly timeRulesByCondition = new Map<string, TimeConditionRuleInput[]>();
	/** Every internal number claimed so far, so the second claimant can be reported. */
	private readonly internalNumbers = new Map<string, InternalNumberEntry>();

	// --- the T2 admin block ---------------------------------------------------------------------
	private readonly callFlowsById = new Map<string, CallFlowInput>();
	private readonly aliasesById = new Map<string, DestinationAliasInput>();
	private readonly streamsById = new Map<string, AudioStreamInput>();
	private readonly directoriesById = new Map<string, DialByNameDirectoryInput>();
	private readonly promptsById = new Map<string, PromptInput>();
	private readonly phraseStepsByPhrase = new Map<string, PhraseStepInput[]>();
	private readonly pinSetsById = new Map<string, PinSetInput>();
	private readonly pinEntriesBySet = new Map<string, PinSetEntryInput[]>();
	private readonly translationRulesetsById = new Map<string, CompiledTranslationRuleset>();
	private readonly translationRulesByRuleset = new Map<string, TranslationRuleInput[]>();
	/**
	 * Aliases currently being expanded, innermost last.
	 *
	 * `claimed` cannot do this job: an alias produces no node to claim, so the ordinary
	 * already-under-construction guard never sees one. This is the cycle guard flatness needs.
	 */
	private readonly aliasStack: string[] = [];

	constructor(snapshot: OrgRoutingSnapshot, compiledAt: string) {
		this.snapshot = snapshot;
		this.compiledAt = compiledAt;
	}

	run(): CompileResult {
		this.index();
		this.ensureWellKnownTerminals();
		const settings = this.compileSettings();
		// Before the time conditions and before every entity, because a route, a trunk and a time
		// condition can all name a ruleset and none of them may compile against a half-built one.
		this.compileTranslationRulesets();
		const phrases = this.compilePhrases();
		this.compileTimeConditions();
		this.materialiseEntities();

		// Before the three tables, because both `internal` and `outbound` embed it and the
		// shadowing check reads the internal numbers `compileInternal` claims.
		const emergency = this.compileEmergency();

		const internal = this.compileInternal(emergency);
		const inbound = this.compileInbound();
		const outbound = this.compileOutbound(settings, emergency);
		const callBlock = this.compileCallBlock();
		const extensionIndex = this.compileExtensionIndex();

		// LAST of the node passes: a follow-me hop to an external number resolves against the
		// outbound rules and the call-block table, so both have to exist before it runs. It only
		// rewrites `extension` nodes that are already in the table, so closure still holds below.
		this.compileFollowMe(outbound, callBlock);

		this.detectIvrCycles();
		this.assertNodeClosure();

		if (this.bag.hasErrors()) {
			return { ok: false, diagnostics: this.bag.all() };
		}

		const diagnostics = this.bag.all();
		const artifact: RoutingArtifact = {
			artifactVersion: ROUTING_ARTIFACT_VERSION,
			organizationId: this.snapshot.organizationId,
			snapshotHash: snapshotHash(this.snapshot),
			compiledAt: this.compiledAt,
			settings,
			nodes: sortedRecord(this.nodes),
			timeConditions: sortedRecord(this.timeConditionsById),
			inbound,
			internal,
			outbound,
			callBlock,
			...(Object.keys(phrases).length === 0 ? {} : { phrases }),
			extensionsByNumber: extensionIndex,
			diagnostics,
		};
		return { ok: true, artifact, diagnostics };
	}

	// -------------------------------------------------------------------------------------------
	// Indexing
	// -------------------------------------------------------------------------------------------

	private index(): void {
		for (const extension of sortById(this.snapshot.extensions)) {
			this.extensionsById.set(extension.id, extension);
			if (extension.enabled) {
				this.extensionsByNumber.set(extension.number, extension);
			}
		}
		for (const menu of sortById(this.snapshot.ivrMenus)) {
			this.ivrMenusById.set(menu.id, menu);
		}
		for (const group of sortById(this.snapshot.ringGroups)) {
			this.ringGroupsById.set(group.id, group);
		}
		for (const entry of sortById(this.snapshot.queues)) {
			this.queuesById.set(entry.id, entry);
		}
		for (const box of sortById(this.snapshot.voicemailBoxes)) {
			this.voicemailById.set(box.id, box);
			if (box.extensionId != null && box.enabled) {
				this.voicemailByExtension.set(box.extensionId, box);
			}
		}
		for (const room of sortById(this.snapshot.conferences)) {
			this.conferencesById.set(room.id, room);
		}
		for (const lot of sortById(this.snapshot.parkLots)) {
			this.parkLotsById.set(lot.id, lot);
		}
		// `?? []`, because `pagingGroups` is an optional collection: a loader that has not learned to
		// select `paging_group` yet is a rollout state, not a tenant with no paging.
		for (const group of sortById(this.snapshot.pagingGroups ?? [])) {
			this.pagingGroupsById.set(group.id, group);
		}
		for (const did of sortById(this.snapshot.phoneNumbers)) {
			this.phoneNumbersById.set(did.id, did);
		}
		for (const trunk of sortById(this.snapshot.trunks)) {
			this.trunksById.set(trunk.id, trunk);
		}
		for (const condition of sortById(this.snapshot.timeConditions)) {
			this.timeConditionInputsById.set(condition.id, condition);
		}
		for (const mohClass of sortById(this.snapshot.mohClasses ?? [])) {
			this.mohClassesById.set(mohClass.id, mohClass);
		}
		for (const address of sortById(this.snapshot.emergencyAddresses ?? [])) {
			this.emergencyAddressesById.set(address.id, address);
		}
		for (const flow of sortById(this.snapshot.callFlows ?? [])) {
			this.callFlowsById.set(flow.id, flow);
		}
		for (const alias of sortById(this.snapshot.destinationAliases ?? [])) {
			this.aliasesById.set(alias.id, alias);
		}
		for (const stream of sortById(this.snapshot.audioStreams ?? [])) {
			this.streamsById.set(stream.id, stream);
		}
		for (const directory of sortById(this.snapshot.directories ?? [])) {
			this.directoriesById.set(directory.id, directory);
		}
		for (const entry of sortById(this.snapshot.prompts ?? [])) {
			this.promptsById.set(entry.id, entry);
		}
		for (const step of sortByOrdinal(this.snapshot.phraseSteps ?? [])) {
			pushInto(this.phraseStepsByPhrase, step.phraseId, step);
		}
		for (const set of sortById(this.snapshot.pinSets ?? [])) {
			this.pinSetsById.set(set.id, set);
		}
		for (const entry of sortByOrdinal(this.snapshot.pinSetEntries ?? [])) {
			pushInto(this.pinEntriesBySet, entry.pinSetId, entry);
		}
		for (const rule of sortByOrdinal(this.snapshot.translationRules ?? [])) {
			pushInto(this.translationRulesByRuleset, rule.translationRulesetId, rule);
		}
		this.indexVoicemailGreetings();
		for (const option of sortByOrdinal(this.snapshot.ivrMenuOptions)) {
			pushInto(this.ivrOptionsByMenu, option.ivrMenuId, option);
		}
		for (const member of sortByOrdinal(this.snapshot.ringGroupDestinations)) {
			pushInto(this.ringMembersByGroup, member.ringGroupId, member);
		}
		for (const rule of sortByOrdinal(this.snapshot.timeConditionRules)) {
			pushInto(this.timeRulesByCondition, rule.timeConditionId, rule);
		}
	}

	// -------------------------------------------------------------------------------------------
	// Settings
	// -------------------------------------------------------------------------------------------

	private compileSettings(): CompiledRoutingSettings {
		const input = this.snapshot.settings ?? {};
		const timezone = input.defaultTimezone ?? "UTC";
		if (!isKnownTimezone(timezone)) {
			this.bag.error(
				"unknown-timezone",
				`Organization default timezone "${timezone}" is not an IANA zone this runtime knows.`,
				undefined,
				"settings.defaultTimezone",
			);
		}
		return compact({
			defaultTimezone: timezone,
			outboundEnabled: input.outboundEnabled ?? true,
			outboundCallerIdNumber: input.outboundCallerIdNumber ?? undefined,
			outboundCallerIdName: input.outboundCallerIdName ?? undefined,
		}) as CompiledRoutingSettings;
	}

	private trunkContinueOnCauses(): readonly HangupCause[] {
		const configured = this.snapshot.settings?.trunkContinueOnCauses;
		if (configured === undefined) {
			return [...RETRYABLE_HANGUP_CAUSES];
		}
		const accepted: HangupCause[] = [];
		for (const cause of configured) {
			if (isHangupCause(cause as HangupCause)) {
				accepted.push(cause as HangupCause);
			} else {
				this.bag.warning(
					"invalid-pattern",
					`Unknown hangup cause "${cause}" in trunkContinueOnCauses; it was dropped.`,
					undefined,
					"settings.trunkContinueOnCauses",
				);
			}
		}
		// Sorted so the artifact does not move when a tenant reorders an unordered set.
		return [...new Set(accepted)].sort();
	}

	// -------------------------------------------------------------------------------------------
	// Time conditions
	// -------------------------------------------------------------------------------------------

	private compileTimeConditions(): void {
		for (const condition of sortById(this.snapshot.timeConditions)) {
			const subject: DiagnosticSubject = {
				kind: "time-condition",
				id: condition.id,
				name: condition.name,
			};
			const timezone = condition.timezone.length > 0 ? condition.timezone : "UTC";
			if (!isKnownTimezone(timezone)) {
				this.bag.error(
					"unknown-timezone",
					`Time condition "${condition.name}" uses timezone "${timezone}", which is not an IANA zone this runtime knows.`,
					subject,
					"timezone",
				);
				continue;
			}

			const rules: CompiledTimeRule[] = [];
			for (const rule of this.timeRulesByCondition.get(condition.id) ?? []) {
				if (!rule.enabled) {
					continue;
				}
				const predicates = [];
				let valid = true;
				for (const [index, predicate] of rule.predicates.entries()) {
					const issues = validateTimePredicate(predicate);
					for (const issue of issues) {
						valid = false;
						this.bag.error(
							"invalid-time-rule",
							`Time rule ${rule.ordinal} of "${condition.name}" has an invalid predicate (${issue.code}).`,
							{ kind: "time-condition-rule", id: rule.id },
							`predicates[${index}]`,
						);
					}
					predicates.push(compileTimePredicate(predicate));
				}
				if (!valid) {
					continue;
				}
				rules.push(
					compact({
						id: rule.id,
						ordinal: rule.ordinal,
						label: rule.label ?? undefined,
						predicates,
					}) as CompiledTimeRule,
				);
			}

			// An overridden condition never reads its rules, so "no rules" is not the trap it usually
			// is — a tenant who has forced a condition open has said what they want and does not need
			// to be told the rule list is empty.
			if (rules.length === 0 && (condition.override ?? "auto") === "auto") {
				this.bag.warning(
					"empty-time-condition",
					`Time condition "${condition.name}" has no enabled rules, so it always takes its no-match branch.`,
					subject,
				);
			}

			this.timeConditionsById.set(
				condition.id,
				compact({
					id: condition.id,
					name: condition.name,
					timezone,
					rules,
					// `auto` is dropped rather than carried, so a condition nobody has overridden hashes
					// exactly as it did before the column existed — which is what keeps this wave from
					// moving every tenant's `snapshotHash` for a feature they are not using.
					override: (condition.override ?? "auto") === "auto" ? undefined : condition.override,
					overrideFeatureCode: condition.overrideFeatureCode ?? undefined,
				}) as CompiledTimeCondition,
			);
		}
	}

	// -------------------------------------------------------------------------------------------
	// Node construction
	// -------------------------------------------------------------------------------------------

	/**
	 * Terminals a resolver may need without any tenant configuration referencing them: the call-block
	 * outcomes, the "nothing matched" ends, and the extension fallbacks. Materialising them up front
	 * means a resolver never has to ask whether the node it is about to hand the engine exists.
	 */
	private ensureWellKnownTerminals(): void {
		for (const cause of WELL_KNOWN_TERMINAL_CAUSES) {
			this.hangupNode(cause);
		}
	}

	/**
	 * Compiles every enabled entity into a node, whether or not anything points at it.
	 *
	 * The alternative — compile only what a route reaches — would mean a ring group built before it
	 * is wired up produces no `empty-ring-group` warning, and a mutually recursive pair of IVR menus
	 * produces no `ivr-cycle` warning until the day someone points a DID at them. Half-built
	 * configuration is the normal state of an admin UI, so the compiler validates the whole of it.
	 *
	 * The cost is a handful of unreferenced nodes in the artifact. The benefit is that the artifact
	 * is a complete picture of the tenant's call flows, which is what a call-flow inspector needs
	 * and what makes the "every reference resolves" property worth asserting.
	 *
	 * Collections are walked in a fixed order, each sorted by id, so the diagnostics a snapshot
	 * produces are as deterministic as the artifact.
	 */
	private materialiseEntities(): void {
		for (const extension of sortById(this.snapshot.extensions)) {
			if (extension.enabled) {
				this.extensionNode(extension);
			}
		}
		for (const box of sortById(this.snapshot.voicemailBoxes)) {
			if (box.enabled) {
				this.voicemailNode(box, "leave");
				this.voicemailNode(box, "check");
			}
		}
		for (const group of sortById(this.snapshot.ringGroups)) {
			if (group.enabled) {
				this.ringGroupNode(group);
			}
		}
		for (const menu of sortById(this.snapshot.ivrMenus)) {
			if (menu.enabled) {
				this.ivrNode(menu);
			}
		}
		for (const entry of sortById(this.snapshot.queues)) {
			if (entry.enabled) {
				this.queueNode(entry);
			}
		}
		for (const room of sortById(this.snapshot.conferences)) {
			if (room.enabled) {
				this.conferenceNode(room);
			}
		}
		for (const lot of sortById(this.snapshot.parkLots)) {
			if (lot.enabled) {
				this.parkNode(lot);
			}
		}
		for (const group of sortById(this.snapshot.pagingGroups ?? [])) {
			if (group.enabled) {
				this.pagingGroupNode(group);
			}
		}
		for (const condition of sortById(this.snapshot.timeConditions)) {
			if (condition.enabled) {
				this.timeConditionNodeById(
					condition.id,
					{ kind: "time-condition", id: condition.id, name: condition.name },
					"destination",
				);
			}
		}
		for (const flow of sortById(this.snapshot.callFlows ?? [])) {
			if (flow.enabled) {
				this.callFlowNode(flow);
			}
		}
		for (const stream of sortById(this.snapshot.audioStreams ?? [])) {
			if (stream.enabled) {
				this.streamNode(stream);
			}
		}
		for (const directory of sortById(this.snapshot.directories ?? [])) {
			if (directory.enabled) {
				this.dialByNameNode(directory);
			}
		}
		// Aliases LAST among the entity passes, and only to validate them: an alias emits no node, so
		// this walk exists purely so a dangling or looping alias that nothing points at is still
		// reported. Half-built configuration is the normal state of an admin UI.
		for (const alias of sortById(this.snapshot.destinationAliases ?? [])) {
			if (alias.enabled) {
				this.aliasNode(
					alias.id,
					{ kind: "destination-alias", id: alias.id, name: alias.name },
					"destination",
				);
			}
		}
	}

	private hangupNode(cause: HangupCause): PlanNodeId {
		const id = `hangup:${cause}`;
		if (!this.claimed.has(id)) {
			this.claimed.add(id);
			this.nodes.set(id, { id, kind: "hangup", cause });
		}
		return id;
	}

	/**
	 * Resolves one destination trio to a plan node, or `null` when it cannot be resolved.
	 *
	 * `null` is not a failure the caller can ignore — a diagnostic has already been recorded — but
	 * it does let the caller decide the fallback: an inbound route with a dangling destination is
	 * an error, while an optional `timeoutDestination` that is unset is simply absent.
	 */
	private destinationNode(
		destination: Destination | null,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		if (destination === null) {
			return null;
		}
		if (!isDestinationType(destination.destinationType)) {
			this.bag.error(
				"unknown-destination-type",
				`Destination type ${JSON.stringify(destination.destinationType)} is not a routing destination.`,
				subject,
				path,
			);
			return null;
		}
		const shapeIssues = destinationShapeIssues(destination);
		if (shapeIssues.length > 0) {
			this.bag.error(
				"invalid-destination-shape",
				`Destination of type "${destination.destinationType}" is malformed (${shapeIssues.join(", ")}).`,
				subject,
				path,
			);
			return null;
		}

		const ref = destination.destinationRef ?? "";
		switch (destination.destinationType) {
			case "extension": {
				return this.extensionNodeById(ref, subject, path);
			}
			case "ivr": {
				return this.ivrNodeById(ref, subject, path);
			}
			case "ring-group": {
				return this.ringGroupNodeById(ref, subject, path);
			}
			case "queue": {
				// The only entity destination whose DATA changes the node it resolves to. See
				// `queuePriorityOverride` for why, and for why the answer is a distinct node rather
				// than a field the walk carries.
				return this.queueNodeById(ref, destination, subject, path);
			}
			case "voicemail": {
				return this.voicemailNodeById(ref, "leave", subject, path);
			}
			case "conference": {
				return this.conferenceNodeById(ref, subject, path);
			}
			case "park": {
				return this.parkNodeById(ref, subject, path);
			}
			case "paging-group": {
				return this.pagingGroupNodeById(ref, subject, path);
			}
			case "time-condition": {
				return this.timeConditionNodeById(ref, subject, path);
			}
			case "call-flow": {
				return this.callFlowNodeById(ref, subject, path);
			}
			case "stream": {
				return this.streamNodeById(ref, subject, path);
			}
			case "dial-by-name": {
				return this.dialByNameNodeById(ref, subject, path);
			}
			case "alias": {
				return this.aliasNode(ref, subject, path);
			}
			case "external": {
				return this.externalNode(destination.destinationData?.value ?? "", true);
			}
			case "application": {
				return this.applicationNode(
					destination.destinationData?.value ?? "",
					destination.destinationData?.args,
				);
			}
			default: {
				const cause = destination.destinationData?.cause;
				if (cause !== undefined && !isHangupCause(cause as HangupCause)) {
					this.bag.error(
						"invalid-destination-shape",
						`Hangup destination names an unknown cause "${cause}".`,
						subject,
						path,
					);
					return null;
				}
				return this.hangupNode((cause as HangupCause | undefined) ?? "NORMAL_CLEARING");
			}
		}
	}

	private missingTarget(kind: string, ref: string, subject: DiagnosticSubject, path: string): null {
		this.bag.error(
			"dangling-destination",
			`Destination points at ${kind} "${ref}", which is not in this organization's configuration.`,
			subject,
			path,
		);
		return null;
	}

	private disabledTarget(
		kind: string,
		name: string,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId {
		this.bag.warning(
			"disabled-entity",
			`Destination points at ${kind} "${name}", which is disabled; calls reaching it are released.`,
			subject,
			path,
		);
		return this.hangupNode(DISABLED_TARGET_CAUSE);
	}

	private extensionNodeById(
		ref: string,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const extension = this.extensionsById.get(ref);
		if (extension === undefined) {
			return this.missingTarget("extension", ref, subject, path);
		}
		if (!extension.enabled) {
			return this.disabledTarget("extension", extension.number, subject, path);
		}
		return this.extensionNode(extension);
	}

	private extensionNode(extension: ExtensionInput): PlanNodeId {
		const id = `extension:${extension.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);

		const subject: DiagnosticSubject = {
			kind: "extension",
			id: extension.id,
			name: extension.number,
		};
		const voicemailNodeId = this.extensionVoicemailNode(extension, subject);

		const node: PlanNode = compact({
			id,
			kind: "extension",
			label: extension.label,
			extensionId: extension.id,
			number: extension.number,
			callerIdName: extension.callerIdName ?? undefined,
			callerIdNumber: extension.callerIdNumber ?? undefined,
			tollClass: extension.tollClass,
			recordPolicy: extension.recordPolicy,
			timeoutSeconds: extension.callTimeoutSeconds,
			doNotDisturb: extension.doNotDisturb,
			pickupGroup: pickupGroupOf(extension),
			// `compact` drops `undefined`, so an extension that has not asked for screening carries no
			// key at all — which is what makes the field's absence and `false` the same artifact, and
			// therefore what keeps the hash stable across a loader that learns to select the column.
			callScreening: extension.callScreening ?? undefined,
			mohClassId: extension.mohClassId ?? undefined,
			mohClass: this.mohClassName(extension.mohClassId, subject, "mohClassId"),
			forwardAllNodeId: extension.forwardAllEnabled
				? this.forwardNode(extension.forwardAllDestination, subject, "forwardAllDestination")
				: undefined,
			busyNodeId:
				(extension.forwardBusyEnabled
					? this.forwardNode(extension.forwardBusyDestination, subject, "forwardBusyDestination")
					: undefined) ??
				voicemailNodeId ??
				this.hangupNode("USER_BUSY"),
			noAnswerNodeId:
				(extension.forwardNoAnswerEnabled
					? this.forwardNode(
							extension.forwardNoAnswerDestination,
							subject,
							"forwardNoAnswerDestination",
						)
					: undefined) ??
				voicemailNodeId ??
				this.hangupNode("NO_ANSWER"),
			notRegisteredNodeId:
				(extension.forwardUnregisteredEnabled
					? this.forwardNode(
							extension.forwardUnregisteredDestination,
							subject,
							"forwardUnregisteredDestination",
						)
					: undefined) ??
				voicemailNodeId ??
				this.hangupNode("USER_NOT_REGISTERED"),
		}) as PlanNode;

		this.nodes.set(id, node);
		return id;
	}

	private extensionVoicemailNode(
		extension: ExtensionInput,
		subject: DiagnosticSubject,
	): PlanNodeId | undefined {
		if (!extension.voicemailEnabled) {
			return undefined;
		}
		const box = this.voicemailByExtension.get(extension.id);
		if (box === undefined) {
			this.bag.warning(
				"missing-voicemail-box",
				`Extension ${extension.number} has voicemail enabled but no mailbox; unanswered calls are released instead.`,
				subject,
				"voicemailEnabled",
			);
			return undefined;
		}
		return this.voicemailNode(box, "leave");
	}

	/**
	 * Resolves a free-text forward destination.
	 *
	 * The extension schema stores forwarding targets as plain dial strings, not destination trios,
	 * because that is what a user types on a phone. An internal number wins over an external one so
	 * that forwarding to a colleague stays inside the PBX — and, more importantly, does not consume
	 * a trunk channel or present the caller's number to a carrier.
	 */
	private forwardNode(
		destination: string | null | undefined,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | undefined {
		const target = (destination ?? "").trim();
		if (target.length === 0) {
			this.bag.warning(
				"unresolvable-forward",
				"Forwarding is enabled but no destination is set; the forward is ignored.",
				subject,
				path,
			);
			return undefined;
		}
		const internal = this.extensionsByNumber.get(target);
		if (internal !== undefined) {
			return this.extensionNode(internal);
		}
		return this.externalNode(target, true);
	}

	// -------------------------------------------------------------------------------------------
	// Follow-me
	// -------------------------------------------------------------------------------------------

	/**
	 * Attaches each enabled extension's follow-me ladder to its already-compiled node.
	 *
	 * # Why this is a pass and not part of `extensionNode`
	 *
	 * A hop to a number outside the organization has to pick a trunk, and the only honest way to
	 * pick one is the tenant's own outbound match table — the same rules, the same toll-class gate
	 * and the same call-block screen a user pressing those digits on their desk phone would meet.
	 * That table is compiled after the entity nodes are, so the ladder is resolved here, once both
	 * exist, rather than duplicating trunk selection inside the extension node.
	 *
	 * # The toll-fraud boundary
	 *
	 * A follow-me destination is written by an extension's own user and is validated at write time,
	 * but "validated" is not "authorised": an extension that may not dial internationally must not
	 * acquire that ability by typing the number into a forwarding box instead of a keypad. So the
	 * hop is matched against `outbound.rules` in the artifact's own priority order, refused when
	 * `tollClassCovers` says the extension does not hold the route's class, refused when the
	 * organization's outbound kill switch is off, and refused when a call-block rule names it. A
	 * refused hop keeps its place in the ladder with no `targetNodeId`, which the engine skips and
	 * the inspector can explain.
	 *
	 * # Degradation
	 *
	 * A ladder with nothing dialable in it is NOT attached. The extension then rings its own
	 * endpoint, which is what it did before follow-me was executed at all — strictly better than a
	 * caller hearing silence because every hop was refused.
	 */
	private compileFollowMe(
		outbound: OutboundMatchTable,
		callBlock: readonly CompiledCallBlockRule[],
	): void {
		for (const extension of sortById(this.snapshot.extensions)) {
			if (!extension.enabled) {
				continue;
			}
			const config = extension.followMe ?? undefined;
			if (config === undefined || config.enabled !== true) {
				continue;
			}
			const node = this.nodes.get(`extension:${extension.id}`);
			if (node === undefined || node.kind !== "extension") {
				continue;
			}
			const subject: DiagnosticSubject = {
				kind: "extension",
				id: extension.id,
				name: extension.number,
			};

			const destinations: FollowMeDestination[] = [];
			for (const [index, target] of (config.targets ?? []).entries()) {
				const hop = this.followMeDestination(
					extension,
					target,
					index,
					outbound,
					callBlock,
					subject,
				);
				if (hop !== undefined) {
					destinations.push(hop);
				}
			}

			if (!destinations.some((hop) => hop.targetNodeId !== undefined)) {
				this.bag.warning(
					"empty-follow-me",
					`Extension ${extension.number} has follow-me switched on but no hop that can be dialled; the extension rings its own endpoint instead.`,
					subject,
					"followMe.targets",
				);
				continue;
			}

			const followMe: FollowMePlan = {
				// Derived, because `pbx-db` has no strategy column — see `FollowMePlan.strategy`.
				strategy: destinations.every((hop) => hop.delaySeconds === 0)
					? "simultaneous"
					: "sequential",
				ignoreBusy: config.ignoreBusy === true,
				destinations,
			};
			this.nodes.set(node.id, compact({ ...node, followMe }) as ExtensionPlanNode);
		}
	}

	/** One hop, resolved. `undefined` means the hop is not worth carrying at all. */
	private followMeDestination(
		extension: ExtensionInput,
		target: FollowMeTargetInput,
		index: number,
		outbound: OutboundMatchTable,
		callBlock: readonly CompiledCallBlockRule[],
		subject: DiagnosticSubject,
	): FollowMeDestination | undefined {
		const path = `followMe.targets[${String(index)}]`;
		const dialString = (target.destination ?? "").trim();
		if (dialString.length === 0) {
			this.bag.warning(
				"unresolvable-follow-me",
				`Follow-me hop ${String(index + 1)} of extension ${extension.number} has no destination; it was dropped from the ladder.`,
				subject,
				path,
			);
			return undefined;
		}

		const hop: FollowMeDestination = {
			ordinal: index,
			destination: dialString,
			delaySeconds: wholeSeconds(target.delaySeconds),
			timeoutSeconds: wholeSeconds(target.timeoutSeconds),
			confirmRequired: target.confirm === true,
		};

		// An internal number wins, for the same reason it wins for forwarding: it stays inside the
		// PBX, consumes no trunk channel and presents the caller to a colleague rather than a carrier.
		const internal = this.extensionsByNumber.get(dialString);
		if (internal !== undefined) {
			return { ...hop, targetNodeId: this.extensionNode(internal) };
		}

		const external = this.followMeTrunkTarget(
			extension,
			dialString,
			outbound,
			callBlock,
			subject,
			path,
		);
		return external === undefined
			? hop
			: { ...hop, targetNodeId: external.nodeId, dialedNumber: external.dialedNumber };
	}

	/**
	 * The trunk chain an off-net hop takes, chosen by the tenant's own outbound rules.
	 *
	 * Deliberately NOT `resolveOutbound`: that function answers "what should happen to this call",
	 * which includes the emergency table and time gates, and neither belongs here. A follow-me hop
	 * is never an emergency call, and a time gate is a fact about when the call arrives that a
	 * compiler must not read a clock to evaluate. What is shared is everything that decides whether
	 * the hop may be dialled at all — the rule order, the toll-class gate, the digit manipulation
	 * and the call-block screen — because those are the fraud boundary.
	 */
	private followMeTrunkTarget(
		extension: ExtensionInput,
		dialString: string,
		outbound: OutboundMatchTable,
		callBlock: readonly CompiledCallBlockRule[],
		subject: DiagnosticSubject,
		path: string,
	): { readonly nodeId: PlanNodeId; readonly dialedNumber: string } | undefined {
		if (!outbound.enabled) {
			this.bag.warning(
				"unresolvable-follow-me",
				`Follow-me hop "${dialString}" of extension ${extension.number} leaves the organization, whose outbound calling is switched off; the hop is not dialled.`,
				subject,
				path,
			);
			return undefined;
		}

		const blocked = checkCallBlock(callBlock, dialString, "outbound");
		if (blocked !== null && blocked.action !== "allow") {
			this.bag.warning(
				"unresolvable-follow-me",
				`Follow-me hop "${dialString}" of extension ${extension.number} matches call-block rule "${blocked.label ?? blocked.id}" (${blocked.action}); the hop is not dialled.`,
				subject,
				path,
			);
			return undefined;
		}

		let denied = false;
		for (const rule of outbound.rules) {
			if (!rule.patterns.some((pattern) => matchPattern(pattern, dialString) !== null)) {
				continue;
			}
			if (!tollClassCovers(extension.tollClass, rule.tollClass)) {
				denied = true;
				continue;
			}
			const dialedNumber = applyDigitManipulation(
				{ stripDigits: rule.stripDigits, prependDigits: rule.prependDigits ?? null },
				dialString,
			);
			if (dialedNumber === null) {
				continue;
			}
			return { nodeId: rule.destinationNodeId, dialedNumber };
		}

		this.bag.warning(
			"unresolvable-follow-me",
			denied
				? `Follow-me hop "${dialString}" of extension ${extension.number} only matches outbound routes above the extension's toll class ("${extension.tollClass}"); the hop is not dialled.`
				: `Follow-me hop "${dialString}" of extension ${extension.number} matches no outbound route; the hop is not dialled.`,
			subject,
			path,
		);
		return undefined;
	}

	private ivrNodeById(ref: string, subject: DiagnosticSubject, path: string): PlanNodeId | null {
		const menu = this.ivrMenusById.get(ref);
		if (menu === undefined) {
			return this.missingTarget("IVR menu", ref, subject, path);
		}
		if (!menu.enabled) {
			return this.disabledTarget("IVR menu", menu.name, subject, path);
		}
		return this.ivrNode(menu);
	}

	private ivrNode(menu: OrgRoutingSnapshot["ivrMenus"][number]): PlanNodeId {
		const id = `ivr-menu:${menu.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);

		const subject: DiagnosticSubject = { kind: "ivr-menu", id: menu.id, name: menu.name };
		const options = [];
		for (const option of this.ivrOptionsByMenu.get(menu.id) ?? []) {
			if (!option.enabled) {
				continue;
			}
			const optionSubject: DiagnosticSubject = {
				kind: "ivr-menu-option",
				id: option.id,
				name: option.matchValue,
			};
			const { pattern, issues } = compilePattern(
				option.matchKind === "digit" ? "exact" : "regex",
				option.matchValue,
			);
			let usable = true;
			for (const issue of issues) {
				if (issue.code === "unanchored-regex") {
					this.bag.warning(
						"unanchored-regex",
						`IVR option "${option.matchValue}" is an unanchored regex; it may match more digits than intended.`,
						optionSubject,
						"matchValue",
					);
					continue;
				}
				usable = false;
				this.bag.error(
					issue.code === "invalid-regex" ? "invalid-regex" : "invalid-pattern",
					`IVR option "${option.matchValue}" is not a usable pattern (${issue.code}).`,
					optionSubject,
					"matchValue",
				);
			}
			if (!usable) {
				continue;
			}
			const targetNodeId = this.destinationNode(
				{
					destinationType: option.destinationType,
					destinationRef: option.destinationRef,
					destinationData: option.destinationData,
				},
				optionSubject,
				"destination",
			);
			if (targetNodeId === null) {
				continue;
			}
			if (targetNodeId === id) {
				this.bag.error(
					"self-referencing-ivr",
					`IVR menu "${menu.name}" has an option that points back at the same menu, which would loop without ever playing a prompt.`,
					optionSubject,
					"destination",
				);
				continue;
			}
			options.push(
				compact({
					ordinal: option.ordinal,
					pattern,
					matchValue: option.matchValue,
					label: option.label ?? undefined,
					targetNodeId,
				}),
			);
		}

		const timeoutNodeId = this.namedDestinationNode(menu, "timeout", subject);
		const invalidNodeId = this.namedDestinationNode(menu, "invalid", subject);
		for (const [branch, nodeId] of [
			["timeout", timeoutNodeId],
			["invalid", invalidNodeId],
		] as const) {
			if (nodeId === id) {
				this.bag.error(
					"self-referencing-ivr",
					`IVR menu "${menu.name}" sends its ${branch} branch back to itself, which cannot terminate.`,
					subject,
					`${branch}Destination`,
				);
			}
		}

		const node: PlanNode = compact({
			id,
			kind: "ivr-menu",
			label: menu.name,
			ivrMenuId: menu.id,
			greetingPromptId: menu.greetingPromptId ?? undefined,
			shortGreetingPromptId: menu.shortGreetingPromptId ?? undefined,
			invalidPromptId: menu.invalidPromptId ?? undefined,
			timeoutPromptId: menu.timeoutPromptId ?? undefined,
			digitTimeoutMs: menu.digitTimeoutMs,
			interDigitTimeoutMs: menu.interDigitTimeoutMs,
			maxDigits: menu.maxDigits,
			maxFailures: menu.maxFailures,
			maxTimeouts: menu.maxTimeouts,
			directDialEnabled: menu.directDialEnabled,
			options,
			timeoutNodeId: timeoutNodeId === id ? undefined : (timeoutNodeId ?? undefined),
			invalidNodeId: invalidNodeId === id ? undefined : (invalidNodeId ?? undefined),
		}) as PlanNode;

		this.nodes.set(id, node);
		return id;
	}

	private ringGroupNodeById(
		ref: string,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const group = this.ringGroupsById.get(ref);
		if (group === undefined) {
			return this.missingTarget("ring group", ref, subject, path);
		}
		if (!group.enabled) {
			return this.disabledTarget("ring group", group.name, subject, path);
		}
		return this.ringGroupNode(group);
	}

	private ringGroupNode(group: OrgRoutingSnapshot["ringGroups"][number]): PlanNodeId {
		const id = `ring-group:${group.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);

		const subject: DiagnosticSubject = { kind: "ring-group", id: group.id, name: group.name };
		const members: RingGroupMember[] = [];
		for (const member of this.ringMembersByGroup.get(group.id) ?? []) {
			if (!member.enabled) {
				continue;
			}
			const targetNodeId = this.destinationNode(
				{
					destinationType: member.destinationType,
					destinationRef: member.destinationRef,
					destinationData: member.destinationData,
				},
				{ kind: "ring-group-destination", id: member.id },
				"destination",
			);
			if (targetNodeId === null) {
				continue;
			}
			members.push({
				ordinal: member.ordinal,
				// A simultaneous group rings everything at once; a stored delay there is a leftover
				// from switching strategy, and honouring it would silently make the group sequential.
				delaySeconds: group.strategy === "simultaneous" ? 0 : member.delaySeconds,
				timeoutSeconds: member.timeoutSeconds,
				confirmRequired: member.confirmRequired || group.confirmEnabled,
				targetNodeId,
			});
		}

		if (members.length === 0) {
			this.bag.warning(
				"empty-ring-group",
				`Ring group "${group.name}" has no enabled destinations; calls to it go straight to its timeout branch.`,
				subject,
			);
		}

		const node: PlanNode = compact({
			id,
			kind: "ring-group",
			label: group.name,
			ringGroupId: group.id,
			strategy: group.strategy,
			ringTimeoutSeconds: group.ringTimeoutSeconds,
			ignoreBusy: group.ignoreBusy,
			confirmEnabled: group.confirmEnabled,
			confirmPromptId: group.confirmPromptId ?? undefined,
			callerIdNamePrefix: group.callerIdNamePrefix ?? undefined,
			mohClassId: group.mohClassId ?? undefined,
			mohClass: this.mohClassName(group.mohClassId, subject, "mohClassId"),
			ringbackPromptId: group.ringbackPromptId ?? undefined,
			members,
			timeoutNodeId: this.namedDestinationNode(group, "timeout", subject) ?? undefined,
		}) as PlanNode;

		this.nodes.set(id, node);
		return id;
	}

	private queueNodeById(
		ref: string,
		from: Destination | null,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const entry = this.queuesById.get(ref);
		if (entry === undefined) {
			return this.missingTarget("queue", ref, subject, path);
		}
		if (!entry.enabled) {
			return this.disabledTarget("queue", entry.name, subject, path);
		}
		return this.queueNode(entry, this.queuePriorityOverride(from, entry, subject, path));
	}

	/**
	 * The per-entry caller priority a `queue` destination may carry, as
	 * `destination_data.args.priority`.
	 *
	 * ## Why `args` and not a column
	 *
	 * Because the fact belongs to the EDGE, not to either end of it. "Platinum customers reach
	 * Support at priority 800" is a property of the IVR option, and it is different from what the
	 * same option means when it points at the same queue from the after-hours menu. A column on
	 * `queue` could only say one thing for the whole queue (which is `default_priority`, and it is
	 * there), and a column on `ivr_menu_option` would have to be repeated on every other table that
	 * can point at a queue — inbound routes, time conditions, call flows, ring-group failovers.
	 * `destination_data` is the one place every one of those already has.
	 *
	 * ## Why an out-of-range value is a WARNING and not an error
	 *
	 * A malformed priority is a caller who waits their turn instead of jumping the line. That is the
	 * queue working normally, which is a very different cost from refusing to compile the tenant's
	 * whole artifact — and refusing would take every unrelated route down with it. The warning names
	 * the value so the form that produced it can be fixed; the call still gets answered meanwhile.
	 */
	private queuePriorityOverride(
		from: Destination | null,
		entry: OrgRoutingSnapshot["queues"][number],
		subject: DiagnosticSubject,
		path: string,
	): number | undefined {
		const raw = from?.destinationData?.args?.priority;
		if (raw === undefined) {
			return undefined;
		}
		const value = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isInteger(value) || value < QUEUE_PRIORITY_MIN || value > QUEUE_PRIORITY_MAX) {
			this.bag.warning(
				"invalid-queue-priority",
				`Queue "${entry.name}" was pointed at with a caller priority of ${JSON.stringify(raw)}, which is not a whole number between ${String(QUEUE_PRIORITY_MIN)} and ${String(QUEUE_PRIORITY_MAX)}. Callers arriving this way take the queue's default priority instead.`,
				subject,
				path,
			);
			return undefined;
		}
		return value;
	}

	/**
	 * One queue, at one entry priority.
	 *
	 * ## Why the priority is in the node ID
	 *
	 * The node table is deduplicated by id, so two references to one queue must produce one node —
	 * otherwise the artifact grows a node per reference and "every reference resolves" stops meaning
	 * anything. But two references at DIFFERENT priorities are genuinely different behaviour, and
	 * collapsing them would silently make the second one's priority disappear. Folding the override
	 * into the id gives both properties: same override, same node; different override, different
	 * node; and the id is still a pure function of its inputs, so a recompile of an unchanged
	 * snapshot produces the same artifact hash.
	 *
	 * Every node minted this way carries the same `queueId`, which is what keeps them one queue
	 * everywhere it matters — one roster, one waiting line, one set of events. A priority that
	 * produced a second QUEUE rather than a second door into it would not be a priority at all.
	 */
	private queueNode(
		entry: OrgRoutingSnapshot["queues"][number],
		priorityOverride?: number,
	): PlanNodeId {
		const priority = priorityOverride ?? entry.defaultPriority ?? QUEUE_PRIORITY_MIN;
		const id =
			priorityOverride === undefined
				? `queue:${entry.id}`
				: `queue:${entry.id}:p${String(priorityOverride)}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);
		const subject: DiagnosticSubject = { kind: "queue", id: entry.id, name: entry.name };
		const exitNodeId = this.namedDestinationNode(entry, "exit", subject) ?? undefined;
		const exitKey = normalizeExitKey(entry.exitKey);
		if (exitKey !== undefined && exitNodeId === undefined) {
			this.bag.warning(
				"queue-exit-key-without-destination",
				`Queue "${entry.name}" has exit key "${exitKey}" but no exit destination, so a caller who presses it is hung up rather than sent anywhere.`,
				subject,
				"exitKey",
			);
		}
		const node: PlanNode = compact({
			id,
			kind: "queue",
			label: entry.name,
			queueId: entry.id,
			strategy: entry.strategy,
			mohClassId: entry.mohClassId ?? undefined,
			mohClass: this.mohClassName(entry.mohClassId, subject, "mohClassId"),
			greetingPromptId: entry.greetingPromptId ?? undefined,
			announcePromptId: entry.announcePromptId ?? undefined,
			// Carried as an id, exactly like the two prompts above it: a prompt is addressed by row id
			// the whole way down, and only `mohClass` needs resolving because only a media server
			// insists on the NAME.
			agentWhisperPromptId: entry.agentWhisperPromptId ?? undefined,
			maxWaitSeconds: entry.maxWaitSeconds,
			maxWaitNoAgentSeconds: entry.maxWaitNoAgentSeconds,
			announcePositionEnabled: entry.announcePositionEnabled,
			announceFrequencySeconds: entry.announceFrequencySeconds,
			recordPolicy: entry.recordPolicy ?? "none",
			exitKey,
			exitNodeId,
			priority,
			abandonedResumeAllowed: entry.abandonedResumeAllowed ?? false,
			discardAbandonedAfterSeconds: entry.discardAbandonedAfterSeconds ?? 0,
			timeoutNodeId: this.namedDestinationNode(entry, "timeout", subject) ?? undefined,
		}) as PlanNode;
		this.nodes.set(id, node);
		return id;
	}

	private voicemailNodeById(
		ref: string,
		mode: "leave" | "check",
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const box = this.voicemailById.get(ref);
		if (box === undefined) {
			return this.missingTarget("voicemail box", ref, subject, path);
		}
		if (!box.enabled) {
			return this.disabledTarget("voicemail box", box.mailboxNumber, subject, path);
		}
		return this.voicemailNode(box, mode);
	}

	private voicemailNode(
		box: OrgRoutingSnapshot["voicemailBoxes"][number],
		mode: "leave" | "check",
	): PlanNodeId {
		const id = `voicemail:${box.id}:${mode}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);
		const subject: DiagnosticSubject = {
			kind: "voicemail-box",
			id: box.id,
			name: box.mailboxNumber,
		};
		// Only `leave` plays a greeting. A `check` opens the mailbox for its owner, and playing them
		// their own "I am not at my desk" recording on the way in would be theatre.
		const greeting = mode === "leave" ? this.activeLeaveGreeting(box.id) : undefined;
		this.nodes.set(
			id,
			compact({
				id,
				kind: "voicemail",
				label: box.label ?? box.mailboxNumber,
				voicemailBoxId: box.id,
				mailboxNumber: box.mailboxNumber,
				mode,
				maxMessageSeconds: box.maxMessageSeconds,
				mwiEnabled: box.mwiEnabled,
				greetingMedia: greeting === undefined ? undefined : objectMediaRef(greeting.objectKey),
				greetingKind: greeting?.kind,
				pinHash: this.voicemailPinHash(box, subject),
			}) as PlanNode,
		);
		return id;
	}

	/**
	 * The greeting a caller about to record hears, by {@link VOICEMAIL_LEAVE_GREETING_PRECEDENCE}.
	 *
	 * A box with no active greeting is the normal state — most mailboxes are never personalised —
	 * so its absence is not a diagnostic. The engine falls back to its deployment-wide announcement,
	 * which is exactly what it did before greetings were compiled at all.
	 */
	private activeLeaveGreeting(voicemailBoxId: string): VoicemailGreetingInput | undefined {
		for (const kind of VOICEMAIL_LEAVE_GREETING_PRECEDENCE) {
			const greeting = this.activeGreetings.get(greetingKey(voicemailBoxId, kind));
			if (greeting !== undefined && greeting.objectKey.trim().length > 0) {
				return greeting;
			}
		}
		return undefined;
	}

	/**
	 * The box's PIN digest, if it is one.
	 *
	 * A digest this compiler cannot parse is *not* embedded, and the mailbox therefore keeps the
	 * authentication it had before — see the long note in `voicemail-pin.ts` for why that is a
	 * warning rather than an error or a silent pass.
	 */
	private voicemailPinHash(
		box: OrgRoutingSnapshot["voicemailBoxes"][number],
		subject: DiagnosticSubject,
	): string | undefined {
		const raw = box.pinHash ?? undefined;
		if (raw === undefined || raw.trim() === "") {
			return undefined;
		}
		const issue = voicemailPinHashIssue(raw);
		if (issue !== undefined) {
			this.bag.warning(
				"invalid-pin-hash",
				`Mailbox ${box.mailboxNumber} has a PIN digest this release cannot read (${issue}); the PIN is NOT enforced and the mailbox falls back to authenticating by the calling extension.`,
				subject,
				"pinHash",
			);
			return undefined;
		}
		return raw.trim();
	}

	/**
	 * Indexes the active greetings, one per (box, kind).
	 *
	 * `pbx-db` enforces that uniqueness with a partial unique index, so a second active row for a
	 * pair cannot exist in a healthy database — but the snapshot is data, not a database, and a
	 * compiler that assumed the constraint would produce a different artifact depending on which
	 * row the loader happened to return first. Sorting by id and keeping the FIRST makes the choice
	 * deterministic whatever arrives.
	 */

	// -------------------------------------------------------------------------------------------
	// The T2 admin block
	// -------------------------------------------------------------------------------------------

	/**
	 * Compiles the reusable rewrite pipelines, once, before anything can point at one.
	 *
	 * A ruleset with no usable rules is still compiled — as an empty pipeline — rather than dropped,
	 * because a route that names it must not fall back to "no normalisation at all" silently. An
	 * empty pipeline is a no-op the tenant can see in the artifact; a missing ruleset is a dangling
	 * reference the compiler reports.
	 */
	private compileTranslationRulesets(): void {
		for (const ruleset of sortById(this.snapshot.translationRulesets ?? [])) {
			const rules: CompiledTranslationRule[] = [];
			for (const rule of this.translationRulesByRuleset.get(ruleset.id) ?? []) {
				if (!rule.enabled) {
					continue;
				}
				const issues = validateTranslationRule(rule);
				if (issues.length > 0) {
					for (const issue of issues) {
						this.bag.error(
							"invalid-translation-rule",
							issue.code === "unsafe-replacement"
								? `Rule ${rule.ordinal} of ruleset "${ruleset.name}" has a replacement that could emit characters a dial string may not contain (${JSON.stringify(issue.value)}); only digits, +, * and # plus $n back-references are allowed.`
								: `Rule ${rule.ordinal} of ruleset "${ruleset.name}" is not usable (${issue.code}).`,
							{ kind: "translation-rule", id: rule.id },
							issue.code === "unsafe-replacement" ? "replacement" : "matchPattern",
						);
					}
					continue;
				}
				rules.push(
					compact({
						id: rule.id,
						ordinal: rule.ordinal,
						label: rule.label ?? undefined,
						source: rule.matchPattern,
						replacement: rule.replacement,
					}) as CompiledTranslationRule,
				);
			}
			this.translationRulesetsById.set(ruleset.id, {
				id: ruleset.id,
				name: ruleset.name,
				rules,
			});
		}
	}

	/**
	 * A ruleset reference, resolved.
	 *
	 * A dangling or disabled ruleset is a WARNING and not an error, for the reason a dangling
	 * music-on-hold class is: the call still completes, it simply goes out with the digits the caller
	 * dialed. Refusing to compile a tenant's whole routing because somebody deleted a normalisation
	 * would take working calls down to fix cosmetics on the wire.
	 */
	private translationRuleset(
		rulesetId: string | null | undefined,
		subject: DiagnosticSubject,
		path: string,
	): CompiledTranslationRuleset | undefined {
		const id = rulesetId ?? undefined;
		if (id === undefined || id.trim() === "") {
			return undefined;
		}
		if (this.snapshot.translationRulesets === undefined) {
			// A loader that does not yet select the collection is a rollout state, not a dangling
			// reference — the same rule `mohClassName` applies.
			return undefined;
		}
		const compiled = this.translationRulesetsById.get(id);
		const input = (this.snapshot.translationRulesets ?? []).find((entry) => entry.id === id);
		if (compiled === undefined || input === undefined) {
			this.bag.warning(
				"dangling-translation-ruleset",
				`Translation ruleset "${id}" is not in this snapshot; numbers are used as dialed.`,
				subject,
				path,
			);
			return undefined;
		}
		if (!input.enabled) {
			this.bag.warning(
				"dangling-translation-ruleset",
				`Translation ruleset "${input.name}" is disabled; numbers are used as dialed.`,
				subject,
				path,
			);
			return undefined;
		}
		return compiled;
	}

	/**
	 * Compiles every phrase into the artifact's lookup table.
	 *
	 * A phrase is a `prompt` row of kind `phrase`, so this walks the prompt collection rather than a
	 * table of its own — see `media-schema.ts` for why that is the shape.
	 *
	 * Two things are refused rather than tolerated. A step naming another PHRASE is an error: it
	 * would make the media layer recurse, and `phrases-schema.ts` argues that composition is
	 * expressible by listing the steps twice. A step naming a prompt that is not in the snapshot is
	 * dropped with a warning — that is the shape of a half-built phrase, which an admin UI produces
	 * on the way to a finished one.
	 *
	 * A phrase with no playable step is not written to the table at all, so a reader's MISS always
	 * means "play this id as a single file" and never "play nothing".
	 */
	private compilePhrases(): Readonly<Record<string, CompiledPhrase>> {
		const phrases: Record<string, CompiledPhrase> = {};
		for (const entry of sortById(this.snapshot.prompts ?? [])) {
			if (entry.kind !== "phrase" || !entry.enabled) {
				continue;
			}
			const subject: DiagnosticSubject = { kind: "phrase", id: entry.id, name: entry.name };
			const steps: string[] = [];
			for (const step of this.phraseStepsByPhrase.get(entry.id) ?? []) {
				if (!step.enabled) {
					continue;
				}
				const target = this.promptsById.get(step.promptId);
				if (target === undefined) {
					this.bag.warning(
						"dangling-phrase-step",
						`Step ${step.ordinal} of phrase "${entry.name}" names prompt "${step.promptId}", which is not in this snapshot; it was skipped.`,
						subject,
						`steps[${step.ordinal}]`,
					);
					continue;
				}
				if (target.kind === "phrase") {
					this.bag.error(
						"invalid-phrase",
						`Step ${step.ordinal} of phrase "${entry.name}" names another phrase ("${target.name}"). Phrases do not nest; list the steps directly.`,
						subject,
						`steps[${step.ordinal}]`,
					);
					continue;
				}
				if (!target.enabled) {
					continue;
				}
				steps.push(step.promptId);
			}
			if (steps.length === 0) {
				this.bag.warning(
					"invalid-phrase",
					`Phrase "${entry.name}" has no playable steps; anything that names it falls back to the deployment's own announcement.`,
					subject,
				);
				continue;
			}
			phrases[entry.id] = { promptId: entry.id, name: entry.name, steps };
		}
		return sortRecordKeys(phrases);
	}

	private callFlowNodeById(
		ref: string,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const flow = this.callFlowsById.get(ref);
		if (flow === undefined) {
			return this.missingTarget("call flow", ref, subject, path);
		}
		if (!flow.enabled) {
			return this.disabledTarget("call flow", flow.name, subject, path);
		}
		return this.callFlowNode(flow);
	}

	/**
	 * A day/night switch.
	 *
	 * BOTH branches are compiled whatever the mode says, and `planNodeReferences` reports both, so
	 * the inactive one stays reachable. Emitting only the live branch would make flipping the switch
	 * a jump to a node that is not in the table, and would leave a call-flow inspector unable to show
	 * the tenant where the other position goes.
	 *
	 * A branch that does not resolve falls back to a hangup rather than dropping the node: a switch
	 * with one working position is still a switch, and a caller who reaches the broken side should be
	 * released with a cause rather than meeting an absent reference mid-call.
	 */
	private callFlowNode(flow: CallFlowInput): PlanNodeId {
		const id = `call-flow:${flow.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);

		const subject: DiagnosticSubject = { kind: "call-flow", id: flow.id, name: flow.name };
		const dayNodeId =
			this.destinationNode(
				{
					destinationType: flow.destinationType,
					destinationRef: flow.destinationRef,
					destinationData: flow.destinationData,
				},
				subject,
				"destination",
			) ?? this.hangupNode(DISABLED_TARGET_CAUSE);
		const nightNodeId =
			this.namedDestinationNode(flow, "night", subject) ?? this.hangupNode(DISABLED_TARGET_CAUSE);

		this.nodes.set(
			id,
			compact({
				id,
				kind: "call-flow",
				label: flow.name,
				callFlowId: flow.id,
				mode: flow.mode,
				dayNodeId,
				nightNodeId,
				featureCode: flow.featureCode ?? undefined,
				// The dialable string a BLF key is provisioned with. The code wins over the number:
				// upstream provisions the code, and a flow that has both is watched at the code.
				presenceKey: flow.featureCode ?? flow.extensionNumber ?? undefined,
			}) as PlanNode,
		);
		return id;
	}

	private streamNodeById(ref: string, subject: DiagnosticSubject, path: string): PlanNodeId | null {
		const stream = this.streamsById.get(ref);
		if (stream === undefined) {
			return this.missingTarget("audio stream", ref, subject, path);
		}
		if (!stream.enabled) {
			return this.disabledTarget("audio stream", stream.name, subject, path);
		}
		return this.streamNode(stream);
	}

	/**
	 * A remote audio source.
	 *
	 * The URL is re-checked here even though the DTO checked it, because the snapshot is DATA rather
	 * than a database: a compiler that assumed the edge had validated would hand a media server a
	 * `file:///etc/passwd` the moment anybody wrote a row by hand.
	 *
	 * The fallback is not optional — see `StreamPlanNode` — and a stream whose fallback does not
	 * resolve gets a hangup rather than no node, so a driver that cannot play the source releases the
	 * caller with a cause instead of leaving them on a silent line.
	 */
	private streamNode(stream: AudioStreamInput): PlanNodeId {
		const id = `stream:${stream.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);

		const subject: DiagnosticSubject = { kind: "audio-stream", id: stream.id, name: stream.name };
		if (!isPlayableStreamUrl(stream.url)) {
			this.bag.error(
				"invalid-stream-url",
				`Audio stream "${stream.name}" has URL ${JSON.stringify(stream.url)}, which is not an http(s) URL a media server may be asked to open.`,
				subject,
				"url",
			);
		}
		const fallbackNodeId =
			this.namedDestinationNode(stream, "fallback", subject) ??
			this.hangupNode(DISABLED_TARGET_CAUSE);

		this.nodes.set(
			id,
			compact({
				id,
				kind: "stream",
				label: stream.name,
				audioStreamId: stream.id,
				url: stream.url,
				answerFirst: stream.answerFirst,
				maxSeconds: stream.maxSeconds,
				fallbackNodeId,
			}) as PlanNode,
		);
		return id;
	}

	private dialByNameNodeById(
		ref: string,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const directory = this.directoriesById.get(ref);
		if (directory === undefined) {
			return this.missingTarget("dial-by-name directory", ref, subject, path);
		}
		if (!directory.enabled) {
			return this.disabledTarget("dial-by-name directory", directory.name, subject, path);
		}
		return this.dialByNameNode(directory);
	}

	/**
	 * The digit map, built from the tenant's extensions and their recorded names.
	 *
	 * # Why an extension can be missing from its own tenant's directory
	 *
	 * There is no text-to-speech here, so the ONLY way to say "for Jane Smith, press one" is to play
	 * the recording Jane made into her mailbox — the `name` greeting that `VOICEMAIL_GREETING_KINDS`
	 * has always had and that, until this feature, nothing consumed. An extension whose mailbox has no
	 * active `name` greeting therefore cannot be offered at all, and is dropped with a warning naming
	 * it. See `directory-schema.ts` for why the two alternatives — a silent gap, or spelling the name
	 * back letter by letter — are both worse.
	 *
	 * # The collision nobody would otherwise see
	 *
	 * Two people whose names map to the same digits produce a directory where a caller hears two
	 * options and has no way to know which is which. It has no runtime symptom, so it is reported
	 * here, where both entries are in hand.
	 */
	private dialByNameNode(directory: DialByNameDirectoryInput): PlanNodeId {
		const id = `dial-by-name:${directory.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);

		const subject: DiagnosticSubject = {
			kind: "dial-by-name-directory",
			id: directory.id,
			name: directory.name,
		};
		const entries: DirectoryEntry[] = [];
		const byDigits = new Map<string, string>();

		for (const extension of sortById(this.snapshot.extensions)) {
			if (!extension.enabled) {
				continue;
			}
			const digits = directoryDigits(extension.label, directory.searchField);
			if (digits.length === 0) {
				continue;
			}
			const box = this.voicemailByExtension.get(extension.id);
			const greeting =
				box === undefined ? undefined : this.activeGreetings.get(greetingKey(box.id, "name"));
			if (greeting === undefined || greeting.objectKey.trim().length === 0) {
				this.bag.warning(
					"directory-entry-skipped",
					`Extension ${extension.number} ("${extension.label}") is not offered by directory "${directory.name}": its mailbox has no recorded name, and there is no way to speak the name without one.`,
					subject,
					"entries",
				);
				continue;
			}
			const clash = byDigits.get(digits);
			if (clash !== undefined) {
				this.bag.warning(
					"directory-name-collision",
					`Extensions ${clash} and ${extension.number} spell to the same digits (${digits}) in directory "${directory.name}"; a caller cannot tell the two options apart.`,
					subject,
					"entries",
				);
			} else {
				byDigits.set(digits, extension.number);
			}
			entries.push({
				digits,
				extensionNumber: extension.number,
				targetNodeId: this.extensionNode(extension),
				nameMedia: objectMediaRef(greeting.objectKey),
				...(extension.label.length === 0 ? {} : { label: extension.label }),
			});
		}

		if (entries.length === 0) {
			this.bag.warning(
				"empty-directory",
				`Directory "${directory.name}" can offer nobody: no enabled extension has a recorded name in its mailbox.`,
				subject,
			);
		}

		entries.sort(
			(left, right) =>
				(left.digits < right.digits ? -1 : left.digits > right.digits ? 1 : 0) ||
				(left.extensionNumber < right.extensionNumber
					? -1
					: left.extensionNumber > right.extensionNumber
						? 1
						: 0),
		);

		this.nodes.set(
			id,
			compact({
				id,
				kind: "dial-by-name",
				label: directory.name,
				directoryId: directory.id,
				minDigits: directory.minDigits,
				maxFailures: directory.maxFailures,
				greetingPromptId: directory.greetingPromptId ?? undefined,
				invalidPromptId: directory.invalidPromptId ?? undefined,
				entries,
				timeoutNodeId: this.namedDestinationNode(directory, "timeout", subject) ?? undefined,
			}) as PlanNode,
		);
		return id;
	}

	/**
	 * Expands an alias to whatever its target resolved to.
	 *
	 * FLAT, which is the whole design: no `alias` node is ever written, so the artifact and the
	 * call-flow inspector both show the real destination and the engine gains no node kind. See
	 * `aliases-schema.ts` for why the feature is a macro rather than FusionPBX's raw dial string.
	 *
	 * The only thing flatness costs is this cycle guard. `claimed` cannot do the job — an alias
	 * claims no id — so the expansion stack is walked explicitly and a repeat is an ERROR rather than
	 * a warning: an alias that expands forever has no sound artifact to fall back to, which is
	 * exactly the line this compiler's header draws between the two severities.
	 */
	private aliasNode(ref: string, subject: DiagnosticSubject, path: string): PlanNodeId | null {
		const alias = this.aliasesById.get(ref);
		if (alias === undefined) {
			return this.missingTarget("destination alias", ref, subject, path);
		}
		if (!alias.enabled) {
			return this.disabledTarget("destination alias", alias.name, subject, path);
		}
		if (this.aliasStack.includes(alias.id)) {
			this.bag.error(
				"alias-cycle",
				`Destination alias "${alias.name}" is part of a loop (${[...this.aliasStack, alias.id].join(" -> ")}); an alias chain must end at a real destination.`,
				{ kind: "destination-alias", id: alias.id, name: alias.name },
				"destination",
			);
			return null;
		}
		if (this.aliasStack.length >= MAX_ALIAS_DEPTH) {
			this.bag.error(
				"alias-cycle",
				`Destination alias "${alias.name}" is nested more than ${String(MAX_ALIAS_DEPTH)} deep; the chain was not expanded.`,
				{ kind: "destination-alias", id: alias.id, name: alias.name },
				"destination",
			);
			return null;
		}

		this.aliasStack.push(alias.id);
		try {
			return this.destinationNode(
				{
					destinationType: alias.destinationType,
					destinationRef: alias.destinationRef,
					destinationData: alias.destinationData,
				},
				{ kind: "destination-alias", id: alias.id, name: alias.name },
				"destination",
			);
		} finally {
			this.aliasStack.pop();
		}
	}

	/**
	 * The authorisation-code gate for one outbound route.
	 *
	 * Fails OPEN with a warning in every degraded case — a set that is missing, disabled, or whose
	 * every digest this release cannot parse — and the reason is the same one `voicemailPinHash`
	 * gives: refusing every call on a route because a digest format changed takes the tenant's phones
	 * down to protect a gate they can re-create in a form. A set with SOME readable entries keeps
	 * those and drops the rest, so a single corrupt row narrows the code list rather than removing it.
	 */
	private compilePinSet(
		pinSetId: string | null | undefined,
		subject: DiagnosticSubject,
	): CompiledPinSet | undefined {
		const id = pinSetId ?? undefined;
		if (id === undefined || id.trim() === "") {
			return undefined;
		}
		if (this.snapshot.pinSets === undefined) {
			return undefined;
		}
		const set = this.pinSetsById.get(id);
		if (set === undefined) {
			this.bag.warning(
				"unusable-pin-set",
				`PIN set "${id}" is not in this snapshot; the route is NOT gated and calls go out unchallenged.`,
				subject,
				"pinSetId",
			);
			return undefined;
		}
		if (!set.enabled) {
			this.bag.warning(
				"unusable-pin-set",
				`PIN set "${set.name}" is disabled; the route is NOT gated and calls go out unchallenged.`,
				subject,
				"pinSetId",
			);
			return undefined;
		}

		const entries: CompiledPinEntry[] = [];
		for (const entry of this.pinEntriesBySet.get(set.id) ?? []) {
			if (!entry.enabled) {
				continue;
			}
			const issue = voicemailPinHashIssue(entry.pinHash);
			if (issue !== undefined) {
				this.bag.warning(
					"invalid-pin-hash",
					`Code ${entry.ordinal} of PIN set "${set.name}" has a digest this release cannot read (${issue}); that code will not be accepted.`,
					subject,
					"pinSetId",
				);
				continue;
			}
			entries.push(
				compact({
					pinSetEntryId: entry.id,
					ordinal: entry.ordinal,
					label: entry.label ?? undefined,
					pinHash: entry.pinHash.trim(),
				}) as CompiledPinEntry,
			);
		}

		if (entries.length === 0) {
			this.bag.warning(
				"unusable-pin-set",
				`PIN set "${set.name}" has no usable codes; the route is NOT gated and calls go out unchallenged.`,
				subject,
				"pinSetId",
			);
			return undefined;
		}

		return compact({
			pinSetId: set.id,
			name: set.name,
			maxAttempts: set.maxAttempts,
			digitTimeoutMs: set.digitTimeoutMs,
			promptId: set.promptId ?? undefined,
			failurePromptId: set.failurePromptId ?? undefined,
			entries,
		}) as CompiledPinSet;
	}

	/**
	 * Organization speed dials, and the two collisions that would otherwise be invisible.
	 *
	 * A code that a FEATURE CODE would swallow is dropped: `*0` is seeded as eavesdrop with a
	 * required argument, so an unguarded `*01` would be consumed as "eavesdrop on extension 1" and
	 * the tenant would see the wrong thing happen rather than nothing. A numeric code additionally
	 * goes through `claimNumber`, the same duplicate check every dialable entity uses, so a speed dial
	 * numbered `200` collides loudly with extension 200 instead of shadowing it.
	 */
	private compileSpeedDials(
		featureCodes: readonly CompiledFeatureCode[],
	): Readonly<Record<string, SpeedDialEntry>> {
		const entries: Record<string, SpeedDialEntry> = {};
		for (const dial of sortById(this.snapshot.speedDials ?? [])) {
			if (!dial.enabled) {
				continue;
			}
			const subject: DiagnosticSubject = { kind: "speed-dial", id: dial.id, name: dial.code };
			if (!SPEED_DIAL_CODE_PATTERN.test(dial.code)) {
				this.bag.error(
					"conflicting-speed-dial",
					`Speed dial "${dial.code}" is not dialable; a code is one to ten characters from 0-9, *, #.`,
					subject,
					"code",
				);
				continue;
			}
			const clash = featureCodes.find(
				(code) =>
					code.code === dial.code ||
					(code.argumentMode !== "none" && dial.code.startsWith(code.code)),
			);
			if (clash !== undefined) {
				this.bag.error(
					"conflicting-speed-dial",
					`Speed dial "${dial.code}" can never be dialed: feature code "${clash.code}" is matched first and would consume it.`,
					subject,
					"code",
				);
				continue;
			}
			if (entries[dial.code] !== undefined) {
				this.bag.error(
					"conflicting-speed-dial",
					`Speed dial code "${dial.code}" is defined more than once.`,
					subject,
					"code",
				);
				continue;
			}
			const nodeId = this.destinationNode(
				{
					destinationType: dial.destinationType,
					destinationRef: dial.destinationRef,
					destinationData: dial.destinationData,
				},
				subject,
				"destination",
			);
			if (nodeId === null) {
				continue;
			}
			entries[dial.code] = {
				speedDialId: dial.id,
				code: dial.code,
				label: dial.label,
				nodeId,
			};
			// A bare-numeric code is dialable in the same space extensions are, so it is claimed the
			// same way. A star-prefixed one is not, and claiming it would put a `*` into a map whose
			// keys the resolver reads as extension numbers.
			if (/^[0-9]+$/u.test(dial.code)) {
				this.claimNumber(dial.code, {
					kind: "speed-dial",
					entityId: dial.id,
					nodeId,
					name: dial.label,
				});
			}
		}
		return sortRecordKeys(entries);
	}

	private indexVoicemailGreetings(): void {
		for (const greeting of sortById(this.snapshot.voicemailGreetings ?? [])) {
			if (!greeting.active) {
				continue;
			}
			if (!this.voicemailById.has(greeting.voicemailBoxId)) {
				this.bag.warning(
					"dangling-voicemail-greeting",
					`Voicemail greeting "${greeting.id}" belongs to mailbox "${greeting.voicemailBoxId}", which is not in this snapshot; it was ignored.`,
					{ kind: "voicemail-greeting", id: greeting.id },
					"voicemailBoxId",
				);
				continue;
			}
			const key = greetingKey(greeting.voicemailBoxId, greeting.kind);
			if (!this.activeGreetings.has(key)) {
				this.activeGreetings.set(key, greeting);
			}
		}
	}

	/**
	 * A `moh_class` row id resolved to the NAME a media server will accept.
	 *
	 * Warning rather than error on both misses: music on hold is decoration. A tenant who deletes a
	 * class that four ring groups still name has a configuration worth flagging, not a PBX that
	 * should refuse to route calls until they fix it — the caller hears the media server's default
	 * class, which is a perfectly good hold experience.
	 */
	private mohClassName(
		mohClassId: string | null | undefined,
		subject: DiagnosticSubject,
		path: string,
	): string | undefined {
		const id = mohClassId ?? undefined;
		if (id === undefined || id.trim() === "") {
			return undefined;
		}
		// Nothing to resolve against: a loader that does not yet load the collection is a rollout
		// state, not a dangling reference, and reporting every MOH id as broken would bury the real
		// diagnostics in noise on every tenant at once.
		if (this.snapshot.mohClasses === undefined) {
			return undefined;
		}
		const mohClass = this.mohClassesById.get(id);
		if (mohClass === undefined) {
			this.bag.warning(
				"dangling-moh-class",
				`Music-on-hold class "${id}" is not in this snapshot; callers hear the media server's default class.`,
				subject,
				path,
			);
			return undefined;
		}
		if (!mohClass.enabled) {
			this.bag.warning(
				"dangling-moh-class",
				`Music-on-hold class "${mohClass.name}" is disabled; callers hear the media server's default class.`,
				subject,
				path,
			);
			return undefined;
		}
		return mohClass.name;
	}

	private conferenceNodeById(
		ref: string,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const room = this.conferencesById.get(ref);
		if (room === undefined) {
			return this.missingTarget("conference", ref, subject, path);
		}
		if (!room.enabled) {
			return this.disabledTarget("conference", room.name, subject, path);
		}
		return this.conferenceNode(room);
	}

	private conferenceNode(room: OrgRoutingSnapshot["conferences"][number]): PlanNodeId {
		const id = `conference:${room.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);
		const subject: DiagnosticSubject = { kind: "conference", id: room.id, name: room.name };
		this.nodes.set(
			id,
			compact({
				id,
				kind: "conference",
				label: room.name,
				conferenceId: room.id,
				roomNumber: room.roomNumber,
				requiresPin: room.requiresPin,
				maxMembers: room.maxMembers,
				waitForModerator: room.waitForModerator,
				recordEnabled: room.recordEnabled,
				mohClassId: room.mohClassId ?? undefined,
				mohClass: this.mohClassName(room.mohClassId, subject, "mohClassId"),
				pinHash: this.conferencePinHash(room, room.pinHash, "pinHash", subject),
				moderatorPinHash: this.conferencePinHash(
					room,
					room.moderatorPinHash,
					"moderatorPinHash",
					subject,
				),
				requiresModeratorPin:
					(room.requiresModeratorPin ?? room.moderatorPinHash != null) || undefined,
			}) as PlanNode,
		);
		return id;
	}

	/**
	 * A conference PIN digest, if it is one.
	 *
	 * The `voicemailPinHash` clone, and deliberately a clone rather than a shared helper taking a
	 * subject and a label: the two differ in what the caller is told when the digest is unreadable,
	 * and that difference is the point. A mailbox with an unreadable digest **degrades** — it falls
	 * back to authenticating by the calling extension, which is the classic PBX default and is what
	 * it did before PINs were compiled at all. A room with an unreadable digest **fails closed** —
	 * the engine refuses it — because the classic default for a conference bridge is "anyone who
	 * knows the number is in", and silently restoring that on a room whose owner set a PIN would
	 * turn a formatting change into an open bridge.
	 *
	 * So both warn, both refuse to embed, and the messages say which of the two happened.
	 */
	private conferencePinHash(
		room: OrgRoutingSnapshot["conferences"][number],
		raw: string | null | undefined,
		path: "pinHash" | "moderatorPinHash",
		subject: DiagnosticSubject,
	): string | undefined {
		const value = raw ?? undefined;
		if (value === undefined || value.trim() === "") {
			return undefined;
		}
		const issue = voicemailPinHashIssue(value);
		if (issue !== undefined) {
			const which = path === "pinHash" ? "participant" : "moderator";
			this.bag.warning(
				"invalid-pin-hash",
				`Conference room ${room.roomNumber} has a ${which} PIN digest this release cannot read (${issue}); the room is refused rather than admitted without a PIN.`,
				subject,
				path,
			);
			return undefined;
		}
		return value.trim();
	}

	private parkNodeById(ref: string, subject: DiagnosticSubject, path: string): PlanNodeId | null {
		const lot = this.parkLotsById.get(ref);
		if (lot === undefined) {
			return this.missingTarget("park lot", ref, subject, path);
		}
		if (!lot.enabled) {
			return this.disabledTarget("park lot", lot.name, subject, path);
		}
		return this.parkNode(lot);
	}

	private parkNode(lot: OrgRoutingSnapshot["parkLots"][number]): PlanNodeId {
		const id = `park:${lot.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);
		const subject: DiagnosticSubject = { kind: "park-lot", id: lot.id, name: lot.name };
		this.nodes.set(
			id,
			compact({
				id,
				kind: "park",
				label: lot.name,
				parkLotId: lot.id,
				slotStart: lot.slotStart,
				slotEnd: lot.slotEnd,
				timeoutSeconds: lot.timeoutSeconds,
				mohClassId: lot.mohClassId ?? undefined,
				mohClass: this.mohClassName(lot.mohClassId, subject, "mohClassId"),
				timeoutNodeId: this.namedDestinationNode(lot, "timeout", subject) ?? undefined,
			}) as PlanNode,
		);
		return id;
	}

	private pagingGroupNodeById(
		ref: string,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const group = this.pagingGroupsById.get(ref);
		if (group === undefined) {
			return this.missingTarget("paging group", ref, subject, path);
		}
		if (!group.enabled) {
			return this.disabledTarget("paging group", group.name, subject, path);
		}
		return this.pagingGroupNode(group);
	}

	/**
	 * A paging group, compiled to the list of numbers the engine will announce to.
	 *
	 * Three ways a member leaves the compiled list, and they are deliberately not the same event:
	 *
	 * - the **member row** is disabled — silently. That is the operator saying "not this desk today",
	 *   which is configuration working rather than configuration broken, and reporting it would put a
	 *   warning on every group that has ever had somebody on leave.
	 * - its **extension is not in the snapshot** — a `dangling-destination` warning naming the group
	 *   and the id. A member pointing at nothing means the page reaches fewer handsets than whoever
	 *   built the group believes, and that belief is only ever tested during an emergency.
	 * - its **extension is disabled** — a `disabled-entity` warning, the same one every other
	 *   destination raises. Told apart from the case above because the fix is different: one is
	 *   "somebody deleted this desk", the other is "somebody switched it off".
	 *
	 * All warnings, never errors, and the group still compiles when it ends up EMPTY, because an
	 * empty page is a configuration mistake and not an unsound artifact — exactly the line
	 * `empty-ring-group` draws. Refusing to compile would take the tenant's working calls down to fix
	 * an announcement nobody has made yet.
	 */
	private pagingGroupNode(group: PagingGroupInput): PlanNodeId {
		const id = `paging:${group.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);

		const subject: DiagnosticSubject = { kind: "paging-group", id: group.id, name: group.name };
		const members: string[] = [];
		for (const member of [...group.members].sort(
			(left, right) =>
				left.ordinal - right.ordinal ||
				(left.extensionId < right.extensionId ? -1 : left.extensionId > right.extensionId ? 1 : 0),
		)) {
			if (!member.enabled) {
				continue;
			}
			const extension = this.extensionsById.get(member.extensionId);
			// `extensionsById` holds disabled extensions too — that is what makes the two misses below
			// distinguishable at all, and the operator needs them distinguished because the fixes are
			// not the same one.
			if (extension === undefined) {
				this.bag.warning(
					"dangling-destination",
					`Paging group "${group.name}" lists extension "${member.extensionId}", which is not in this organization's configuration; it was dropped from the page.`,
					subject,
					"members",
				);
				continue;
			}
			if (!extension.enabled) {
				this.bag.warning(
					"disabled-entity",
					`Paging group "${group.name}" lists extension ${extension.number}, which is disabled; it was dropped from the page.`,
					subject,
					"members",
				);
				continue;
			}
			members.push(extension.number);
		}

		if (members.length === 0) {
			this.bag.warning(
				"empty-paging-group",
				`Paging group "${group.name}" has no reachable members; a page to it announces to nobody.`,
				subject,
			);
		}

		this.nodes.set(
			id,
			compact({
				id,
				kind: "paging",
				label: group.name,
				pagingGroupId: group.id,
				members,
				duplex: group.duplex,
				timeoutSeconds: group.timeoutSeconds,
			}) as PlanNode,
		);
		return id;
	}

	private timeConditionNodeById(
		ref: string,
		subject: DiagnosticSubject,
		path: string,
	): PlanNodeId | null {
		const condition = this.timeConditionInputsById.get(ref);
		if (condition === undefined) {
			return this.missingTarget("time condition", ref, subject, path);
		}
		if (!condition.enabled) {
			return this.disabledTarget("time condition", condition.name, subject, path);
		}
		const id = `time-condition:${condition.id}`;
		if (this.claimed.has(id)) {
			return id;
		}
		this.claimed.add(id);

		const ownSubject: DiagnosticSubject = {
			kind: "time-condition",
			id: condition.id,
			name: condition.name,
		};
		const matchNodeId = this.destinationNode(
			{
				destinationType: condition.destinationType,
				destinationRef: condition.destinationRef,
				destinationData: condition.destinationData,
			},
			ownSubject,
			"destination",
		);
		const noMatchNodeId = this.namedDestinationNode(condition, "nomatch", ownSubject);

		this.nodes.set(
			id,
			compact({
				id,
				kind: "time-condition",
				label: condition.name,
				timeConditionId: condition.id,
				matchNodeId: matchNodeId ?? this.hangupNode("NORMAL_CLEARING"),
				noMatchNodeId: noMatchNodeId ?? undefined,
			}) as PlanNode,
		);
		return id;
	}

	private externalNode(value: string, viaOutboundRouting: boolean): PlanNodeId {
		const destination = value.trim();
		const id = `external:${destination}`;
		if (!this.claimed.has(id)) {
			this.claimed.add(id);
			this.nodes.set(id, {
				id,
				kind: "external",
				label: destination,
				destination,
				viaOutboundRouting,
			});
		}
		return id;
	}

	private applicationNode(
		name: string,
		args: Readonly<Record<string, string | number | boolean>> | undefined,
	): PlanNodeId {
		const argsKey =
			args === undefined
				? ""
				: `|${Object.keys(args)
						.sort()
						.map((key) => `${key}=${String(args[key])}`)
						.join(",")}`;
		const id = `application:${name}${argsKey}`;
		if (!this.claimed.has(id)) {
			this.claimed.add(id);
			this.nodes.set(
				id,
				compact({ id, kind: "application", label: name, application: name, args }) as PlanNode,
			);
		}
		return id;
	}

	/**
	 * Reads and resolves an optional prefixed destination trio (`timeout`, `failover`, `nomatch`).
	 *
	 * The prefix is a runtime string, so the three column names cannot be expressed as a type over
	 * the row's own interface without a mapped type per call site. One contained index-access cast
	 * is the smaller cost, and `destinationNode` re-validates whatever comes out of it.
	 */
	private namedDestinationNode(
		source: object,
		prefix: string,
		subject: DiagnosticSubject,
	): PlanNodeId | null {
		const row = source as Readonly<Record<string, unknown>>;
		const type = row[`${prefix}DestinationType`];
		if (type === undefined || type === null) {
			return null;
		}
		return this.destinationNode(
			{
				destinationType: type as Destination["destinationType"],
				destinationRef: (row[`${prefix}DestinationRef`] ?? null) as string | null,
				destinationData: (row[`${prefix}DestinationData`] ??
					null) as Destination["destinationData"],
			},
			subject,
			`${prefix}Destination`,
		);
	}

	// -------------------------------------------------------------------------------------------
	// Internal context
	// -------------------------------------------------------------------------------------------

	private compileInternal(emergency: EmergencyMatchTable): InternalMatchTable {
		const featureCodes = this.compileFeatureCodes();
		const voicemailPrefixes = this.compileVoicemailPrefixes(featureCodes);

		this.claimInternalNumbers();
		// After `claimInternalNumbers`, so a numeric speed dial that collides with an extension is
		// reported against the SPEED DIAL — the later claimant is the one somebody just added.
		const speedDials = this.compileSpeedDials(featureCodes);
		this.reportToggleCodeCollisions(featureCodes);
		this.reportEmergencyShadowing(emergency);
		const parkSlots = this.compileParkSlots();

		return {
			...(Object.keys(emergency).length === 0 ? {} : { emergency }),
			featureCodes,
			voicemailPrefixes,
			mailboxes: this.compileMailboxes(),
			...(Object.keys(speedDials).length === 0 ? {} : { speedDials }),
			numbers: Object.fromEntries(
				[...this.internalNumbers.entries()].sort(([left], [right]) =>
					left < right ? -1 : left > right ? 1 : 0,
				),
			),
			parkSlots,
			noMatchNodeId: this.hangupNode(NO_MATCH_CAUSE),
		};
	}

	private compileMailboxes(): Readonly<Record<string, MailboxEntry>> {
		const mailboxes: Record<string, MailboxEntry> = {};
		for (const box of sortById(this.snapshot.voicemailBoxes)) {
			if (!box.enabled) {
				continue;
			}
			if (mailboxes[box.mailboxNumber] !== undefined) {
				this.bag.error(
					"duplicate-internal-number",
					`Mailbox number ${box.mailboxNumber} is claimed by more than one voicemail box.`,
					{ kind: "voicemail-box", id: box.id, name: box.mailboxNumber },
					"mailboxNumber",
				);
				continue;
			}
			mailboxes[box.mailboxNumber] = {
				voicemailBoxId: box.id,
				mailboxNumber: box.mailboxNumber,
				leaveNodeId: this.voicemailNode(box, "leave"),
				checkNodeId: this.voicemailNode(box, "check"),
			};
		}
		return sortRecordKeys(mailboxes);
	}

	private compileFeatureCodes(): readonly CompiledFeatureCode[] {
		const enabled = sortById(this.snapshot.featureCodes).filter((code) => code.enabled);
		for (const issue of featureCodeIssues(enabled)) {
			const subject = enabled.find((entry) => entry.code === issue.value);
			const diagnosticSubject: DiagnosticSubject | undefined =
				subject === undefined
					? undefined
					: { kind: "feature-code", id: subject.id, name: subject.code };
			if (issue.code === "malformed-code") {
				this.bag.error(
					"conflicting-feature-code",
					`Feature code "${issue.value}" is not dialable; codes start with * or # and contain only digits.`,
					diagnosticSubject,
					"code",
				);
			} else if (issue.code === "duplicate-code") {
				this.bag.error(
					"conflicting-feature-code",
					`Feature code "${issue.value}" is defined more than once.`,
					diagnosticSubject,
					"code",
				);
			} else {
				this.bag.error(
					"conflicting-feature-code",
					`Feature code "${issue.value}" takes an argument, so "${issue.other}" can never be dialed unambiguously.`,
					diagnosticSubject,
					"code",
				);
			}
		}

		const compiled: CompiledFeatureCode[] = [];
		for (const entry of enabled) {
			if (!isWellFormedFeatureCode(entry.code)) {
				continue;
			}
			const id = `feature-code:${entry.id}`;
			const targetNodeId = this.featureCodeTarget(entry);
			if (!this.claimed.has(id)) {
				this.claimed.add(id);
				this.nodes.set(
					id,
					compact({
						id,
						kind: "feature-code",
						label: entry.label ?? entry.code,
						featureCodeId: entry.id,
						code: entry.code,
						action: entry.action,
						params: entry.params ?? undefined,
						targetNodeId: targetNodeId ?? undefined,
					}) as PlanNode,
				);
			}
			compiled.push(
				compact({
					id: entry.id,
					code: entry.code,
					action: entry.action,
					argumentMode: FEATURE_CODE_ARGUMENT_MODE[entry.action],
					params: entry.params ?? undefined,
					label: entry.label ?? undefined,
					nodeId: id,
				}) as CompiledFeatureCode,
			);
		}

		// Longest code first, so `**200` never loses to `*`; ties broken by code for stability.
		return compiled.sort(
			(left, right) =>
				right.code.length - left.code.length ||
				(left.code < right.code ? -1 : left.code > right.code ? 1 : 0),
		);
	}

	/**
	 * A few feature codes name a concrete entity in `params` — `call-park` may pin a lot, `paging`
	 * may pin a group. Resolving it at compile time is what lets the engine treat "park in lot X" and
	 * "park anywhere" as the same code with a different node.
	 *
	 * `intercom` is deliberately NOT here. Its argument is the extension the caller dialed after the
	 * code (`*80` + `1001`), which is a live keypress and not a stored parameter — there is nothing
	 * for a compiler to resolve, and pinning one would turn a code that reaches any desk into a code
	 * that reaches one.
	 */
	private featureCodeTarget(entry: OrgRoutingSnapshot["featureCodes"][number]): PlanNodeId | null {
		const subject: DiagnosticSubject = { kind: "feature-code", id: entry.id, name: entry.code };
		const lotId = entry.params?.lotId;
		if (entry.action === "call-park" && typeof lotId === "string" && lotId.length > 0) {
			return this.parkNodeById(lotId, subject, "params.lotId");
		}
		const groupId = entry.params?.groupId;
		if (entry.action === "paging" && typeof groupId === "string" && groupId.length > 0) {
			return this.pagingGroupNodeById(groupId, subject, "params.groupId");
		}
		return null;
	}

	private compileVoicemailPrefixes(
		featureCodes: readonly CompiledFeatureCode[],
	): readonly VoicemailPrefixEntry[] {
		const configured: VoicemailPrefixEntry[] = [];
		const settings = this.snapshot.settings ?? {};
		if (settings.voicemailPrefix != null && settings.voicemailPrefix.length > 0) {
			configured.push({ prefix: settings.voicemailPrefix, mode: "leave" });
		}
		if (settings.voicemailCheckPrefix != null && settings.voicemailCheckPrefix.length > 0) {
			configured.push({ prefix: settings.voicemailCheckPrefix, mode: "check" });
		}
		for (const entry of configured) {
			const clash = featureCodes.find(
				(code) => code.code === entry.prefix || entry.prefix.startsWith(code.code),
			);
			if (clash !== undefined) {
				this.bag.warning(
					"conflicting-feature-code",
					`Voicemail prefix "${entry.prefix}" overlaps feature code "${clash.code}"; the feature code wins.`,
					{ kind: "feature-code", id: clash.id, name: clash.code },
					"settings.voicemailPrefix",
				);
			}
		}
		// Longest prefix first for the same reason feature codes are.
		return configured.sort((left, right) => right.prefix.length - left.prefix.length);
	}

	private claimInternalNumbers(): void {
		for (const extension of sortById(this.snapshot.extensions)) {
			if (!extension.enabled) {
				continue;
			}
			this.claimNumber(extension.number, {
				kind: "extension",
				entityId: extension.id,
				nodeId: this.extensionNode(extension),
				name: extension.number,
			});
		}
		for (const group of sortById(this.snapshot.ringGroups)) {
			if (!group.enabled || group.extensionNumber == null || group.extensionNumber.length === 0) {
				continue;
			}
			this.claimNumber(group.extensionNumber, {
				kind: "ring-group",
				entityId: group.id,
				nodeId: this.ringGroupNode(group),
				name: group.name,
			});
		}
		for (const menu of sortById(this.snapshot.ivrMenus)) {
			if (!menu.enabled || menu.extensionNumber == null || menu.extensionNumber.length === 0) {
				continue;
			}
			this.claimNumber(menu.extensionNumber, {
				kind: "ivr-menu",
				entityId: menu.id,
				nodeId: this.ivrNode(menu),
				name: menu.name,
			});
		}
		for (const entry of sortById(this.snapshot.queues)) {
			if (!entry.enabled || entry.extensionNumber == null || entry.extensionNumber.length === 0) {
				continue;
			}
			this.claimNumber(entry.extensionNumber, {
				kind: "queue",
				entityId: entry.id,
				nodeId: this.queueNode(entry),
				name: entry.name,
			});
		}
		for (const group of sortById(this.snapshot.pagingGroups ?? [])) {
			if (!group.enabled || group.extensionNumber == null || group.extensionNumber.length === 0) {
				continue;
			}
			// Through `claimNumber` like every other dialable entity, so a group numbered the same as an
			// extension collides LOUDLY at compile time instead of quietly at dial time — where the
			// tenant would discover it by paging the building when they meant to call a colleague.
			this.claimNumber(group.extensionNumber, {
				kind: "paging-group",
				entityId: group.id,
				nodeId: this.pagingGroupNode(group),
				name: group.name,
			});
		}
		for (const room of sortById(this.snapshot.conferences)) {
			if (!room.enabled) {
				continue;
			}
			this.claimNumber(room.roomNumber, {
				kind: "conference",
				entityId: room.id,
				nodeId: this.conferenceNode(room),
				name: room.name,
			});
		}
		for (const flow of sortById(this.snapshot.callFlows ?? [])) {
			if (!flow.enabled || flow.extensionNumber == null || flow.extensionNumber.length === 0) {
				continue;
			}
			this.claimNumber(flow.extensionNumber, {
				kind: "call-flow",
				entityId: flow.id,
				nodeId: this.callFlowNode(flow),
				name: flow.name,
			});
		}
		for (const directory of sortById(this.snapshot.directories ?? [])) {
			if (
				!directory.enabled ||
				directory.extensionNumber == null ||
				directory.extensionNumber.length === 0
			) {
				continue;
			}
			this.claimNumber(directory.extensionNumber, {
				kind: "dial-by-name",
				entityId: directory.id,
				nodeId: this.dialByNameNode(directory),
				name: directory.name,
			});
		}
	}

	/**
	 * Screens the per-row toggle codes against the feature-code catalogue.
	 *
	 * `call_flow.feature_code` and `time_condition.override_feature_code` are dialable strings that
	 * are NOT `feature_code` rows — deliberately, because they are instance-specific toggles rather
	 * than members of a closed catalogue of actions. The cost of that choice is exactly this: two
	 * mechanisms answering the same digits, with no runtime symptom beyond the wrong one winning.
	 * So the compiler reports the overlap rather than letting a tenant discover it by pressing a key
	 * and watching a different thing happen.
	 *
	 * An ERROR, not a warning: unlike a shadowed route, there is no reading of this configuration
	 * under which the tenant gets what they asked for.
	 */
	private reportToggleCodeCollisions(featureCodes: readonly CompiledFeatureCode[]): void {
		const seen = new Map<string, string>();
		const check = (code: string | null | undefined, subject: DiagnosticSubject, path: string) => {
			const value = code?.trim() ?? "";
			if (value.length === 0) {
				return;
			}
			const clash = featureCodes.find(
				(entry) =>
					entry.code === value || (entry.argumentMode !== "none" && value.startsWith(entry.code)),
			);
			if (clash !== undefined) {
				this.bag.error(
					"conflicting-feature-code",
					`Toggle code "${value}" can never be dialed: feature code "${clash.code}" is matched first and would consume it.`,
					subject,
					path,
				);
				return;
			}
			const other = seen.get(value);
			if (other !== undefined) {
				this.bag.error(
					"conflicting-feature-code",
					`Toggle code "${value}" is claimed by both ${other} and ${subject.name ?? subject.id}.`,
					subject,
					path,
				);
				return;
			}
			seen.set(value, subject.name ?? subject.id);
		};

		for (const flow of sortById(this.snapshot.callFlows ?? [])) {
			if (flow.enabled) {
				check(flow.featureCode, { kind: "call-flow", id: flow.id, name: flow.name }, "featureCode");
			}
		}
		for (const condition of sortById(this.snapshot.timeConditions)) {
			if (condition.enabled) {
				check(
					condition.overrideFeatureCode,
					{ kind: "time-condition", id: condition.id, name: condition.name },
					"overrideFeatureCode",
				);
			}
		}
	}

	private claimNumber(
		numberValue: string,
		claim: {
			kind: InternalNumberEntry["kind"];
			entityId: string;
			nodeId: PlanNodeId;
			name: string;
		},
	): void {
		const existing = this.internalNumbers.get(numberValue);
		if (existing !== undefined) {
			this.bag.error(
				"duplicate-internal-number",
				`Internal number ${numberValue} is claimed by both ${existing.kind} "${existing.entityId}" and ${claim.kind} "${claim.name}"; dialing it would be ambiguous.`,
				{ kind: claim.kind, id: claim.entityId, name: claim.name },
				"extensionNumber",
			);
			return;
		}
		this.internalNumbers.set(numberValue, {
			number: numberValue,
			kind: claim.kind,
			entityId: claim.entityId,
			nodeId: claim.nodeId,
		});
	}

	private compileParkSlots(): readonly ParkSlotRange[] {
		const ranges: ParkSlotRange[] = [];
		for (const lot of sortById(this.snapshot.parkLots)) {
			if (!lot.enabled) {
				continue;
			}
			const subject: DiagnosticSubject = { kind: "park-lot", id: lot.id, name: lot.name };
			if (lot.slotEnd < lot.slotStart) {
				this.bag.error(
					"invalid-pattern",
					`Park lot "${lot.name}" ends (${lot.slotEnd}) before it starts (${lot.slotStart}).`,
					subject,
					"slotEnd",
				);
				continue;
			}
			const overlap = ranges.find(
				(range) => lot.slotStart <= range.slotEnd && range.slotStart <= lot.slotEnd,
			);
			if (overlap !== undefined) {
				this.bag.error(
					"duplicate-internal-number",
					`Park lot "${lot.name}" (${lot.slotStart}-${lot.slotEnd}) overlaps another lot's slot range.`,
					subject,
					"slotStart",
				);
				continue;
			}
			for (const [numberValue] of this.internalNumbers) {
				const asNumber = Number.parseInt(numberValue, 10);
				if (
					String(asNumber) === numberValue &&
					asNumber >= lot.slotStart &&
					asNumber <= lot.slotEnd
				) {
					this.bag.warning(
						"duplicate-internal-number",
						`Park lot "${lot.name}" covers slot ${numberValue}, which is also a dialable internal number; the internal number wins.`,
						subject,
						"slotStart",
					);
				}
			}
			ranges.push({
				parkLotId: lot.id,
				slotStart: lot.slotStart,
				slotEnd: lot.slotEnd,
				nodeId: this.parkNode(lot),
			});
		}
		return ranges.sort((left, right) => left.slotStart - right.slotStart);
	}

	// -------------------------------------------------------------------------------------------
	// Inbound context
	// -------------------------------------------------------------------------------------------

	/**
	 * Caller-id normalisation per trunk, for the inbound resolver.
	 *
	 * Keyed by `trunk.id` rather than folded into the rules, because the rewrite happens BEFORE the
	 * rule walk and before the call-block screen: the whole point is that a tenant's blocklist should
	 * not have to know which carrier a call arrived on.
	 */
	private compileInboundTranslations(): Readonly<Record<string, CompiledTranslationRuleset>> {
		const byTrunk: Record<string, CompiledTranslationRuleset> = {};
		for (const trunk of sortById(this.snapshot.trunks)) {
			if (!trunk.enabled) {
				continue;
			}
			const ruleset = this.translationRuleset(
				trunk.inboundTranslationRulesetId,
				{ kind: "trunk", id: trunk.id, name: trunk.name },
				"inboundTranslationRulesetId",
			);
			if (ruleset !== undefined) {
				byTrunk[trunk.id] = ruleset;
			}
		}
		return sortRecordKeys(byTrunk);
	}

	private compileInbound(): InboundMatchTable {
		const rules: InboundRule[] = [];

		for (const route of sortById(this.snapshot.inboundRoutes)) {
			if (!route.enabled) {
				continue;
			}
			const subject: DiagnosticSubject = {
				kind: "inbound-route",
				id: route.id,
				name: route.name,
			};

			let e164: string | undefined;
			if (route.phoneNumberId != null && route.phoneNumberId.length > 0) {
				const did = this.phoneNumbersById.get(route.phoneNumberId);
				if (did === undefined) {
					this.bag.error(
						"dangling-destination",
						`Inbound route "${route.name}" is bound to a phone number that no longer exists.`,
						subject,
						"phoneNumberId",
					);
					continue;
				}
				e164 = did.e164;
			}

			const pattern = this.routePattern(
				route.matchKind,
				route.matchPattern,
				subject,
				"matchPattern",
			);
			if (pattern === null) {
				continue;
			}
			// The caller screen borrows the route's match kind, except for `any`: a screen the tenant
			// deliberately typed must not compile to "matches everyone". `prefix` is the fallback
			// because caller screening is almost always by country or area code.
			const callerPattern =
				route.callerIdPattern == null || route.callerIdPattern.length === 0
					? undefined
					: (this.routePattern(
							route.matchKind === "any" ? "prefix" : route.matchKind,
							route.callerIdPattern,
							subject,
							"callerIdPattern",
						) ?? undefined);

			const failoverNodeId = this.namedDestinationNode(route, "failover", subject);
			const destinationNodeId = this.destinationNode(
				{
					destinationType: route.destinationType,
					destinationRef: route.destinationRef,
					destinationData: route.destinationData,
				},
				subject,
				"destination",
			);
			if (destinationNodeId === null) {
				continue;
			}

			const timeGate = this.routeTimeGate(route.timeConditionId, failoverNodeId, subject);
			const did =
				route.phoneNumberId == null ? undefined : this.phoneNumbersById.get(route.phoneNumberId);

			rules.push(
				compact({
					id: route.id,
					name: route.name,
					priority: route.priority,
					phoneNumberId: route.phoneNumberId ?? undefined,
					e164,
					pattern,
					callerPattern,
					timeGate,
					recordEnabled: route.recordEnabled,
					destinationNodeId,
					failoverNodeId: failoverNodeId ?? undefined,
					callerIdNamePrefix: did?.callerIdNamePrefix ?? undefined,
				}) as InboundRule,
			);
		}

		const ordered = rules.sort(
			(left, right) =>
				left.priority - right.priority ||
				inboundSpecificity(right) - inboundSpecificity(left) ||
				(left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
		);
		this.reportInboundShadowing(ordered);

		const didDefaults: Record<string, InboundDidDefault> = {};
		for (const did of sortById(this.snapshot.phoneNumbers)) {
			if (!did.enabled || !did.voiceEnabled) {
				continue;
			}
			const subject: DiagnosticSubject = { kind: "phone-number", id: did.id, name: did.e164 };
			const destinationNodeId = this.destinationNode(
				{
					destinationType: did.destinationType,
					destinationRef: did.destinationRef,
					destinationData: did.destinationData,
				},
				subject,
				"destination",
			);
			if (destinationNodeId === null) {
				continue;
			}
			didDefaults[did.e164] = compact({
				phoneNumberId: did.id,
				e164: did.e164,
				enabled: did.enabled,
				recordEnabled: did.recordEnabled,
				callerIdNamePrefix: did.callerIdNamePrefix ?? undefined,
				destinationNodeId,
			}) as InboundDidDefault;
		}

		const inboundTranslations = this.compileInboundTranslations();
		return {
			rules: ordered,
			didDefaults: sortRecordKeys(didDefaults),
			noMatchNodeId: this.hangupNode(NO_MATCH_CAUSE),
			...(Object.keys(inboundTranslations).length === 0 ? {} : { inboundTranslations }),
		};
	}

	/**
	 * Reports rules that can never fire.
	 *
	 * Only unconditional subsumption is reported: a rule with a caller screen or a time gate may
	 * decline to match, so a rule below it is still reachable. Being quiet about the uncertain cases
	 * is what keeps the warnings worth reading.
	 */
	private reportInboundShadowing(rules: readonly InboundRule[]): void {
		for (const [index, rule] of rules.entries()) {
			for (const earlier of rules.slice(0, index)) {
				if (earlier.callerPattern !== undefined || earlier.timeGate !== undefined) {
					continue;
				}
				const earlierMatchesEverythingLaterDoes =
					earlier.e164 === undefined
						? patternSubsumes(earlier.pattern, rule.pattern)
						: earlier.e164 === rule.e164 && patternSubsumes(earlier.pattern, rule.pattern);
				if (!earlierMatchesEverythingLaterDoes) {
					continue;
				}
				const identical =
					earlier.e164 === rule.e164 &&
					patternSubsumes(rule.pattern, earlier.pattern) &&
					patternSubsumes(earlier.pattern, rule.pattern);
				this.bag.warning(
					identical ? "overlapping-did-pattern" : "unreachable-route",
					identical
						? `Inbound route "${rule.name}" matches exactly the same calls as "${earlier.name}", which is evaluated first.`
						: `Inbound route "${rule.name}" can never run: "${earlier.name}" is evaluated first and matches every call it would.`,
					{ kind: "inbound-route", id: rule.id, name: rule.name },
				);
				break;
			}
		}
	}

	private routePattern(
		kind: OrgRoutingSnapshot["inboundRoutes"][number]["matchKind"],
		raw: string | null | undefined,
		subject: DiagnosticSubject,
		path: string,
	): CompiledPattern | null {
		const { pattern, issues } = compilePattern(kind, raw);
		let usable = true;
		for (const issue of issues) {
			if (issue.code === "unanchored-regex") {
				this.bag.warning(
					"unanchored-regex",
					`Pattern "${raw ?? ""}" is an unanchored regex; anchor it with ^ and $ so it cannot match more than intended.`,
					subject,
					path,
				);
				continue;
			}
			usable = false;
			this.bag.error(
				issue.code === "invalid-regex" ? "invalid-regex" : "invalid-pattern",
				`Pattern "${raw ?? ""}" is not usable (${issue.code}).`,
				subject,
				path,
			);
		}
		return usable ? pattern : null;
	}

	/**
	 * Builds a route's time gate.
	 *
	 * A time condition used as a *gate* contributes only its rules and its no-match branch; its own
	 * `destination` applies when it is used as a *destination*. Keeping the two roles separate is
	 * what stops a route's own destination from becoming dead configuration the moment a gate is
	 * attached to it.
	 */
	private routeTimeGate(
		timeConditionId: string | null | undefined,
		failoverNodeId: PlanNodeId | null,
		subject: DiagnosticSubject,
	): RouteTimeGate | undefined {
		if (timeConditionId == null || timeConditionId.length === 0) {
			return undefined;
		}
		const condition = this.timeConditionInputsById.get(timeConditionId);
		if (condition === undefined) {
			this.bag.error(
				"missing-time-condition",
				"Route references a time condition that is not in this organization's configuration.",
				subject,
				"timeConditionId",
			);
			return undefined;
		}
		if (!condition.enabled) {
			this.bag.warning(
				"disabled-entity",
				`Time condition "${condition.name}" is disabled, so the route it gates is always open.`,
				subject,
				"timeConditionId",
			);
			return undefined;
		}
		const closedNodeId =
			this.namedDestinationNode(condition, "nomatch", {
				kind: "time-condition",
				id: condition.id,
				name: condition.name,
			}) ??
			failoverNodeId ??
			null;
		return compact({
			timeConditionId: condition.id,
			closedNodeId: closedNodeId ?? undefined,
		}) as RouteTimeGate;
	}

	// -------------------------------------------------------------------------------------------
	// Outbound context
	// -------------------------------------------------------------------------------------------

	private compileOutbound(
		settings: CompiledRoutingSettings,
		emergency: EmergencyMatchTable,
	): OutboundMatchTable {
		const rules: OutboundRule[] = [];
		const continueOnCauses = this.trunkContinueOnCauses();

		for (const route of sortById(this.snapshot.outboundRoutes)) {
			if (!route.enabled) {
				continue;
			}
			const subject: DiagnosticSubject = {
				kind: "outbound-route",
				id: route.id,
				name: route.name,
			};

			const patterns: CompiledPattern[] = [];
			let usable = true;
			if (route.dialPatterns.length === 0 && route.matchKind !== "any") {
				this.bag.error(
					"invalid-pattern",
					`Outbound route "${route.name}" has no dial patterns.`,
					subject,
					"dialPatterns",
				);
				usable = false;
			}
			for (const [index, raw] of route.dialPatterns.entries()) {
				const pattern = this.routePattern(route.matchKind, raw, subject, `dialPatterns[${index}]`);
				if (pattern === null) {
					usable = false;
					continue;
				}
				patterns.push(pattern);
			}
			if (route.matchKind === "any" && patterns.length === 0) {
				patterns.push({ kind: "any" });
			}
			if (!usable) {
				continue;
			}

			for (const issue of validateDigitManipulation({
				stripDigits: route.stripDigits,
				prependDigits: route.prependDigits ?? null,
			})) {
				usable = false;
				this.bag.error(
					"invalid-digit-manipulation",
					`Outbound route "${route.name}" has invalid digit manipulation (${issue.code}).`,
					subject,
					issue.code === "invalid-prepend" ? "prependDigits" : "stripDigits",
				);
			}
			if (!usable) {
				continue;
			}

			const failoverNodeId = this.namedDestinationNode(route, "failover", subject);
			const trunkPlan = this.compileTrunkPlan(route, continueOnCauses, subject);
			const nodeId = `trunk-dial:${route.id}`;
			if (!this.claimed.has(nodeId)) {
				this.claimed.add(nodeId);
				this.nodes.set(
					nodeId,
					compact({
						id: nodeId,
						kind: "trunk-dial",
						label: route.name,
						outboundRouteId: route.id,
						tollClass: route.tollClass,
						attempts: trunkPlan.attempts,
						continueOnCauses: trunkPlan.continueOnCauses,
						recordEnabled: route.recordEnabled,
						callerIdNumberOverride: route.callerIdNumberOverride ?? undefined,
						failoverNodeId: failoverNodeId ?? undefined,
						// The gate travels on the NODE, because the node is what the engine walks — a
						// resolver hands over an `ExecutionPlan`, not the rule it matched.
						pinSet: this.compilePinSet(route.pinSetId, subject),
					}) as PlanNode,
				);
			}

			rules.push(
				compact({
					id: route.id,
					name: route.name,
					priority: route.priority,
					patterns,
					tollClass: route.tollClass,
					stripDigits: route.stripDigits,
					prependDigits: route.prependDigits ?? undefined,
					timeGate: this.routeTimeGate(route.timeConditionId, failoverNodeId, subject),
					recordEnabled: route.recordEnabled,
					callerIdNumberOverride: route.callerIdNumberOverride ?? undefined,
					// AFTER the inline strip/prepend, which the resolver applies first. The order and
					// its argument are in `translations-schema.ts`: the inline pair turns what fingers
					// did into the number meant, and the ruleset normalises that for the wire.
					translation: this.translationRuleset(
						route.translationRulesetId,
						subject,
						"translationRulesetId",
					),
					destinationNodeId: nodeId,
				}) as OutboundRule,
			);
		}

		const ordered = rules.sort(
			(left, right) =>
				left.priority - right.priority ||
				outboundSpecificity(right) - outboundSpecificity(left) ||
				(left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
		);

		return {
			rules: ordered,
			...(Object.keys(emergency).length === 0 ? {} : { emergency }),
			enabled: settings.outboundEnabled,
			noMatchNodeId: this.hangupNode(NO_MATCH_CAUSE),
			deniedNodeId: this.hangupNode(TOLL_DENIED_CAUSE),
		};
	}

	private compileTrunkPlan(
		route: OrgRoutingSnapshot["outboundRoutes"][number],
		continueOnCauses: readonly HangupCause[],
		subject: DiagnosticSubject,
	): OutboundTrunkPlan {
		const attempts: import("./plan").TrunkAttempt[] = [];
		const entries = [...route.trunkPriority].sort(
			(left, right) =>
				left.order - right.order ||
				(right.weight ?? 0) - (left.weight ?? 0) ||
				(left.trunkId < right.trunkId ? -1 : left.trunkId > right.trunkId ? 1 : 0),
		);

		for (const entry of entries) {
			const trunk = this.trunksById.get(entry.trunkId);
			if (trunk === undefined) {
				this.bag.warning(
					"unknown-trunk",
					`Outbound route "${route.name}" lists trunk "${entry.trunkId}", which no longer exists; it was dropped from the failover chain.`,
					subject,
					"trunkPriority",
				);
				continue;
			}
			if (!trunk.enabled) {
				this.bag.warning(
					"disabled-trunk",
					`Outbound route "${route.name}" lists trunk "${trunk.name}", which is disabled; it was dropped from the failover chain.`,
					subject,
					"trunkPriority",
				);
				continue;
			}
			attempts.push(
				compact({
					trunkId: trunk.id,
					name: trunk.name,
					kind: trunk.kind,
					sipDomain: trunk.sipDomain,
					sipProxy: trunk.sipProxy,
					outboundProxy: trunk.outboundProxy ?? undefined,
					transport: trunk.transport,
					codecPrefs: trunk.codecPrefs ?? undefined,
					maxChannels: trunk.maxChannels ?? undefined,
					callerIdNumberOverride: trunk.callerIdNumberOverride ?? undefined,
					order: entry.order,
					weight: entry.weight,
				}) as import("./plan").TrunkAttempt,
			);
		}

		if (attempts.length === 0) {
			this.bag.warning(
				"empty-trunk-list",
				`Outbound route "${route.name}" has no usable trunks; calls matching it take its failover destination.`,
				subject,
				"trunkPriority",
			);
		}

		return { attempts, continueOnCauses };
	}

	// -------------------------------------------------------------------------------------------
	// Emergency dialing
	// -------------------------------------------------------------------------------------------

	/**
	 * The emergency table and the one node it points at.
	 *
	 * Compiled unconditionally — a tenant with no trunks and no addresses still gets the table, and
	 * gets the warnings that say why dialing it will not reach anybody. The alternative, compiling
	 * it only when it would work, produces a silent artifact for exactly the organization that most
	 * needs to be told.
	 *
	 * The node is a `trunk-dial` with `emergency: true` rather than a new node kind, because a new
	 * kind is an artifact-version bump and this is not worth a flag day — see the note on
	 * {@link import("./plan").TrunkDialPlanNode}.
	 */
	private compileEmergency(): EmergencyMatchTable {
		this.reportInvalidEmergencyNumbers();
		const location = this.emergencyLocation();
		const attempts = this.emergencyTrunkAttempts();
		this.reportEmergencyReachability(attempts.length);

		if (!this.claimed.has(EMERGENCY_NODE_ID)) {
			this.claimed.add(EMERGENCY_NODE_ID);
			this.nodes.set(
				EMERGENCY_NODE_ID,
				compact({
					id: EMERGENCY_NODE_ID,
					kind: "trunk-dial",
					label: "Emergency",
					outboundRouteId: EMERGENCY_ROUTE_ID,
					// Unused: the emergency path is never toll-class gated. `internal` is the lowest
					// rank, so a reader that gates anyway lets every caller through rather than none.
					tollClass: "internal",
					attempts,
					continueOnCauses: EMERGENCY_CONTINUE_ON_CAUSES,
					// Never recorded by default. An emergency call may be recorded where the law
					// permits it, but that is a deliberate deployment decision and not a compiler's.
					recordEnabled: false,
					emergency: true,
					emergencyAddressId: location.emergencyAddressId,
					elin: location.elin,
					// No `failoverNodeId` and no time gate, on purpose: there is nowhere better for an
					// emergency call to go, and a gate is a thing that can close.
				}) as PlanNode,
			);
		}

		const table: Record<string, EmergencyRule> = {};
		for (const seed of emergencyNumbers(this.snapshot.settings?.emergencyNumbers)) {
			table[seed.dialed] = {
				dialed: seed.dialed,
				number: seed.number,
				destinationNodeId: EMERGENCY_NODE_ID,
			};
		}
		return sortRecordKeys(table);
	}

	private reportInvalidEmergencyNumbers(): void {
		for (const raw of invalidEmergencyNumbers(this.snapshot.settings?.emergencyNumbers)) {
			this.bag.warning(
				"invalid-emergency-number",
				`Emergency number ${JSON.stringify(raw)} is not a dial string this release can match; it was dropped. The compiled-in emergency numbers are unaffected.`,
				undefined,
				"settings.emergencyNumbers",
			);
		}
	}

	/**
	 * The organization's ELIN and the address it is registered against.
	 *
	 * Chosen from the DIDs, deterministically: enabled, voice-enabled, carrying an
	 * `emergencyAddressId` that resolves to a **validated** address, lowest E.164 first. Lowest
	 * rather than "the first the loader returned" for the usual reason — the artifact has to be
	 * byte-stable — and validated rather than merely assigned because an unvalidated address is one
	 * the carrier has not accepted, and presenting an ANI it will reject is worse than presenting
	 * the tenant's ordinary outbound caller id.
	 *
	 * Every DID that could have been a candidate and is not produces a warning naming that number.
	 */
	private emergencyLocation(): {
		readonly elin?: string;
		readonly emergencyAddressId?: string;
	} {
		let chosen: { readonly elin: string; readonly emergencyAddressId: string } | undefined;
		const unassigned: DiagnosticSubject[] = [];

		for (const did of [...this.snapshot.phoneNumbers].sort((left, right) =>
			left.e164 < right.e164 ? -1 : left.e164 > right.e164 ? 1 : 0,
		)) {
			if (!did.enabled || !did.voiceEnabled) {
				continue;
			}
			const subject: DiagnosticSubject = { kind: "phone-number", id: did.id, name: did.e164 };
			const addressId = did.emergencyAddressId ?? undefined;
			if (addressId === undefined || addressId.trim() === "") {
				unassigned.push(subject);
				continue;
			}
			// A loader that does not yet load the collection is a rollout state, not a tenant with
			// broken references — the same rule `mohClassName` follows, and for the same reason.
			if (this.snapshot.emergencyAddresses === undefined) {
				chosen ??= { elin: did.e164, emergencyAddressId: addressId };
				continue;
			}
			const address = this.emergencyAddressesById.get(addressId);
			if (address === undefined) {
				this.bag.warning(
					"dangling-emergency-address",
					`Number ${did.e164} names emergency address "${addressId}", which is not in this snapshot; it cannot serve as this organization's ELIN.`,
					subject,
					"emergencyAddressId",
				);
				continue;
			}
			if (!address.validated) {
				this.bag.warning(
					"dangling-emergency-address",
					`Number ${did.e164} names emergency address "${address.label}", which the carrier has not validated; it cannot serve as this organization's ELIN until it is.`,
					subject,
					"emergencyAddressId",
				);
				continue;
			}
			chosen ??= { elin: did.e164, emergencyAddressId: addressId };
		}

		// Only worth saying when the organization has DIDs at all, and only about the numbers that
		// could have carried the address. A tenant with no numbers has a different problem.
		for (const subject of unassigned) {
			this.bag.warning(
				"missing-emergency-address",
				`Number ${subject.name ?? subject.id} has no emergency address, so it cannot be used as an emergency callback number (ELIN). RAY BAUM'S Act requires a dispatchable location for every station that can dial 911.`,
				subject,
				"emergencyAddressId",
			);
		}

		return chosen === undefined ? {} : chosen;
	}

	/**
	 * The emergency failover chain: **every** trunk in the snapshot, disabled ones included.
	 *
	 * The ordering is documented because it has to be reproducible:
	 *
	 * 1. trunks named by an **enabled** outbound route, in (route priority asc, route id asc,
	 *    entry order asc) order — the tenant's own carrier preference, reused rather than invented;
	 * 2. then every remaining trunk, by name asc.
	 *
	 * Deduplicated by trunk id, first position wins. `enabled` is deliberately ignored at both
	 * steps: an administrator disables a trunk to stop it carrying ordinary traffic, which is not a
	 * statement about whether a call to a dispatcher should be attempted over it. Trying a disabled
	 * carrier costs one INVITE; not trying it costs the call.
	 */
	private emergencyTrunkAttempts(): readonly import("./plan").TrunkAttempt[] {
		const ordered: string[] = [];
		const seen = new Set<string>();

		const routes = [...this.snapshot.outboundRoutes]
			.filter((route) => route.enabled)
			.sort(
				(left, right) =>
					left.priority - right.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
			);
		for (const route of routes) {
			for (const entry of [...route.trunkPriority].sort(
				(left, right) => left.order - right.order,
			)) {
				if (this.trunksById.has(entry.trunkId) && !seen.has(entry.trunkId)) {
					seen.add(entry.trunkId);
					ordered.push(entry.trunkId);
				}
			}
		}
		for (const trunk of [...this.snapshot.trunks].sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		)) {
			if (!seen.has(trunk.id)) {
				seen.add(trunk.id);
				ordered.push(trunk.id);
			}
		}

		return ordered.map((trunkId, index) => {
			const trunk = this.trunksById.get(trunkId) as OrgRoutingSnapshot["trunks"][number];
			return compact({
				trunkId: trunk.id,
				name: trunk.name,
				kind: trunk.kind,
				sipDomain: trunk.sipDomain,
				sipProxy: trunk.sipProxy,
				outboundProxy: trunk.outboundProxy ?? undefined,
				transport: trunk.transport,
				codecPrefs: trunk.codecPrefs ?? undefined,
				maxChannels: trunk.maxChannels ?? undefined,
				// Deliberately NOT carried: a trunk's ordinary caller-id override would replace the
				// ELIN with the tenant's main number, and the ELIN is the whole point.
				order: index,
			}) as import("./plan").TrunkAttempt;
		});
	}

	private reportEmergencyReachability(attemptCount: number): void {
		if (attemptCount > 0) {
			return;
		}
		const stations = this.snapshot.extensions.filter((extension) => extension.enabled);
		if (stations.length === 0) {
			return;
		}
		const named = [...stations]
			.map((extension) => extension.number)
			.sort()
			.slice(0, 5);
		const suffix =
			stations.length > named.length ? ` and ${stations.length - named.length} more` : "";
		this.bag.warning(
			"no-emergency-route",
			`This organization has no trunk an emergency call could take, so extensions ${named.join(", ")}${suffix} cannot reach a dispatcher by dialing 911.`,
			undefined,
			"trunks",
		);
	}

	/**
	 * Internal numbers the emergency table takes precedence over.
	 *
	 * A warning rather than an error, and the emergency table wins rather than the extension:
	 * Kari's Law is not negotiable, and an organization that numbered a desk phone `911` has made a
	 * mistake that a diagnostic can explain and a routing table cannot compromise on.
	 */
	private reportEmergencyShadowing(emergency: EmergencyMatchTable): void {
		for (const dialed of Object.keys(emergency).sort()) {
			const claimed = this.internalNumbers.get(dialed);
			if (claimed === undefined) {
				continue;
			}
			this.bag.warning(
				"emergency-number-shadowed",
				`Internal number ${dialed} is claimed by ${claimed.kind} "${claimed.entityId}", but ${dialed} is an emergency number and is matched first; the ${claimed.kind} is no longer reachable by dialing it.`,
				{ kind: claimed.kind, id: claimed.entityId, name: claimed.number },
				"extensionNumber",
			);
		}
	}

	// -------------------------------------------------------------------------------------------
	// Call blocking and the extension index
	// -------------------------------------------------------------------------------------------

	private compileCallBlock(): readonly CompiledCallBlockRule[] {
		const compiled: CompiledCallBlockRule[] = [];
		for (const rule of sortById(this.snapshot.callBlockRules)) {
			if (!rule.enabled) {
				continue;
			}
			const subject: DiagnosticSubject = {
				kind: "call-block-rule",
				id: rule.id,
				name: rule.pattern,
			};
			const pattern = this.routePattern(rule.matchKind, rule.pattern, subject, "pattern");
			if (pattern === null) {
				continue;
			}
			compiled.push(
				compact({
					id: rule.id,
					pattern,
					direction: rule.direction,
					action: rule.action,
					label: rule.label ?? undefined,
				}) as CompiledCallBlockRule,
			);
		}

		// Most specific first; at equal specificity `allow` wins, which is how an allowlist entry
		// escapes a broad prefix block.
		return compiled.sort(
			(left, right) =>
				patternSpecificity(right.pattern) - patternSpecificity(left.pattern) ||
				allowFirst(left.action) - allowFirst(right.action) ||
				(left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
		);
	}

	private compileExtensionIndex(): Readonly<Record<string, ExtensionIndexEntry>> {
		const index: Record<string, ExtensionIndexEntry> = {};
		for (const extension of sortById(this.snapshot.extensions)) {
			if (!extension.enabled) {
				continue;
			}
			index[extension.number] = compact({
				extensionId: extension.id,
				number: extension.number,
				tollClass: extension.tollClass,
				enabled: extension.enabled,
				outboundCallerIdNumber: extension.outboundCallerIdNumber ?? undefined,
				outboundCallerIdName: extension.outboundCallerIdName ?? undefined,
				emergencyCallerIdNumber: extension.emergencyCallerIdNumber ?? undefined,
				pickupGroup: pickupGroupOf(extension),
				nodeId: this.extensionNode(extension),
			}) as ExtensionIndexEntry;
		}
		return sortRecordKeys(index);
	}

	// -------------------------------------------------------------------------------------------
	// Whole-graph checks
	// -------------------------------------------------------------------------------------------

	/**
	 * Reports cycles between IVR menus.
	 *
	 * A cycle is legal — "press 9 to return to the main menu" is a cycle — so it is a warning, not
	 * an error. What it earns is visibility: a menu tree a tenant cannot escape without hanging up
	 * is a real support burden, and the compiler is the only place that can see the whole graph.
	 * Self-reference is different and is rejected at construction: a menu whose option is itself
	 * would re-enter without ever playing a prompt.
	 */
	private detectIvrCycles(): void {
		const menuIds = [...this.nodes.values()]
			.filter((node) => node.kind === "ivr-menu")
			.map((node) => node.id)
			.sort();
		const state = new Map<PlanNodeId, "visiting" | "done">();
		const reported = new Set<PlanNodeId>();

		const visit = (id: PlanNodeId, stack: PlanNodeId[]): void => {
			const current = state.get(id);
			if (current === "done") {
				return;
			}
			if (current === "visiting") {
				const start = stack.indexOf(id);
				const cycle = stack.slice(start === -1 ? 0 : start);
				const key = [...cycle].sort().join(">");
				if (!reported.has(key)) {
					reported.add(key);
					const node = this.nodes.get(id);
					this.bag.warning(
						"ivr-cycle",
						`IVR menus form a loop (${[...cycle, id].map((entry) => this.nodes.get(entry)?.label ?? entry).join(" -> ")}); make sure a caller can always reach a person.`,
						{ kind: "ivr-menu", id, name: node?.label ?? id },
					);
				}
				return;
			}
			state.set(id, "visiting");
			stack.push(id);
			for (const reference of planNodeReferences(this.nodes.get(id) as PlanNode)) {
				if (this.nodes.get(reference)?.kind === "ivr-menu") {
					visit(reference, stack);
				}
			}
			stack.pop();
			state.set(id, "done");
		};

		for (const id of menuIds) {
			visit(id, []);
		}
	}

	/**
	 * The artifact's central invariant: every node reference resolves.
	 *
	 * The construction path already guarantees it — a reference is only ever an id the compiler
	 * claimed — so reaching this is a bug in the compiler rather than in a tenant's configuration.
	 * Checking it anyway costs one pass over the node table and converts a class of "the call went
	 * silent" incidents into a failed compile.
	 */
	private assertNodeClosure(): void {
		for (const id of [...this.nodes.keys()].sort()) {
			const node = this.nodes.get(id) as PlanNode;
			for (const reference of planNodeReferences(node)) {
				if (!this.nodes.has(reference)) {
					this.bag.error(
						"dangling-destination",
						`Compiled node "${id}" references "${reference}", which is not in the node table.`,
						{ kind: node.kind, id },
					);
				}
			}
		}
	}
}

// -----------------------------------------------------------------------------------------------
// Ordering helpers
// -----------------------------------------------------------------------------------------------

/**
 * A DID binding beats every pattern, then the pattern's own specificity decides. The offset is
 * larger than any pattern score, so the two axes cannot interfere.
 */
function inboundSpecificity(rule: InboundRule): number {
	return (rule.e164 === undefined ? 0 : 10_000_000) + patternSpecificity(rule.pattern);
}

/** An outbound route is as specific as its most specific pattern. */
function outboundSpecificity(rule: OutboundRule): number {
	return rule.patterns.reduce((best, pattern) => Math.max(best, patternSpecificity(pattern)), 0);
}

function allowFirst(action: CallBlockAction): number {
	return action === "allow" ? 0 : 1;
}

/**
 * A stored second count, made safe to put in an artifact.
 *
 * The follow-me ladder is JSON in a column rather than typed rows, so a negative delay or a
 * fractional timeout is a shape the database will happily hold. Clamping here means the engine
 * never has to defend against one on the call path.
 */
function wholeSeconds(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;
}

function greetingKey(voicemailBoxId: string, kind: VoicemailGreetingKind): string {
	return `${voicemailBoxId}:${kind}`;
}

/**
 * An extension's pickup group as the artifact carries it, or `undefined` when it has none.
 *
 * Trimmed, and a blank becomes ABSENT rather than a group named `""`. That distinction is the whole
 * behaviour: absent means "org-wide pickup, as before", and a group of `""` would silently put
 * every extension a loader left blank into one enormous shared group — which is the old behaviour
 * wearing a new label, and impossible to tell apart from the intended one when it goes wrong.
 *
 * Not lower-cased. `Sales` and `sales` are two groups because an administrator who typed both meant
 * two things, and case-folding a free-text label is the kind of helpfulness that merges a tenant's
 * departments without telling anybody. `compact` drops the key when this returns `undefined`.
 */
function pickupGroupOf(extension: ExtensionInput): string | undefined {
	const group = (extension.pickupGroup ?? "").trim();
	return group.length === 0 ? undefined : group;
}

/**
 * An object-storage key as a domain `MediaRef`.
 *
 * `object://` rather than `file://` because the key is not a path: it is a key into whatever the
 * deployment's object store is, and only the reader knows where that store is mounted or how it is
 * served. Rendering it as a path here would bake one deployment's layout into every artifact, and
 * artifacts outlive deployments.
 */
function objectMediaRef(objectKey: string): string {
	return `object://${objectKey.trim().replace(/^\/+/, "")}`;
}

function sortById<T extends { readonly id: string }>(rows: readonly T[]): readonly T[] {
	return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function sortByOrdinal<T extends { readonly id: string; readonly ordinal: number }>(
	rows: readonly T[],
): readonly T[] {
	return [...rows].sort(
		(left, right) =>
			left.ordinal - right.ordinal || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
	);
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
	const existing = map.get(key);
	if (existing === undefined) {
		map.set(key, [value]);
		return;
	}
	existing.push(value);
}

function sortedRecord<T>(map: ReadonlyMap<string, T>): Readonly<Record<string, T>> {
	const out: Record<string, T> = {};
	for (const key of [...map.keys()].sort()) {
		out[key] = map.get(key) as T;
	}
	return out;
}

function sortRecordKeys<T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) {
		out[key] = record[key] as T;
	}
	return out;
}

/**
 * Drops `undefined` values.
 *
 * Every artifact object goes through this, because `{ a: 1, b: undefined }` and `{ a: 1 }` are the
 * same value to a consumer but different to `JSON.stringify` — and therefore to the artifact hash.
 */
/**
 * A queue exit key, or `undefined` when the column says the queue has none.
 *
 * Upper-cased before the membership test so a tenant who typed `d` gets the DTMF `D` rather than a
 * silently disabled exit key, and rejected outright otherwise. A value the database's own check
 * constraint would have refused can still arrive here — from a fixture, from a loader that has not
 * been taught the column, or from a snapshot built by hand for a diagnostic — and the engine
 * compares this against a `DtmfEvent.digit` with `===`, so anything that would never match must not
 * reach it wearing the costume of a configured feature.
 */
function normalizeExitKey(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim().toUpperCase();
	if (trimmed === undefined || trimmed === "") {
		return undefined;
	}
	return (QUEUE_EXIT_KEYS as readonly string[]).includes(trimmed) ? trimmed : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (value[key] !== undefined) {
			out[key] = value[key];
		}
	}
	return out as T;
}
