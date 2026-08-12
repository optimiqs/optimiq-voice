/**
 * The compiled routing artifact — the whole of one organization's call routing, as data.
 *
 * # What it is
 *
 * FusionPBX compiles every feature into one central dialplan table and serves it to FreeSWITCH per
 * request, memcached under structured keys, invalidated by the PHP layer on save. That last part
 * is the load-bearing behaviour of the whole integration (`plans/reference/fusionpbx-inventory.md`
 * §5 item 1, §7 item 2), and it is the part upstream does by convention. Here it is a contract:
 * a versioned envelope, a content hash of the input, and a documented key.
 *
 * # Three match tables, one per context
 *
 * Contexts are the security boundary, not a naming convention
 * (`plans/reference/freeswitch-capabilities.md` §7). Unauthenticated traffic arriving from a
 * carrier resolves in `inbound` and *cannot reach* the outbound tables, because they are not in the
 * table it is allowed to read. Toll fraud rule #1 is therefore a property of the data structure
 * rather than a check somebody has to remember to write.
 *
 * # It is JSON
 *
 * Every field is plain data. The artifact is written to the `routing-cache` KV bucket and read
 * back by a different process, possibly a different release; anything that does not survive a JSON
 * round trip cannot be here. `canonicalJson` enforces it at hash time.
 */

import { RoutingArtifactShapeError, RoutingArtifactVersionError } from "./errors";
import type { Diagnostic } from "./diagnostics";
import type { CompiledFeatureCode } from "./feature-codes";
import type { CompiledPattern } from "./patterns";
import type { PlanNodeId, PlanNodeTable } from "./plan";
import type { CallBlockAction, CallBlockDirection, TollClass } from "./snapshot";
import type { CompiledTimeCondition } from "./time-conditions";
import type { CompiledTranslationRuleset } from "./translations";

/**
 * Artifact schema version.
 *
 * Bump on any change to the shapes in this file or in `plan.ts` that a reader compiled against the
 * previous version could misinterpret. A reader that finds an unexpected version must discard the
 * cache entry and recompile — never walk it, never "best effort".
 *
 * # v1 → v2: the `paging` node kind
 *
 * A new OPTIONAL FIELD is not a bump — an old reader ignores it and behaves as it did before, which
 * is why `TrunkDialPlanNode.emergency` and `ExtensionPlanNode.pickupGroup` arrived without one. A
 * new NODE KIND is different in kind, not in degree: a v1 reader switches over `node.kind` and has
 * no case for `"paging"`, so it meets a node it cannot execute in the middle of a live call. There
 * is no safe default for that — falling through would drop the call silently, and guessing would
 * dial somebody. Discarding the cache entry and recompiling is the only honest answer, and the
 * version is what tells the reader to do it.
 *
 * # v2 → v3: the T2 admin block's three node kinds
 *
 * `call-flow`, `stream` and `dial-by-name`, for exactly the reason `paging` bumped v1 → v2: three
 * new members of `PlanNodeKind`, and a v2 reader has a case for none of them. Everything else this
 * wave added is either an optional FIELD (`TrunkDialPlanNode.pinSet`,
 * `TimeConditionPlanNode`'s override handling, which a v2 reader ignores and evaluates the clock for)
 * or a new TABLE on this envelope (`phrases`, `speedDials`, `inboundTranslations`), which a v2
 * reader also ignores — neither of those would have been a bump on its own.
 */
export const ROUTING_ARTIFACT_VERSION = 3;

/** The three routing namespaces. The rpc contract's `routingContext` is one of these. */
export const ROUTING_CONTEXTS = ["inbound", "internal", "outbound"] as const;

export type RoutingContext = (typeof ROUTING_CONTEXTS)[number];

const ROUTING_CONTEXT_SET: ReadonlySet<string> = new Set(ROUTING_CONTEXTS);

export function isRoutingContext(value: unknown): value is RoutingContext {
	return typeof value === "string" && ROUTING_CONTEXT_SET.has(value);
}

/**
 * Whether a context may reach a trunk. Only `outbound` may, and an internal caller reaches it only
 * by an explicit second resolve after `internal` produced no match — never by falling through.
 */
