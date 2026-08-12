/**
 * The compiler's input: a plain, read-only snapshot of everything in one organization's PBX
 * configuration that can influence where a call goes.
 *
 * # Why these types exist at all
 *
 * `@optimiq-voice/pbx-db` already has row types for all of this. Importing them would drag
 * `drizzle-orm` — and therefore a Postgres driver — into the engine, the resolver and every test,
 * and would make the routing rules move whenever a column is added for a reason routing does not
 * care about. So the compiler declares its own input shapes, mirroring only the columns that
 * affect routing, and the API's snapshot loader does the (mechanical, one-place) mapping.
 *
 * # Mapping to `packages/pbx-db/src/schema`
 *
 * | snapshot field            | table                    | notes                                     |
 * | ------------------------- | ------------------------ | ----------------------------------------- |
 * | `extensions`              | `extension`              | routing columns only; no SIP credentials  |
 * | `phoneNumbers`            | `phone_number`           | the DID and its default destination       |
 * | `trunks`                  | `trunk`                  | dial-target facts only; no secret refs     |
 * | `inboundRoutes`           | `inbound_route`          | 1:1                                        |
 * | `outboundRoutes`          | `outbound_route`         | 1:1                                        |
 * | `timeConditions`          | `time_condition`         | 1:1                                        |
 * | `timeConditionRules`      | `time_condition_rule`    | flat list, joined by `timeConditionId`     |
 * | `ivrMenus`                | `ivr_menu`               | 1:1                                        |
 * | `ivrMenuOptions`          | `ivr_menu_option`        | flat list, joined by `ivrMenuId`           |
 * | `ringGroups`              | `ring_group`             | 1:1                                        |
 * | `ringGroupDestinations`   | `ring_group_destination` | flat list, joined by `ringGroupId`         |
 * | `queues`                  | `queue`                  | queue row only; agents/tiers are live state|
 * | `voicemailBoxes`          | `voicemail_box`          | mailbox number, owner, PIN digest          |
 * | `voicemailGreetings`      | `voicemail_greeting`     | flat list, joined by `voicemailBoxId`      |
 * | `mohClasses`              | `moh_class`              | id → name, so a plan node can carry the name|
 * | `conferences`             | `conference`             | room number + PIN presence                 |
 * | `parkLots`                | `park_lot`               | slot range + timeout branch                |
 * | `pagingGroups`            | `paging_group`           | members joined in, not a flat list          |
 * | `featureCodes`            | `feature_code`           | 1:1                                        |
 * | `callBlockRules`          | `call_block_rule`        | 1:1 minus the hit counters                 |
 * | `emergencyAddresses`      | `emergency_address`      | id, label and `validated` only             |
 * | `settings`                | `org_setting` (subset)   | the handful of settings routing reads      |
 *
 * Collections are flat arrays rather than pre-joined trees on purpose: that is what
 * `select … where organization_id = $1` returns, so the loader stays a projection and the
 * compiler owns every join. Order is irrelevant — the compiler sorts everything it walks.
 *
 * Rows the loader must NOT filter out: disabled ones. `enabled = false` is a routing fact (it
 * produces a `disabled-entity` diagnostic and a deliberately absent match), not an absence.
 *
 * # Optional collections
 *
 * Four collections — `mohClasses`, `voicemailGreetings`, `emergencyAddresses` and `pagingGroups` —
 * are declared **optional** on
 * {@link OrgRoutingSnapshot} and listed in {@link OPTIONAL_SNAPSHOT_COLLECTIONS}. That is a
 * deliberate rollout affordance rather than a modelling accident: they were added after the API's
 * snapshot loader was written, and a required field would have made this package impossible to
 * release before the loader caught up. Absent and empty mean exactly the same thing everywhere —
 * the compiler defaults them to `[]`, the canonical form hashes them as `[]`, and the plan nodes
 * they enrich simply keep the field they would otherwise have gained. Once the loader populates
 * them the optionality is free to go.
 */

import type { DestinationInput } from "./destinations";

/** Values mirrored from `pbx-db` `extensions-schema.ts`. */
export const TOLL_CLASSES = ["internal", "local", "national", "international", "premium"] as const;

export type TollClass = (typeof TOLL_CLASSES)[number];

/**
 * Privilege ordering. A caller may take an outbound route whose class it *covers*, i.e. whose
 * rank is at or below the caller's own. `premium` sits at the top because premium-rate numbers are
 * the most expensive way for a compromised extension to burn a tenant's money.
 */
export const TOLL_CLASS_RANK: Readonly<Record<TollClass, number>> = {
	internal: 0,
	local: 1,
	national: 2,
	international: 3,
	premium: 4,
} as const;

export function tollClassCovers(holder: TollClass, required: TollClass): boolean {
	return TOLL_CLASS_RANK[holder] >= TOLL_CLASS_RANK[required];
}

/** Mirrored from `pbx-db` `extensions-schema.ts`. */
export const RECORD_POLICIES = ["none", "inbound", "outbound", "all", "on-demand"] as const;

export type RecordPolicy = (typeof RECORD_POLICIES)[number];

/** Mirrored from `pbx-db` `routing-schema.ts`. */
export const ROUTE_MATCH_KINDS = ["exact", "prefix", "regex", "any"] as const;

export type RouteMatchKind = (typeof ROUTE_MATCH_KINDS)[number];

/** Mirrored from `pbx-db` `ring-groups-schema.ts`. */
export const RING_GROUP_STRATEGIES = ["simultaneous", "sequential"] as const;

export type RingGroupStrategy = (typeof RING_GROUP_STRATEGIES)[number];

/**
 * Mirrored from `pbx-db` `queues-schema.ts`.
 *
 * The caller-priority scale: higher dequeues first, and 0 means unprioritised. It is the same range
 * `queue.caller.joined` has always published on, so nothing between the database, the compiler, the
 * engine and a wallboard has to rescale.
 */
export const QUEUE_PRIORITY_MIN = 0;
export const QUEUE_PRIORITY_MAX = 1000;

