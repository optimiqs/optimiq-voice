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
 * | `voicemailBoxes`          | `voicemail_box`          | mailbox number + owner, nothing else       |
 * | `conferences`             | `conference`             | room number + PIN presence                 |
 * | `parkLots`                | `park_lot`               | slot range + timeout branch                |
 * | `featureCodes`            | `feature_code`           | 1:1                                        |
 * | `callBlockRules`          | `call_block_rule`        | 1:1 minus the hit counters                 |
 * | `settings`                | `org_setting` (subset)   | the handful of settings routing reads      |
 *
 * Collections are flat arrays rather than pre-joined trees on purpose: that is what
 * `select … where organization_id = $1` returns, so the loader stays a projection and the
 * compiler owns every join. Order is irrelevant — the compiler sorts everything it walks.
 *
 * Rows the loader must NOT filter out: disabled ones. `enabled = false` is a routing fact (it
 * produces a `disabled-entity` diagnostic and a deliberately absent match), not an absence.
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
}

export interface TimeConditionInput extends RoutingEntityInput, DestinationInput {
	readonly name: string;
	/** IANA zone. Every rule is evaluated in this zone. */
	readonly timezone: string;
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
	readonly maxWaitSeconds: number;
	readonly maxWaitNoAgentSeconds: number;
	readonly announcePositionEnabled: boolean;
	readonly announceFrequencySeconds: number;
	readonly recordEnabled: boolean;
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
}

export interface ConferenceInput extends RoutingEntityInput {
	readonly name: string;
	readonly roomNumber: string;
	readonly requiresPin: boolean;
	readonly maxMembers: number;
	readonly mohClassId?: string | null;
	readonly waitForModerator: boolean;
	readonly recordEnabled: boolean;
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
	readonly conferences: readonly ConferenceInput[];
	readonly parkLots: readonly ParkLotInput[];
	readonly featureCodes: readonly FeatureCodeInput[];
	readonly callBlockRules: readonly CallBlockRuleInput[];
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
	"conferences",
	"parkLots",
	"featureCodes",
	"callBlockRules",
] as const satisfies readonly (keyof OrgRoutingSnapshot)[];

export type SnapshotCollection = (typeof SNAPSHOT_COLLECTIONS)[number];

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
		conferences: [],
		parkLots: [],
		featureCodes: [],
		callBlockRules: [],
	};
}