export function contextReachesTrunks(context: RoutingContext): boolean {
	return context === "outbound";
}

/** A time-condition gate attached to a route. */
export interface RouteTimeGate {
	readonly timeConditionId: string;
	/** Taken when no rule matches. Absent means "fall through to the next route". */
	readonly closedNodeId?: PlanNodeId;
}

/** One inbound rule: match a DID (and optionally a caller), then go somewhere. */
export interface InboundRule {
	readonly id: string;
	readonly name: string;
	readonly priority: number;
	/** Set when the rule is bound to one DID rather than a pattern. The most specific match there is. */
	readonly phoneNumberId?: string;
	/** The DID's E.164, when `phoneNumberId` is set. Matched as an exact string. */
	readonly e164?: string;
	readonly pattern: CompiledPattern;
	/** Optional caller screen. Absent means "any caller". */
	readonly callerPattern?: CompiledPattern;
	readonly timeGate?: RouteTimeGate;
	readonly recordEnabled: boolean;
	readonly destinationNodeId: PlanNodeId;
	/** Taken when the destination is unreachable. */
	readonly failoverNodeId?: PlanNodeId;
	/** Prefixed onto the inbound caller-id name, from the DID. */
	readonly callerIdNamePrefix?: string;
}

/**
 * Inbound matching, in evaluation order.
 *
 * `rules` is pre-sorted (priority, then specificity, then id) so resolution is a linear walk.
 * `didDefaults` is the fallback: a DID with no matching route still goes to its own destination,
 * which is what makes "buy a number, point it at the IVR" a one-field operation.
 */
export interface InboundMatchTable {
	readonly rules: readonly InboundRule[];
	/** Keyed by E.164. The DID's own destination trio, used when no rule matched. */
	readonly didDefaults: Readonly<Record<string, InboundDidDefault>>;
	/** Taken when neither a rule nor a DID default applies. */
	readonly noMatchNodeId: PlanNodeId;
	/**
	 * Caller-id normalisation per trunk, keyed by `trunk.id`.
	 *
	 * Applied BEFORE the call-block screen and before the rule walk, which is the whole point: one
	 * carrier presents `0044…` and the next presents `+44…`, and a tenant's blocklist should not have
	 * to know which trunk a call arrived on. Absent for a trunk with no ruleset, which is nearly all
	 * of them, and absent entirely in an artifact compiled before rulesets existed — a reader that
	 * finds neither does what every release before this one did and screens the number as it arrived.
	 */
	readonly inboundTranslations?: Readonly<Record<string, CompiledTranslationRuleset>>;
}

export interface InboundDidDefault {
	readonly phoneNumberId: string;
	readonly e164: string;
	readonly enabled: boolean;
	readonly recordEnabled: boolean;
	readonly callerIdNamePrefix?: string;
	readonly destinationNodeId: PlanNodeId;
}

/** What an internal number resolves to, and which entity claimed it. */
export interface InternalNumberEntry {
	readonly number: string;
	readonly kind:
		| "extension"
		| "ring-group"
		| "ivr-menu"
		| "queue"
		| "conference"
		| "paging-group"
		| "voicemail"
		| "call-flow"
		| "dial-by-name"
		// A BARE-NUMERIC speed dial only. A star-prefixed one lives in `speedDials`, because a `*` in
		// this map's keys would be read as an extension number by everything that walks it.
		| "speed-dial";
	readonly entityId: string;
	readonly nodeId: PlanNodeId;
}

/** A park lot occupies a *range* of dialable slots, so it cannot live in the exact-match map. */
export interface ParkSlotRange {
	readonly parkLotId: string;
	readonly slotStart: number;
	readonly slotEnd: number;
	readonly nodeId: PlanNodeId;
}

/**
 * An organization-wide short code.
 *
 * Its own table rather than an entry in {@link InternalMatchTable.numbers} because the codes are not
 * all numbers: a `*01` cannot live in a map consulted AFTER feature codes have already had their
 * chance at anything beginning with a star. See `speed-dials-schema.ts` for the ordering argument.
 */