/**
 * The DTMF symbols a queue exit key may be.
 *
 * The sixteen a phone can actually send, and no others — the compiler normalises against this rather
 * than trusting the column's check constraint, because an artifact compiled from a snapshot loader
 * that did not select the column, or from a fixture, has never met that constraint.
 */
export const QUEUE_EXIT_KEYS = [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"*",
	"#",
	"A",
	"B",
	"C",
	"D",
] as const;

export type QueueExitKey = (typeof QUEUE_EXIT_KEYS)[number];

/** Mirrored from `pbx-db` `queues-schema.ts`. */
export const QUEUE_STRATEGIES = [
	"longest-idle",
	"ring-all",
	"round-robin",
	"top-down",
	"sequential",
	"random",
] as const;

export type QueueStrategy = (typeof QUEUE_STRATEGIES)[number];

/** Mirrored from `pbx-db` `ivr-schema.ts`. */
export const IVR_OPTION_MATCH_KINDS = ["digit", "regex"] as const;

export type IvrOptionMatchKind = (typeof IVR_OPTION_MATCH_KINDS)[number];

/**
 * Mirrored from `pbx-db` `voicemail-schema.ts`.
 *
 * A box has at most one **active** greeting per kind (a partial unique index enforces it), so the
 * set is a small closed vocabulary rather than an ordering.
 */
export const VOICEMAIL_GREETING_KINDS = ["unavailable", "busy", "name", "temporary"] as const;

export type VoicemailGreetingKind = (typeof VOICEMAIL_GREETING_KINDS)[number];

/**
 * Which greeting a call that is about to record hears, most specific first.
 *
 * `temporary` is the "I am on holiday until the 9th" greeting a user records from their phone, and
 * it is meant to override the standing one for as long as it is active — so it wins. `name` is the
 * directory recording and is never a call greeting, and `busy` is unreachable from here: an
 * extension's busy and no-answer branches compile to the *same* `voicemail:<id>:leave` node, so
 * the walker cannot tell the two apart at playback time. Splitting that node is a larger change
 * than this one and is recorded as a follow-up rather than half-done here.
 */
export const VOICEMAIL_LEAVE_GREETING_PRECEDENCE = ["temporary", "unavailable"] as const;

/** Mirrored from `pbx-db` `features-schema.ts`. */
export const FEATURE_CODE_ACTIONS = [
	"voicemail-check",
	"voicemail-direct",
	"voicemail-record-greeting",
	"call-park",
	"call-pickup",
	"group-pickup",
	"call-forward-all",
	"call-forward-busy",
	"call-forward-no-answer",
	"do-not-disturb",
	"follow-me",
	"intercom",
	"paging",
	"record-toggle",
	"redial",
	"echo-test",
	"queue-toggle",
	"agent-status",
	"eavesdrop",
	"transfer",
] as const;

export type FeatureCodeAction = (typeof FEATURE_CODE_ACTIONS)[number];

export type FeatureCodeParams = Readonly<Record<string, string | number | boolean>>;

/** Mirrored from `pbx-db` `features-schema.ts`. */
export const CALL_BLOCK_DIRECTIONS = ["inbound", "outbound", "both"] as const;

export type CallBlockDirection = (typeof CALL_BLOCK_DIRECTIONS)[number];

export const CALL_BLOCK_ACTIONS = ["block", "allow", "reject", "voicemail"] as const;

export type CallBlockAction = (typeof CALL_BLOCK_ACTIONS)[number];

export const CALL_BLOCK_MATCH_KINDS = ["exact", "prefix", "regex"] as const;

export type CallBlockMatchKind = (typeof CALL_BLOCK_MATCH_KINDS)[number];

/** Mirrored from `pbx-db` `trunks-schema.ts`. */
export const TRUNK_KINDS = ["register", "ip-auth"] as const;

export type TrunkKind = (typeof TRUNK_KINDS)[number];

export const SIP_TRANSPORTS = ["udp", "tcp", "tls", "ws", "wss"] as const;

export type SipTransport = (typeof SIP_TRANSPORTS)[number];

/** A single FreeSWITCH-style time predicate. Mirrors `pbx-db` `TimeRulePredicate`. */
export interface TimeRulePredicateInput {
	/** ISO weekdays, 1 = Monday … 7 = Sunday. */
	readonly weekdays?: readonly number[];
	/** Days of the month, 1–31. */
	readonly monthDays?: readonly number[];
	/** Months, 1–12. */
	readonly months?: readonly number[];
	/** Week of the month, 1–5. */
	readonly weeksOfMonth?: readonly number[];
	/** Inclusive local wall-clock window, `HH:MM` 24h. `from > to` means it crosses midnight. */
	readonly timeOfDay?: { readonly from: string; readonly to: string };
	/** Inclusive local date window, `YYYY-MM-DD`. Holidays live here. */
	readonly dateRange?: { readonly from: string; readonly to: string };
}

/** Common to every row: identity and the enabled flag. */
export interface RoutingEntityInput {
	readonly id: string;
	readonly enabled: boolean;
}

/**
 * One hop of an extension's follow-me ladder. Mirrors `pbx-db` `FollowMeTarget` verbatim.
 *
 * `destination` is a dial string, not a destination trio, for the same reason the forwarding
 * columns are: it is what a user types into the "also ring my mobile" box. An internal extension
 * number wins over an external one, exactly as it does for forwarding.
 */
export interface FollowMeTargetInput {
	readonly destination: string;
	readonly delaySeconds: number;
	readonly timeoutSeconds: number;
	/** Require the answering party to press a digit before the leg is bridged. */
	readonly confirm?: boolean;
}

/**
 * The `extension.follow_me` JSON column. Mirrors `pbx-db` `FollowMeConfig` verbatim.
 *
 * # There is no strategy column, so the compiler derives one
 *
 * `pbx-db` stores a delay and a timeout per target and nothing that says "ring these together" or
 * "ring these one after another" — unlike `ring_group`, which has an explicit `strategy`. The
 * compiler therefore reads the delays as the strategy, which is the reading FreeSWITCH's own
 * `follow_me` gives them: every target at delay zero rings at once, and the first non-zero delay is
 * a tenant saying "not yet, ring the desk first". See {@link FollowMePlan.strategy}.
 */
export interface FollowMeInput {
	readonly enabled: boolean;
	/** A busy target does not end a sequential ladder; the next hop is still tried. */
	readonly ignoreBusy?: boolean;
	/** In ladder order. The array IS the order — there is no ordinal column to sort by. */
	readonly targets: readonly FollowMeTargetInput[];
}

export interface ExtensionInput extends RoutingEntityInput {
	readonly number: string;
	readonly label: string;
	readonly callerIdName?: string | null;
	readonly callerIdNumber?: string | null;
	readonly outboundCallerIdName?: string | null;
	readonly outboundCallerIdNumber?: string | null;
	readonly emergencyCallerIdNumber?: string | null;
	readonly voicemailEnabled: boolean;
	readonly doNotDisturb: boolean;
	readonly forwardAllEnabled: boolean;
	readonly forwardAllDestination?: string | null;
	readonly forwardBusyEnabled: boolean;
	readonly forwardBusyDestination?: string | null;
	readonly forwardNoAnswerEnabled: boolean;
	readonly forwardNoAnswerDestination?: string | null;
	readonly forwardUnregisteredEnabled: boolean;
	readonly forwardUnregisteredDestination?: string | null;
	/**
	 * The follow-me ladder, if this extension has one.
	 *
	 * Optional so this package stays compilable against a loader that does not yet select the
	 * column — the same rollout rule the optional snapshot collections follow. An extension whose
	 * ladder is absent behaves exactly as it did before follow-me was compiled at all.
	 */
	readonly followMe?: FollowMeInput | null;
	/**
	 * The pickup group this extension belongs to, from `extension.pickup_group`.
	 *
	 * # What `*8` is supposed to mean
	 *
	 * Group pickup answers whatever is ringing IN THE CALLER'S OWN GROUP, and the group is the only
	 * thing that makes the feature usable above about twenty extensions: without it `*8` on a
	 * hundred-seat tenant hands the receptionist the warehouse's call, which reads as a phone-system
	 * bug and is not one. The engine cannot ask a database at call time, so the membership has to be
	 * in the artifact or the restriction cannot exist at all.
	 *
	 * # It is a free-text label, not a foreign key
	 *
	 * Upstream stores a string and so does this: groups are named by whoever administers the phones
	 * (`sales`, `floor-2`), they have no properties of their own, and a `pickup_group` table would
	 * add a join and a migration to express exactly the same set membership. Matching is exact after
	 * trimming; an empty or absent value means "no group", which is NOT the same as a group called
	 * `""` and is why the compiler drops blanks rather than carrying them.
	 *
	 * # Rollout
	 *
	 * Optional, like {@link ExtensionInput.followMe}, so this package stays compilable against a
	 * loader that does not select the column (`extension.pickup_group`, nullable text in
	 * `extensions-schema.ts`, supplied by the api snapshot loader). An extension whose group is
	 * absent behaves exactly as every extension did before groups were compiled: org-wide pickup,
	 * the documented fallback.
	 */
	readonly pickupGroup?: string | null;
	/**
	 * Whether an EXTERNAL caller is asked to record their name before this extension is rung, from
	 * `extension.call_screening`.
	 *
	 * A compiled fact rather than a runtime lookup for the usual reason: the decision is taken at the
	 * instant the leg is offered, by a process holding no database handle. Whose calls are screened —
	 * external only, never a colleague — is the engine's rule and not a field, because it is not
	 * something a tenant configures.
	 *
	 * Optional, like {@link ExtensionInput.followMe} and {@link ExtensionInput.pickupGroup}, so this
	 * package stays compilable against a loader that does not yet select the column. Absent is read
	 * as `false`, which is what every extension did before screening was compiled at all.
	 */
	readonly callScreening?: boolean | null;
	readonly recordPolicy: RecordPolicy;
	readonly mohClassId?: string | null;
	readonly tollClass: TollClass;
	readonly callTimeoutSeconds: number;
}

export interface PhoneNumberInput extends RoutingEntityInput, DestinationInput {
	/** Always E.164 with the leading `+`. */
	readonly e164: string;
	readonly label?: string | null;
	readonly callerIdNamePrefix?: string | null;
	readonly recordEnabled: boolean;
	readonly voiceEnabled: boolean;
	/**
	 * The dispatchable location registered against this number, from
	 * `phone_number.emergency_address_id`.
	 *
	 * A DID with one is a candidate ELIN: the number a PSAP calls back and the key it looks the
	 * address up by. A DID without one produces a `missing-emergency-address` **warning** rather
	 * than an error, because refusing to compile a tenant's whole routing over an unassigned
	 * address would take their working calls down to fix a call they have not yet placed.
	 */
	readonly emergencyAddressId?: string | null;
}

export interface TrunkInput extends RoutingEntityInput {
	readonly name: string;
	readonly kind: TrunkKind;
	readonly sipDomain: string;
	readonly sipProxy: string;
	readonly outboundProxy?: string | null;
	readonly transport: SipTransport;
	readonly codecPrefs?: string | null;
	readonly maxChannels?: number | null;
	readonly callerIdNumberOverride?: string | null;
	/** The shared ruleset applied to caller id ARRIVING on this trunk, before anything reads it. */
	readonly inboundTranslationRulesetId?: string | null;
}

/** One trunk in an outbound route's ordered failover list. Mirrors `pbx-db` `TrunkPriorityEntry`. */
export interface TrunkPriorityInput {
	readonly trunkId: string;
	readonly order: number;
	/** Relative share when several entries share an `order` (weighted round-robin). */
	readonly weight?: number;
}

export interface InboundRouteInput extends RoutingEntityInput, DestinationInput {
	readonly name: string;
	readonly priority: number;
	readonly matchKind: RouteMatchKind;
	readonly matchPattern?: string | null;
	/** Narrows the route to one DID instead of a pattern. */
	readonly phoneNumberId?: string | null;
	readonly callerIdPattern?: string | null;
	readonly failoverDestinationType?: DestinationInput["destinationType"] | null;
	readonly failoverDestinationRef?: string | null;
	readonly failoverDestinationData?: DestinationInput["destinationData"];
	readonly timeConditionId?: string | null;
	readonly recordEnabled: boolean;
}