export interface SpeedDialEntry {
	readonly speedDialId: string;
	readonly code: string;
	readonly label: string;
	readonly nodeId: PlanNodeId;
}

/** A dial prefix that reaches a mailbox, e.g. `*99` + extension number. */
export interface VoicemailPrefixEntry {
	readonly prefix: string;
	readonly mode: "leave" | "check";
}

/**
 * A mailbox, addressable by number.
 *
 * Mailboxes are deliberately absent from `numbers`: a mailbox number is usually the same string as
 * its extension's number, so putting both in one map would make every extension with voicemail a
 * duplicate-number error. They are reached through a prefix instead, which is also how every phone
 * system this replaces does it.
 */
export interface MailboxEntry {
	readonly voicemailBoxId: string;
	readonly mailboxNumber: string;
	readonly leaveNodeId: PlanNodeId;
	readonly checkNodeId: PlanNodeId;
}

/**
 * One emergency dial string, and what it dials.
 *
 * A separate table from `OutboundRule` rather than a flag on one, because every field on an
 * outbound rule is a gate the emergency path must not have: no toll class, no time gate, no digit
 * manipulation, no `enabled`. What is left is "these digits, that node", which is this.
 *
 * `number` differs from the key for the `9`-prefixed forms: dialing `9911` reaches the trunk as
 * `911`, because the `9` was the tenant's outside-line habit and not part of the number.
 */
export interface EmergencyRule {
	/** The dialed string. Also the key this rule is stored under. */
	readonly dialed: string;
	/** What the trunk is asked to dial. */
	readonly number: string;
	/** The `trunk-dial` node with `emergency: true`. */
	readonly destinationNodeId: PlanNodeId;
}

/**
 * The emergency table, keyed by dial string.
 *
 * Present on BOTH {@link InternalMatchTable} and {@link OutboundMatchTable}, with the same node
 * ids, because an extension may dial `911` in either context and neither resolver may fall
 * through to the other to find it. Optional so an artifact compiled before emergency handling
 * existed parses; a reader that finds it absent has no emergency path, which is what it had.
 */
export type EmergencyMatchTable = Readonly<Record<string, EmergencyRule>>;

/**
 * Internal matching.
 *
 * Order is fixed and is part of the contract: **emergency numbers**, then feature codes, then
 * voicemail prefixes, then exact internal numbers, then park slots. Emergency comes first and
 * ahead of everything, including the call-block table, because Kari's Law says `911` is dialable
 * from any station with no prefix and no permission — which means nothing a tenant can configure
 * may sit in front of it. Feature codes come next because they start with `*` and no extension
 * may; voicemail prefixes come before numbers because `*99200` must not be read as an extension
 * named `*99200`.
 *
 * **Speed dials** sit between the voicemail prefixes and the numbers, and the position is argued at
 * length in `speed-dials-schema.ts`: after feature codes because a feature code must always win
 * (`*0` is seeded as eavesdrop with a required argument, so an unguarded `*01` would be swallowed as
 * "eavesdrop on extension 1"), and before exact numbers so a numeric code is reachable at all. The
 * compiler additionally claims numeric codes through the same duplicate-number check every dialable
 * entity goes through, so a speed dial numbered `200` collides loudly with extension 200 rather than
 * shadowing it.
 */
export interface InternalMatchTable {
	/** Consulted FIRST, ahead of `callBlock`. Absent in an artifact compiled before E911. */
	readonly emergency?: EmergencyMatchTable;
	/** Sorted by descending code length, so longest-code-wins is a linear walk. */
	readonly featureCodes: readonly CompiledFeatureCode[];
	readonly voicemailPrefixes: readonly VoicemailPrefixEntry[];
	/** Keyed by mailbox number, reached through a `voicemailPrefixes` entry. */
	readonly mailboxes: Readonly<Record<string, MailboxEntry>>;
	/**
	 * Organization speed dials, keyed by the exact code dialed. Absent in an artifact compiled before
	 * they existed, which a reader treats as "this tenant has none".
	 */
	readonly speedDials?: Readonly<Record<string, SpeedDialEntry>>;
	/** Exact dialable numbers: extensions, ring groups, IVR menus, queues, conference rooms. */
	readonly numbers: Readonly<Record<string, InternalNumberEntry>>;
	readonly parkSlots: readonly ParkSlotRange[];
	readonly noMatchNodeId: PlanNodeId;
}