export interface OutboundRouteInput extends RoutingEntityInput {
	readonly name: string;
	readonly priority: number;
	readonly matchKind: RouteMatchKind;
	/** Ordered alternatives; the first that matches wins. */
	readonly dialPatterns: readonly string[];
	readonly stripDigits: number;
	readonly prependDigits?: string | null;
	readonly tollClass: TollClass;
	readonly trunkPriority: readonly TrunkPriorityInput[];
	readonly timeConditionId?: string | null;
	readonly failoverDestinationType?: DestinationInput["destinationType"] | null;
	readonly failoverDestinationRef?: string | null;
	readonly failoverDestinationData?: DestinationInput["destinationData"];
	readonly callerIdNumberOverride?: string | null;
	readonly recordEnabled: boolean;
	/** The authorisation codes a caller must satisfy before any trunk on this route is dialled. */
	readonly pinSetId?: string | null;
	/** The shared rewrite applied AFTER this route's own strip/prepend. See `translations.ts`. */
	readonly translationRulesetId?: string | null;
}

/** Mirrored from `pbx-db` `time-conditions-schema.ts`. */
export const TIME_CONDITION_OVERRIDES = ["auto", "forced-match", "forced-no-match"] as const;

export type TimeConditionOverride = (typeof TIME_CONDITION_OVERRIDES)[number];

export interface TimeConditionInput extends RoutingEntityInput, DestinationInput {
	readonly name: string;
	/** IANA zone. Every rule is evaluated in this zone. */
	readonly timezone: string;
	/**
	 * The manual override, which short-circuits rule evaluation entirely.
	 *
	 * Optional for the rollout reason every late field here carries: a loader that does not select
	 * the column produces a condition that obeys its clock, which is what every condition did before
	 * the column existed.
	 */
	readonly override?: TimeConditionOverride | null;
	/** The star code that cycles the override, and the key a BLF lamp watches. */
	readonly overrideFeatureCode?: string | null;
	readonly nomatchDestinationType?: DestinationInput["destinationType"] | null;
	readonly nomatchDestinationRef?: string | null;
	readonly nomatchDestinationData?: DestinationInput["destinationData"];
}

export interface TimeConditionRuleInput extends RoutingEntityInput {
	readonly timeConditionId: string;
	readonly ordinal: number;
	readonly label?: string | null;
	/** All entries are ANDed. */
	readonly predicates: readonly TimeRulePredicateInput[];
}

export interface IvrMenuInput extends RoutingEntityInput {
	readonly name: string;
	readonly extensionNumber?: string | null;
	readonly parentId?: string | null;
	readonly greetingPromptId?: string | null;
	readonly shortGreetingPromptId?: string | null;
	readonly invalidPromptId?: string | null;
	readonly timeoutPromptId?: string | null;
	readonly digitTimeoutMs: number;
	readonly interDigitTimeoutMs: number;
	readonly maxDigits: number;
	readonly maxFailures: number;
	readonly maxTimeouts: number;
	readonly directDialEnabled: boolean;
	readonly timeoutDestinationType?: DestinationInput["destinationType"] | null;
	readonly timeoutDestinationRef?: string | null;
	readonly timeoutDestinationData?: DestinationInput["destinationData"];
	readonly invalidDestinationType?: DestinationInput["destinationType"] | null;
	readonly invalidDestinationRef?: string | null;
	readonly invalidDestinationData?: DestinationInput["destinationData"];
}

export interface IvrMenuOptionInput extends RoutingEntityInput, DestinationInput {
	readonly ivrMenuId: string;
	readonly ordinal: number;
	readonly matchKind: IvrOptionMatchKind;
	readonly matchValue: string;
	readonly label?: string | null;
}

export interface RingGroupInput extends RoutingEntityInput {
	readonly name: string;
	readonly extensionNumber?: string | null;
	readonly strategy: RingGroupStrategy;
	readonly ringTimeoutSeconds: number;
	readonly callerIdNamePrefix?: string | null;
	readonly ignoreBusy: boolean;
	readonly confirmEnabled: boolean;
	readonly confirmPromptId?: string | null;
	readonly mohClassId?: string | null;
	readonly ringbackPromptId?: string | null;
	readonly timeoutDestinationType?: DestinationInput["destinationType"] | null;
	readonly timeoutDestinationRef?: string | null;
	readonly timeoutDestinationData?: DestinationInput["destinationData"];
}

export interface RingGroupDestinationInput extends RoutingEntityInput, DestinationInput {
	readonly ringGroupId: string;
	readonly ordinal: number;
	readonly delaySeconds: number;
	readonly timeoutSeconds: number;
	readonly confirmRequired: boolean;
}

export interface QueueInput extends RoutingEntityInput {
	readonly name: string;
	readonly extensionNumber?: string | null;
	readonly strategy: QueueStrategy;
	readonly mohClassId?: string | null;
	readonly greetingPromptId?: string | null;
	readonly announcePromptId?: string | null;
	/**
	 * Whisper-on-answer: played to the ANSWERING AGENT alone, before the caller is bridged in, from
	 * `queue.agent_whisper_prompt_id`.
	 *
	 * A routing fact because it is a fact about the call: which prompt an agent hears depends on
	 * which queue the call came from, and the queue is what this node is. Optional for the rollout
	 * reason the other new fields here carry — a loader that does not select the column produces a
	 * queue that bridges the agent straight through, which is what every queue did before.
	 */
	readonly agentWhisperPromptId?: string | null;
	readonly maxWaitSeconds: number;
	readonly maxWaitNoAgentSeconds: number;
	readonly announcePositionEnabled: boolean;
	readonly announceFrequencySeconds: number;
	/**
	 * `queue.record_policy` — the same vocabulary `extension` and `trunk` carry, which replaced a
	 * `recordEnabled` boolean no runtime honoured.
	 *
	 * Optional for the rollout reason every other new field on this interface is optional: a loader
	 * that has not been taught the column yet produces a queue that records nothing, which is what
	 * every queue did before, rather than one the compiler refuses.
	 */
	readonly recordPolicy?: RecordPolicy | null;
	/** The single DTMF digit a waiting caller may press to leave. Null/absent disables it. */
	readonly exitKey?: string | null;
	readonly exitDestinationType?: DestinationInput["destinationType"] | null;
	readonly exitDestinationRef?: string | null;
	readonly exitDestinationData?: DestinationInput["destinationData"];
	/** `queue.default_priority`. A referring destination may override it per entry. */
	readonly defaultPriority?: number | null;
	readonly abandonedResumeAllowed?: boolean | null;
	readonly discardAbandonedAfterSeconds?: number | null;
	readonly timeoutDestinationType?: DestinationInput["destinationType"] | null;
	readonly timeoutDestinationRef?: string | null;
	readonly timeoutDestinationData?: DestinationInput["destinationData"];
}