/** One outbound rule. `patterns` are the route's `dialPatterns`, first match wins. */
export interface OutboundRule {
	readonly id: string;
	readonly name: string;
	readonly priority: number;
	readonly patterns: readonly CompiledPattern[];
	readonly tollClass: TollClass;
	readonly stripDigits: number;
	readonly prependDigits?: string;
	readonly timeGate?: RouteTimeGate;
	readonly recordEnabled: boolean;
	readonly callerIdNumberOverride?: string;
	/**
	 * The shared rewrite, applied AFTER `stripDigits`/`prependDigits`.
	 *
	 * Two mechanisms rather than one because they answer different questions: the inline pair turns
	 * what a user's fingers did into the number they meant ("strip the 9"), and the ruleset
	 * normalises that number for the wire ("ten digits become E.164"). Absent means the route dials
	 * what the inline pair produced, which is what every release before this one did.
	 */
	readonly translation?: CompiledTranslationRuleset;
	/** The `trunk-dial` node this route dials through. */
	readonly destinationNodeId: PlanNodeId;
}

export interface OutboundMatchTable {
	readonly rules: readonly OutboundRule[];
	/**
	 * Consulted BEFORE {@link enabled}, before the caller is looked up, before the toll-class gate
	 * and before `callBlock`. That ordering is the bypass, and it is the whole compliance story.
	 */
	readonly emergency?: EmergencyMatchTable;
	/** Whether the organization may place outbound calls at all. Emergency ignores it. */
	readonly enabled: boolean;
	/** Taken when nothing matched. */
	readonly noMatchNodeId: PlanNodeId;
	/** Taken when a route matched but the caller's toll class does not cover it. */
	readonly deniedNodeId: PlanNodeId;
}

/** A compiled caller-screening rule. */
export interface CompiledCallBlockRule {
	readonly id: string;
	readonly pattern: CompiledPattern;
	readonly direction: CallBlockDirection;
	readonly action: CallBlockAction;
	readonly label?: string;
	/** Where a `voicemail` action sends the call. Absent for every other action. */
	readonly nodeId?: PlanNodeId;
}

/** The extension facts a resolver needs about the *calling* party. */
export interface ExtensionIndexEntry {
	readonly extensionId: string;
	readonly number: string;
	readonly tollClass: TollClass;
	readonly enabled: boolean;
	readonly outboundCallerIdNumber?: string;
	readonly outboundCallerIdName?: string;
	readonly emergencyCallerIdNumber?: string;
	/**
	 * The caller's pickup group, when they are in one.
	 *
	 * THE reason this entry is read on the pickup path: a `*8` arrives with nothing but the calling
	 * party's number, and this index is the only place the engine can turn that number into a group
	 * without a database. Absent means the caller is in no group, which the engine treats as
	 * org-wide — the documented fallback, not a refusal.
	 */
	readonly pickupGroup?: string;
	readonly nodeId: PlanNodeId;
}

/**
 * An ordered prompt sequence.
 *
 * `steps` are `prompt` row ids in play order, already filtered to enabled steps whose audio exists
 * and is not itself a phrase — the compiler refuses nesting with a diagnostic rather than the media
 * layer recursing. Never empty: a phrase with no playable step compiles to no entry at all, so a
 * reader's miss means "play this id as a file" and never "play nothing".
 */
export interface CompiledPhrase {
	readonly promptId: string;
	readonly name: string;
	readonly steps: readonly string[];
}

/** Settings baked into the artifact, already defaulted. */
export interface CompiledRoutingSettings {
	readonly defaultTimezone: string;
	readonly outboundEnabled: boolean;
	readonly outboundCallerIdNumber?: string;
	readonly outboundCallerIdName?: string;
}