export interface VoicemailBoxInput extends RoutingEntityInput {
	readonly mailboxNumber: string;
	readonly label?: string | null;
	readonly extensionId?: string | null;
	readonly mwiEnabled: boolean;
	readonly maxMessageSeconds: number;
	/**
	 * The mailbox PIN, as a digest in the `VOICEMAIL_PIN_HASH` format documented in
	 * `voicemail-pin.ts`. Never a plaintext PIN, and never the caller's to invent.
	 *
	 * This is the one secret-shaped field in the snapshot, and it is here for the same reason the
	 * rest of the snapshot is: the engine authenticates a `*97` on the call path, in a process that
	 * holds no database handle. A digest whose parameters are strong enough to survive a leaked
	 * artifact is the price of that, which is why the format is a *verified* contract rather than
	 * "whatever the API happened to write". Email addresses, transcription flags and message
	 * retention stay API-side: none of them changes what happens during a call.
	 */
	readonly pinHash?: string | null;
}

/**
 * One recorded greeting belonging to a mailbox.
 *
 * `active` rather than a pointer on the box: `pbx-db` models it that way to avoid a circular
 * foreign key, and it makes "activate this greeting" a single-table update. The compiler applies
 * {@link VOICEMAIL_LEAVE_GREETING_PRECEDENCE} over the active rows.
 *
 * Not a {@link RoutingEntityInput}: greetings have no `enabled` column. `active` is the flag, and
 * it means something different — an inactive greeting is a kept recording, not a switched-off one.
 */
export interface VoicemailGreetingInput {
	readonly id: string;
	readonly voicemailBoxId: string;
	readonly kind: VoicemailGreetingKind;
	/** Object-storage key for the audio. Never a filesystem path and never a `prompt` row id. */
	readonly objectKey: string;
	readonly active: boolean;
	readonly durationMs?: number | null;
	readonly label?: string | null;
}

/**
 * A music-on-hold class.
 *
 * Only the name, because the name is the only thing routing needs: every `mohClassId` in this
 * snapshot is a row id, and every media server addresses a class by its NAME. Resolving the two at
 * compile time is what keeps a database round trip off the call path. The stream URI, the sample
 * rate and the file list belong to the media server's own provisioning, not to a routing decision.
 */
export interface MohClassInput extends RoutingEntityInput {
	readonly name: string;
}

/**
 * A conference room.
 *
 * # Why there are two digests and a `requiresPin` that is neither
 *
 * `requiresPin` is `pin_hash !== null` as the loader computes it, and it exists independently of
 * {@link pinHash} for the same reason `VoicemailPlanNode` embeds a digest the compiler may refuse:
 * "this room wants a PIN" and "this release can verify that PIN" are different facts, and a reader
 * that conflated them would fail OPEN on a digest written under a format it cannot parse. A room
 * with `requiresPin` and no embedded digest is refused, not admitted.
 *
 * The moderator digest is a second, higher credential over the same room. Entering it admits the
 * caller AND satisfies {@link waitForModerator} for everyone already holding, which is the whole
 * point of the flag: without a way to tell a moderator from a participant, "hold until a moderator
 * arrives" can never end.
 */
export interface ConferenceInput extends RoutingEntityInput {
	readonly name: string;
	readonly roomNumber: string;
	readonly requiresPin: boolean;
	readonly maxMembers: number;
	readonly mohClassId?: string | null;
	readonly waitForModerator: boolean;
	readonly recordEnabled: boolean;
	/**
	 * The participant PIN, as a digest in the format `voicemail-pin.ts` defines. Never a PIN.
	 *
	 * Here for exactly the reason {@link VoicemailBoxInput.pinHash} is: the engine gates a room on
	 * the call path, in a process holding no database handle. One format, one parser, one verifier.
	 */
	readonly pinHash?: string | null;
	/** The moderator PIN digest, same format. Admits the caller as a moderator. */
	readonly moderatorPinHash?: string | null;
	/**
	 * `moderator_pin_hash !== null`, as the loader computes it. Optional so a loader that predates
	 * moderator support is a supported rollout state rather than a type error; absent is read as
	 * `moderatorPinHash != null`.
	 */
	readonly requiresModeratorPin?: boolean;
}

/**
 * A dispatchable location, from `emergency_address`.
 *
 * Only three columns, because only three affect a routing decision: the id a DID points at, the
 * label a diagnostic names, and `validated` — the gate the carrier applies before it will accept
 * the address for emergency origination. The street, the locality and the postal code are the
 * control plane's; nothing on the call path reads them, and an artifact carrying a tenant's
 * postal addresses into a KV bucket every engine can read is a liability with no upside.
 *
 * Not a {@link RoutingEntityInput}: `emergency_address` has no `enabled` column. `validated` is
 * the flag and it means something different — an unvalidated address is one the carrier has not
 * accepted yet, not one an admin switched off.
 */
export interface EmergencyAddressInput {
	readonly id: string;
	readonly label: string;
	readonly validated: boolean;
}