/**
 * The artifact envelope.
 *
 * `snapshotHash` is a hash of the *input*, not of this object: it answers "is the cached artifact
 * still the compilation of the current configuration?", which is the only question the invalidation
 * contract needs to ask. `compiledAt` is supplied by the caller — the compiler never reads a clock,
 * so two compiles of one snapshot are byte-identical and a redundant recompile writes nothing new.
 */
export interface RoutingArtifact {
	readonly artifactVersion: number;
	readonly organizationId: string;
	/** SHA-256 of the canonical snapshot. The cache-validity token. */
	readonly snapshotHash: string;
	/** ISO 8601 instant, injected by the caller. */
	readonly compiledAt: string;
	readonly settings: CompiledRoutingSettings;
	readonly nodes: PlanNodeTable;
	readonly timeConditions: Readonly<Record<string, CompiledTimeCondition>>;
	readonly inbound: InboundMatchTable;
	readonly internal: InternalMatchTable;
	readonly outbound: OutboundMatchTable;
	readonly callBlock: readonly CompiledCallBlockRule[];
	/**
	 * Phrases, keyed by the `prompt` row id of the phrase itself.
	 *
	 * The whole of "a phrase is playable anywhere a prompt is": every plan node keeps its bare
	 * `…PromptId`, and a reader about to play one looks here first — a hit is a sequence to play in
	 * order, a miss is a single piece of audio. That is one lookup in the media layer instead of a
	 * second nullable field on eight node kinds.
	 *
	 * Absent in an artifact compiled before phrases existed; a reader that finds it absent plays
	 * every prompt id as a single file, which is what every release before this one did.
	 */
	readonly phrases?: Readonly<Record<string, CompiledPhrase>>;
	/** Calling-party lookup, keyed by extension number. */
	readonly extensionsByNumber: Readonly<Record<string, ExtensionIndexEntry>>;
	/** Warnings that survived the compile. Errors never reach an artifact. */
	readonly diagnostics: readonly Diagnostic[];
}

/**
 * Validates an artifact read back from the cache.
 *
 * Version first, because a version mismatch explains every other failure that would follow. This
 * is a shape check, not a re-validation: the compiler already proved the graph is closed, and
 * re-walking a thousand nodes on every cache read would put that cost on the call path.
 */
export function parseRoutingArtifact(value: unknown): RoutingArtifact {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RoutingArtifactShapeError("$", "expected an object");
	}
	const candidate = value as Record<string, unknown>;

	if (candidate.artifactVersion !== ROUTING_ARTIFACT_VERSION) {
		throw new RoutingArtifactVersionError(ROUTING_ARTIFACT_VERSION, candidate.artifactVersion);
	}
	requireString(candidate, "organizationId");
	requireString(candidate, "snapshotHash");
	requireString(candidate, "compiledAt");
	requireObject(candidate, "nodes");
	requireObject(candidate, "settings");
	requireObject(candidate, "inbound");
	requireObject(candidate, "internal");
	requireObject(candidate, "outbound");
	requireObject(candidate, "timeConditions");
	requireObject(candidate, "extensionsByNumber");
	requireArray(candidate, "callBlock");
	requireArray(candidate, "diagnostics");

	return candidate as unknown as RoutingArtifact;
}

/** Non-throwing form, for a cache read that should fall back to a recompile. */
export function isRoutingArtifact(value: unknown): value is RoutingArtifact {
	try {
		parseRoutingArtifact(value);
		return true;
	} catch {
		return false;
	}
}

function requireString(candidate: Record<string, unknown>, field: string): void {
	if (typeof candidate[field] !== "string" || (candidate[field] as string).length === 0) {
		throw new RoutingArtifactShapeError(field, "expected a non-empty string");
	}
}

function requireObject(candidate: Record<string, unknown>, field: string): void {
	const value = candidate[field];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RoutingArtifactShapeError(field, "expected an object");
	}
}

function requireArray(candidate: Record<string, unknown>, field: string): void {
	if (!Array.isArray(candidate[field])) {
		throw new RoutingArtifactShapeError(field, "expected an array");
	}
}