export interface ParkLotInput extends RoutingEntityInput {
	readonly name: string;
	readonly slotStart: number;
	readonly slotEnd: number;
	readonly timeoutSeconds: number;
	readonly mohClassId?: string | null;
	readonly timeoutDestinationType?: DestinationInput["destinationType"] | null;
	readonly timeoutDestinationRef?: string | null;
	readonly timeoutDestinationData?: DestinationInput["destinationData"];
}

/**
 * One handset in a paging group, mirroring `paging_group_member`.
 *
 * `extensionId` rather than a number, because the row stores a foreign key and the loader must not
 * start resolving things: turning the id into the number a page dials is the compiler's job, and it
 * is the step that produces the diagnostic when the extension is gone. `ordinal` is the fan-out
 * order the operator chose, and `enabled` is a member switched off without being removed — a
 * distinction the artifact keeps by dropping the member from the compiled list, not from the row.
 *
 * Not a {@link RoutingEntityInput} despite having an `enabled` column: it has no `id` the compiler
 * ever needs — a member is identified by the pair it names, and nothing points at one.
 */
export interface PagingGroupMemberInput {
	readonly extensionId: string;
	readonly ordinal: number;
	readonly enabled: boolean;
}

/**
 * A paging group, mirroring `paging_group`.
 *
 * # Why the members are nested here and ring-group destinations are not
 *
 * Every other parent/child pair in this snapshot is two flat collections joined by the compiler,
 * because that is what `select … where organization_id = $1` returns and it keeps the loader a
 * projection. Membership is the exception, and deliberately: a `paging_group_member` row carries no
 * destination trio, no delay, no timeout and no id anything else can point at — it is a
 * `(extension, position)` pair and nothing more. A second top-level collection for it would add a
 * `SNAPSHOT_COLLECTIONS` entry, a cache-invalidation entry and an index pass to express a list, and
 * the flat form's one real benefit — a child that several parents or several *kinds* of parent can
 * reference — does not apply to something only its own group can name.
 *
 * `duplex` is carried because it changes what the engine does with the member legs (one-way
 * announcement versus talkback), and `timeoutSeconds` because it bounds how long it waits for one
 * to come up. There is no destination trio: a page ends when the pager hangs up.
 */
export interface PagingGroupInput extends RoutingEntityInput {
	readonly name: string;
	readonly extensionNumber?: string | null;
	/** `false` is a one-way announcement: members hear the pager and cannot be heard. */
	readonly duplex: boolean;
	readonly timeoutSeconds: number;
	/** In any order — the compiler sorts by `ordinal`, as it does everywhere else. */
	readonly members: readonly PagingGroupMemberInput[];
}

export interface FeatureCodeInput extends RoutingEntityInput {
	/** Dialed string including the leading star, e.g. `*97`. */
	readonly code: string;
	readonly action: FeatureCodeAction;
	readonly params?: FeatureCodeParams | null;
	readonly label?: string | null;
}

export interface CallBlockRuleInput extends RoutingEntityInput {
	readonly pattern: string;
	readonly matchKind: CallBlockMatchKind;
	readonly direction: CallBlockDirection;
	readonly action: CallBlockAction;
	readonly label?: string | null;
}

/** Mirrored from `pbx-db` `call-flows-schema.ts`. */
export const CALL_FLOW_MODES = ["day", "night"] as const;

export type CallFlowMode = (typeof CALL_FLOW_MODES)[number];

/**
 * A day/night switch, mirroring `call_flow`.
 *
 * # Why the mode is here and not read live
 *
 * It is compiled, so a flip costs a recompile and the artifact stays a complete answer to "where do
 * this tenant's calls go right now". `call-flows-schema.ts` argues it against the park-slot
 * precedent at length: a park LOT's slot range is configuration and is compiled; a park SLOT's
 * occupancy is live state and is not. A mode is on the first side of that line — it changes a few
 * times a day, it must survive the fleet restarting, and an administrator edits it in a form as
 * readily as a receptionist toggles it from a handset.
 *
 * Both trios are REQUIRED. A flow with one destination is not a flow, and the database says so with
 * a non-optional shape check on the night trio.
 */
export interface CallFlowInput extends RoutingEntityInput, DestinationInput {
	readonly name: string;
	readonly extensionNumber?: string | null;
	/** The star code that toggles the mode, and the key a BLF lamp watches. */
	readonly featureCode?: string | null;
	readonly mode: CallFlowMode;
	readonly nightDestinationType?: DestinationInput["destinationType"] | null;
	readonly nightDestinationRef?: string | null;
	readonly nightDestinationData?: DestinationInput["destinationData"];
}

/** Mirrored from `pbx-db` `pins-schema.ts`. */
export interface PinSetEntryInput extends RoutingEntityInput {
	readonly pinSetId: string;
	readonly ordinal: number;
	readonly label?: string | null;
	/**
	 * The PIN digest, in the format `voicemail-pin.ts` defines. Never a PIN.
	 *
	 * Here for exactly the reason `VoicemailBoxInput.pinHash` and `ConferenceInput.pinHash` are: the
	 * engine challenges the caller on the call path, in a process holding no database handle. One
	 * format, one parser, one verifier — a second PIN format would be a second thing to get wrong.
	 */
	readonly pinHash: string;
}

/** An outbound authorisation-code list, mirroring `pin_set`. */
export interface PinSetInput extends RoutingEntityInput {
	readonly name: string;
	readonly promptId?: string | null;
	readonly failurePromptId?: string | null;
	readonly maxAttempts: number;
	readonly digitTimeoutMs: number;
}

/** One rewrite in a ruleset, mirroring `translation_rule`. */
export interface TranslationRuleInput extends RoutingEntityInput {
	readonly translationRulesetId: string;
	readonly ordinal: number;
	readonly label?: string | null;
	/** JavaScript regex source. Capture groups feed `replacement`. */
	readonly matchPattern: string;
	/** Dialable characters plus `$n` back-references. An empty string deletes the match. */
	readonly replacement: string;
}

/** A reusable, named digit-manipulation pipeline, mirroring `translation_ruleset`. */
export interface TranslationRulesetInput extends RoutingEntityInput {
	readonly name: string;
}

/**
 * A named destination, mirroring `destination_alias`.
 *
 * FusionPBX's "Bridge" with the raw dial string removed — see `aliases-schema.ts`. It compiles
 * FLAT: the compiler resolves `alias:<id>` to whatever the alias's own trio resolved to, and no
 * alias node ever appears in the artifact.
 */
export interface DestinationAliasInput extends RoutingEntityInput, DestinationInput {
	readonly name: string;
}

/**
 * A remote audio source usable as a destination, mirroring `audio_stream`.
 *
 * The fallback trio is required rather than optional because remote-URL playback is the one
 * capability in this snapshot whose availability depends on the media driver: ARI's
 * `POST /channels/{id}/play` takes `sound:`, `recording:`, `number:`, `digits:`, `characters:` and
 * `tone:`, and an arbitrary `https://` is not one of them. A stream with nowhere to go is a call
 * dropped in silence on any driver that cannot play it.
 */
export interface AudioStreamInput extends RoutingEntityInput {
	readonly name: string;
	readonly url: string;
	readonly answerFirst: boolean;
	/** Zero means "until the caller hangs up". */
	readonly maxSeconds: number;
	readonly fallbackDestinationType?: DestinationInput["destinationType"] | null;
	readonly fallbackDestinationRef?: string | null;
	readonly fallbackDestinationData?: DestinationInput["destinationData"];
}

/**
 * One step of a phrase, mirroring `phrase_step`.
 *
 * `phraseId` is a `prompt` row of kind `phrase`, and `promptId` is a `prompt` row that is not — a
 * phrase IS a prompt, which is what makes it storable in the eight `*_prompt_id` foreign keys that
 * already exist. See `media-schema.ts`.
 */
export interface PhraseStepInput extends RoutingEntityInput {
	readonly phraseId: string;
	readonly promptId: string;
	readonly ordinal: number;
}

/**
 * A `prompt` row, as far as routing is concerned.
 *
 * Only three fields, and only because of phrases: the compiler has to know which prompt ids are
 * PHRASES (so it can expand them) and which are audio (so it can refuse a nested phrase). The
 * object key, the duration and the checksum belong to the media layer; nothing about them changes a
 * routing decision.
 */
export interface PromptInput extends RoutingEntityInput {
	readonly name: string;
	/** `"phrase"` marks a sequence; everything else is a single piece of audio. */
	readonly kind: string;
}

/** Mirrored from `pbx-db` `directory-schema.ts`. */
export const DIRECTORY_SEARCH_FIELDS = ["last-name", "first-name", "full-name"] as const;

export type DirectorySearchField = (typeof DIRECTORY_SEARCH_FIELDS)[number];

/**
 * A dial-by-name directory, mirroring `dial_by_name_directory`.
 *
 * The compiler builds the digit map from the tenant's extensions and their mailboxes' recorded name
 * greetings; there is nothing about the entries on this row, because there is nothing to store —
 * membership is "every extension we can speak the name of", derived rather than curated.
 */
export interface DialByNameDirectoryInput extends RoutingEntityInput {
	readonly name: string;
	readonly extensionNumber?: string | null;
	readonly searchField: DirectorySearchField;
	readonly minDigits: number;
	readonly greetingPromptId?: string | null;
	readonly invalidPromptId?: string | null;
	readonly maxFailures: number;
	readonly timeoutDestinationType?: DestinationInput["destinationType"] | null;
	readonly timeoutDestinationRef?: string | null;
	readonly timeoutDestinationData?: DestinationInput["destinationData"];
}

/** An organization-wide short code, mirroring `speed_dial`. */
export interface SpeedDialInput extends RoutingEntityInput, DestinationInput {
	readonly code: string;
	readonly label: string;
}

/**
 * The org settings routing reads. Everything here has a compiler default, because a tenant that
 * has never opened the settings page must still be routable.
 */
export interface RoutingSettingsInput {
	/** Fallback IANA zone for a time condition that does not carry one. */
	readonly defaultTimezone?: string;
	/**
	 * Dial prefix that sends a call straight to a mailbox's greeting, e.g. `*99` + extension.
	 * Set to `null` to disable the internal voicemail-prefix table entirely.
	 */
	readonly voicemailPrefix?: string | null;
	/** Prefix that logs the caller into their own mailbox, e.g. `*98` + mailbox number. */
	readonly voicemailCheckPrefix?: string | null;
	/** Org-wide outbound caller id, used when neither route nor extension supplies one. */
	readonly outboundCallerIdNumber?: string | null;
	readonly outboundCallerIdName?: string | null;
	/**
	 * Hangup causes that let an outbound dial continue to the next trunk. Defaults to
	 * `RETRYABLE_HANGUP_CAUSES` from `@optimiq-voice/telephony` — never "all causes", because
	 * retrying a `CALL_REJECTED` on every trunk in the list is how toll-fraud loops start.
	 */
	readonly trunkContinueOnCauses?: readonly string[];
	/** Whether an internal caller may reach outbound routes at all (org-level kill switch). */
	readonly outboundEnabled?: boolean;
	/**
	 * Emergency dial strings this organization recognises **in addition to** the compiled-in NANP
	 * set (`emergency.ts`). One row for a tenant whose handsets are not all in North America.
	 *
	 * Additive, never replacing, and there is no setting that removes a seeded number: the
	 * compiled-in `911` is the one routing decision a tenant does not get to switch off.
	 */
	readonly emergencyNumbers?: readonly string[];
}

/** Everything the compiler is allowed to see about one organization. */
export interface OrgRoutingSnapshot {
	readonly organizationId: string;
	readonly settings?: RoutingSettingsInput;
	readonly extensions: readonly ExtensionInput[];
	readonly phoneNumbers: readonly PhoneNumberInput[];
	readonly trunks: readonly TrunkInput[];
	readonly inboundRoutes: readonly InboundRouteInput[];
	readonly outboundRoutes: readonly OutboundRouteInput[];
	readonly timeConditions: readonly TimeConditionInput[];
	readonly timeConditionRules: readonly TimeConditionRuleInput[];
	readonly ivrMenus: readonly IvrMenuInput[];
	readonly ivrMenuOptions: readonly IvrMenuOptionInput[];
	readonly ringGroups: readonly RingGroupInput[];
	readonly ringGroupDestinations: readonly RingGroupDestinationInput[];
	readonly queues: readonly QueueInput[];
	readonly voicemailBoxes: readonly VoicemailBoxInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly voicemailGreetings?: readonly VoicemailGreetingInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly mohClasses?: readonly MohClassInput[];
	readonly conferences: readonly ConferenceInput[];
	readonly parkLots: readonly ParkLotInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly pagingGroups?: readonly PagingGroupInput[];
	readonly featureCodes: readonly FeatureCodeInput[];
	readonly callBlockRules: readonly CallBlockRuleInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly emergencyAddresses?: readonly EmergencyAddressInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly callFlows?: readonly CallFlowInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly pinSets?: readonly PinSetInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly pinSetEntries?: readonly PinSetEntryInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly translationRulesets?: readonly TranslationRulesetInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly translationRules?: readonly TranslationRuleInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly destinationAliases?: readonly DestinationAliasInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly audioStreams?: readonly AudioStreamInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly prompts?: readonly PromptInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly phraseSteps?: readonly PhraseStepInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly directories?: readonly DialByNameDirectoryInput[];
	/** Optional — see the "optional collections" note in this file's header. */
	readonly speedDials?: readonly SpeedDialInput[];
}

/**
 * The snapshot collections, in the order the compiler walks them and the order they are hashed.
 *
 * This tuple is the single definition of "what routing depends on". `cache.ts` derives the
 * invalidation contract from it, and `canonicalizeSnapshot` derives the hash from it, so adding a
 * collection to the snapshot without adding it here is a compile error rather than a silently
 * stale cache.
 */
export const SNAPSHOT_COLLECTIONS = [
	"extensions",
	"phoneNumbers",
	"trunks",
	"inboundRoutes",
	"outboundRoutes",
	"timeConditions",
	"timeConditionRules",
	"ivrMenus",
	"ivrMenuOptions",
	"ringGroups",
	"ringGroupDestinations",
	"queues",
	"voicemailBoxes",
	"voicemailGreetings",
	"mohClasses",
	"conferences",
	"parkLots",
	"pagingGroups",
	"featureCodes",
	"callBlockRules",
	"emergencyAddresses",
	// The T2 admin block. Every one is optional, which is the same rollout affordance the four before
	// them took: `packages/routing` compiles them before the API's snapshot loader learns to select
	// them, and a tenant whose loader has not caught up compiles exactly what every release before
	// this one did.
	"callFlows",
	"pinSets",
	"pinSetEntries",
	"translationRulesets",
	"translationRules",
	"destinationAliases",
	"audioStreams",
	"prompts",
	"phraseSteps",
	"directories",
	"speedDials",
] as const satisfies readonly (keyof OrgRoutingSnapshot)[];

export type SnapshotCollection = (typeof SNAPSHOT_COLLECTIONS)[number];

/**
 * Collections a snapshot may omit entirely.
 *
 * Everything that walks {@link SNAPSHOT_COLLECTIONS} — the shape assertion, the canonical form, the
 * compiler's indexes — reads through {@link snapshotCollection}, so "absent" and "empty" are the
 * same input everywhere and neither the hash nor the artifact can depend on which one a loader
 * produced.
 */
export const OPTIONAL_SNAPSHOT_COLLECTIONS = [
	"voicemailGreetings",
	"mohClasses",
	"emergencyAddresses",
	// Newest of the four, and optional for exactly the reason the other three are: paging shipped
	// after the API's snapshot loader was written, and a required field would have made this package
	// impossible to release before the loader learned to select `paging_group`. A tenant whose
	// loader has not caught up compiles no paging nodes, which is what every release before this one
	// produced.
	"pagingGroups",
	"callFlows",
	"pinSets",
	"pinSetEntries",
	"translationRulesets",
	"translationRules",
	"destinationAliases",
	"audioStreams",
	"prompts",
	"phraseSteps",
	"directories",
	"speedDials",
] as const satisfies readonly SnapshotCollection[];

export type OptionalSnapshotCollection = (typeof OPTIONAL_SNAPSHOT_COLLECTIONS)[number];

const OPTIONAL_SNAPSHOT_COLLECTION_SET: ReadonlySet<string> = new Set(
	OPTIONAL_SNAPSHOT_COLLECTIONS,
);

export function isOptionalSnapshotCollection(
	collection: string,
): collection is OptionalSnapshotCollection {
	return OPTIONAL_SNAPSHOT_COLLECTION_SET.has(collection);
}

/**
 * One collection's rows, with an absent optional collection read as empty.
 *
 * The union of the row types has no useful common supertype beyond "carries an `id`",
 * which is exactly what every caller here needs (they sort by it), so that is what this returns.
 */
export function snapshotCollection(
	snapshot: OrgRoutingSnapshot,
	collection: SnapshotCollection,
): readonly { readonly id: string }[] {
	return (snapshot[collection] ?? []) as readonly { readonly id: string }[];
}

/** An empty but structurally complete snapshot. Handy for tests and for a brand-new tenant. */
export function emptySnapshot(organizationId: string): OrgRoutingSnapshot {
	return {
		organizationId,
		extensions: [],
		phoneNumbers: [],
		trunks: [],
		inboundRoutes: [],
		outboundRoutes: [],
		timeConditions: [],
		timeConditionRules: [],
		ivrMenus: [],
		ivrMenuOptions: [],
		ringGroups: [],
		ringGroupDestinations: [],
		queues: [],
		voicemailBoxes: [],
		voicemailGreetings: [],
		mohClasses: [],
		conferences: [],
		parkLots: [],
		pagingGroups: [],
		featureCodes: [],
		callBlockRules: [],
		emergencyAddresses: [],
		callFlows: [],
		pinSets: [],
		pinSetEntries: [],
		translationRulesets: [],
		translationRules: [],
		destinationAliases: [],
		audioStreams: [],
		prompts: [],
		phraseSteps: [],
		directories: [],
		speedDials: [],
	};
}
