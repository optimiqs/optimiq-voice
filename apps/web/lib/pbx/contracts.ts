/**
 * The PBX contract, mirrored — never imported.
 *
 * `apps/api/src/pbx/**` is a Nest application: importing its DTOs here would drag `zod/v4`,
 * `@nestjs/common` and `@optimiq-voice/pbx-db` (and therefore Drizzle and a Postgres driver) into
 * the browser bundle. So the closed sets and the row shapes are restated, and
 * `contracts.spec.ts` asserts they still match the values the server exports.
 *
 * Rows arrive as the Drizzle row, camelCased, with `Date` columns serialized to ISO strings. Every
 * entity carries `id`, `organizationId`, `createdAt` and `updatedAt`; only the fields the admin UI
 * actually renders or edits are declared below.
 */

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

export interface PagedEnvelope<T> {
	readonly data: readonly T[];
	readonly total: number;
	readonly page: number;
	readonly limit: number;
	readonly totalPages: number;
}

export interface ItemEnvelope<T> {
	readonly data: T;
}

/** Every mutation returns this. `warnings` is always present, possibly empty. */
export interface MutationEnvelope<T> {
	readonly data: T;
	readonly warnings: readonly WireDiagnostic[];
}

/**
 * A compiler diagnostic, flattened for the wire.
 *
 * `field` is the last segment of `path` when that segment names a column — which is exactly what
 * lets `routing.compile` say "this inbound route's destinationRef dangles" and have the message
 * land on the control that produced it.
 */
export interface WireDiagnostic {
	readonly severity: "error" | "warning" | "info";
	readonly code: string;
	readonly message: string;
	readonly subject?: { readonly kind: string; readonly id: string; readonly name?: string | null };
	readonly path?: string;
	readonly field?: string;
}

/** A row that points at the entity a delete was refused for. */
export interface EntityReference {
	readonly kind: string;
	readonly id: string;
	readonly name: string | null;
	readonly field: string;
}

export interface DestinationIssue {
	readonly field: string;
	readonly code: string;
	readonly message: string;
}

export interface ValidationIssue {
	readonly field: string;
	readonly code: string;
	readonly message: string;
}

// ---------------------------------------------------------------------------------------------
// Closed sets, mirrored from @optimiq-voice/pbx-db and @optimiq-voice/routing
// ---------------------------------------------------------------------------------------------

/**
 * Every destination a compiled route may point at, in the server's order.
 *
 * The four the T2 admin block added sit between `time-condition` and `external`, which is where
 * `packages/pbx-db/src/destinations.ts` puts them — and the order is the order a select reads, so
 * `contracts.spec.ts` compares these as arrays rather than as sets.
 *
 * `alias` is the odd member and is entity-backed like the rest. It compiles FLAT: an alias produces
 * no plan node of its own, it resolves to whatever its target resolved to. That is why it may be
 * chosen anywhere a destination may be, and why a picker needs to know nothing special about it.
 */
export const DESTINATION_TYPES = [
	"extension",
	"ivr",
	"ring-group",
	"queue",
	"voicemail",
	"conference",
	"park",
	"paging-group",
	"time-condition",
	"call-flow",
	"stream",
	"dial-by-name",
	"alias",
	"external",
	"application",
	"hangup",
] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export type DestinationKind = "entity" | "value" | "terminal";

/**
 * Which half of the trio each type populates. `entity` needs `destinationRef`; `value` needs
 * `destinationData.value` and must NOT carry a ref; `terminal` carries neither (though `hangup`
 * may carry a `cause`).
 */
export const DESTINATION_TYPE_KINDS: Readonly<Record<DestinationType, DestinationKind>> = {
	extension: "entity",
	ivr: "entity",
	"ring-group": "entity",
	queue: "entity",
	voicemail: "entity",
	conference: "entity",
	park: "entity",
	"paging-group": "entity",
	"time-condition": "entity",
	"call-flow": "entity",
	stream: "entity",
	"dial-by-name": "entity",
	alias: "entity",
	external: "value",
	application: "value",
	hangup: "terminal",
};

/**
 * The two positions of a call flow's switch. Mirrors `CALL_FLOW_MODES`.
 *
 * `day` is the default position of a fresh row, and neither name is a claim about the clock: a flow
 * is in whichever mode somebody last put it in, and nothing moves it automatically. Which is the
 * whole point — a time condition is the clock, and a call flow is the override that ignores it.
 */
export const CALL_FLOW_MODES = ["day", "night"] as const;
export type CallFlowMode = (typeof CALL_FLOW_MODES)[number];

/**
 * Whether a time condition's clock is being obeyed, and if not, which way it is overruled.
 *
 * The names say what they DO rather than what they mean, and the server is explicit about why:
 * plenty of conditions match on "out of hours" and route the match branch to voicemail, so
 * `forced-open` / `forced-closed` would be a guess about somebody else's configuration. Any UI that
 * renders these must resist the same temptation.
 *
 * The order is the RING the toggle endpoint walks when it is called with no target state —
 * `auto → forced-match → forced-no-match → auto` — which is what pressing the star code does.
 */
export const TIME_CONDITION_OVERRIDES = ["auto", "forced-match", "forced-no-match"] as const;
export type TimeConditionOverride = (typeof TIME_CONDITION_OVERRIDES)[number];

/** Which part of a name a dial-by-name directory matches keypad digits against. */
export const DIRECTORY_SEARCH_FIELDS = ["last-name", "first-name", "full-name"] as const;
export type DirectorySearchField = (typeof DIRECTORY_SEARCH_FIELDS)[number];

/**
 * The four organization quotas, in the order the usage screen renders them.
 *
 * Mirrors `ORG_LIMIT_NAMES` in `apps/api/src/pbx/org-limits/org-limits.ts`. The list is also the
 * `limit` value a `PBX_LIMIT_REACHED` 409 names, so a client can switch on it.
 */
export const ORG_LIMIT_NAMES = [
	"maxExtensions",
	"maxTrunks",
	"maxConcurrentCalls",
	"maxStorageMb",
] as const;
export type OrgLimitName = (typeof ORG_LIMIT_NAMES)[number];

export const RECORD_POLICIES = ["none", "inbound", "outbound", "all", "on-demand"] as const;
export type RecordPolicy = (typeof RECORD_POLICIES)[number];

export const TOLL_CLASSES = ["internal", "local", "national", "international", "premium"] as const;
export type TollClass = (typeof TOLL_CLASSES)[number];

export const TRUNK_KINDS = ["register", "ip-auth"] as const;
export type TrunkKind = (typeof TRUNK_KINDS)[number];

export const TRUNK_STATUSES = ["unknown", "up", "down", "degraded", "disabled"] as const;
export type TrunkStatus = (typeof TRUNK_STATUSES)[number];

export const SIP_TRANSPORTS = ["udp", "tcp", "tls"] as const;
export type SipTransport = (typeof SIP_TRANSPORTS)[number];

export const ROUTE_MATCH_KINDS = ["exact", "prefix", "regex", "any"] as const;
export type RouteMatchKind = (typeof ROUTE_MATCH_KINDS)[number];

/**
 * Which side of a call a screening rule reads.
 *
 * `inbound` matches the CALLER's number, `outbound` matches the DIALED string, and `both` applies
 * the rule to each in its own direction — which is how one row expresses "we do not talk to this
 * number, in either direction". The three are not a display preference: the server's unique index
 * is `(organization_id, direction, pattern)`, so the same pattern in two directions is two rows and
 * `both` is a third, distinct one rather than a shorthand for the first two.
 */
export const CALL_BLOCK_DIRECTIONS = ["inbound", "outbound", "both"] as const;
export type CallBlockDirection = (typeof CALL_BLOCK_DIRECTIONS)[number];

/**
 * What happens on a match.
 *
 * `allow` is NOT the absence of a rule — it is an entry that WINS over a `block` rule at the same
 * specificity, which is the only way an allowlisted number escapes a broad prefix block. That makes
 * it the dangerous member of this set rather than the harmless one, and it is why the API gives
 * screening its own `call-block.write` instead of riding on `routes.write`: a grant that can write
 * allow rules can quietly re-admit a caller the organization decided to exclude.
 *
 * `voicemail` carries no destination. The compiler sends the caller to the CALLEE's own mailbox —
 * the box the dialed extension already owns — rather than to an arbitrary destination the rule
 * picked, which is why `call_block_rule` has no destination trio and nothing in the picker points
 * at one.
 */
export const CALL_BLOCK_ACTIONS = ["block", "allow", "reject", "voicemail"] as const;
export type CallBlockAction = (typeof CALL_BLOCK_ACTIONS)[number];

/**
 * How `pattern` is read. Deliberately narrower than {@link ROUTE_MATCH_KINDS}, which also has
 * `any`: a screening rule that matched everything would be a tenant-wide outage wearing a
 * blocklist's name.
 */
export const CALL_BLOCK_MATCH_KINDS = ["exact", "prefix", "regex"] as const;
export type CallBlockMatchKind = (typeof CALL_BLOCK_MATCH_KINDS)[number];

export const IVR_OPTION_MATCH_KINDS = ["digit", "regex"] as const;
export type IvrOptionMatchKind = (typeof IVR_OPTION_MATCH_KINDS)[number];

export const RING_GROUP_STRATEGIES = ["simultaneous", "sequential"] as const;
export type RingGroupStrategy = (typeof RING_GROUP_STRATEGIES)[number];

/**
 * How a shared line offers a call to its appearances. Mirrors `SHARED_LINE_STRATEGIES`.
 *
 * `simultaneous` lights and rings every appearance at once (the receptionist case); `sequential`
 * walks them in ordinal order (the boss-then-assistant case). The same two words a ring group's
 * strategy uses, and deliberately its OWN set: a shared line is not a ring group, and folding the
 * two lists together is exactly the tidy-up the drift gate refuses — `contracts.spec.ts` compares
 * each against its own server tuple.
 */
export const SHARED_LINE_STRATEGIES = ["simultaneous", "sequential"] as const;
export type SharedLineStrategy = (typeof SHARED_LINE_STRATEGIES)[number];

export const QUEUE_STRATEGIES = [
	"longest-idle",
	"ring-all",
	"round-robin",
	"top-down",
	"sequential",
	"random",
] as const;
export type QueueStrategy = (typeof QUEUE_STRATEGIES)[number];

export const QUEUE_AGENT_STATUSES = [
	"logged-out",
	"available",
	"on-break",
	"on-call",
	"wrap-up",
	"unavailable",
] as const;
export type QueueAgentStatus = (typeof QUEUE_AGENT_STATUSES)[number];

/** How the engine reaches an agent: their extension, or a literal number. */
export const QUEUE_AGENT_CONTACT_KINDS = ["extension", "external"] as const;
export type QueueAgentContactKind = (typeof QUEUE_AGENT_CONTACT_KINDS)[number];

/**
 * The caller-priority scale, mirroring `QUEUE_PRIORITY_MIN` / `QUEUE_PRIORITY_MAX` in
 * `packages/pbx-db`.
 *
 * Higher dequeues first, and 0 means unprioritised — the direction every `mod_callcenter`
 * deployment already assumes, which is why the mirror carries the bounds rather than the form
 * inventing its own. The same range is what `queue.caller.joined` publishes on, so a wallboard
 * never has to rescale between the configured default and the live entry.
 */
export const QUEUE_PRIORITY_MIN = 0;
export const QUEUE_PRIORITY_MAX = 1000;

/**
 * The DTMF digits a phone can actually send, as one character.
 *
 * Mirrors the `queue_exit_key_shape_check` constraint and the DTO's regex. It is a CHARACTER SET
 * rather than a free string because the engine compares the stored key against a `DtmfEvent.digit`
 * with `===`: a row holding `"1 "` or a lower-case `d` is a queue whose exit key silently never
 * fires, and the operator would have configured a feature that does nothing.
 */
export const QUEUE_EXIT_KEY_PATTERN = /^[0-9*#A-D]$/u;

export const VOICEMAIL_EMAIL_MODES = ["none", "notify", "attach"] as const;
export type VoicemailEmailMode = (typeof VOICEMAIL_EMAIL_MODES)[number];

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

export const ROUTING_CONTEXTS = ["inbound", "internal", "outbound"] as const;
export type RoutingContext = (typeof ROUTING_CONTEXTS)[number];

/**
 * Who a ledger entry is attributed to.
 *
 * The split matters to anything that renders one: a `user` entry has `actorUserId` and no
 * `actorRef`, and an `api-key` or `service` entry has `actorRef` and no `actorUserId` — the server
 * refuses to write a key id into a column documented as `user.id`, so a screen that reached for
 * `actorUserId` on machine traffic would render a blank instead of the key that did it.
 */
export const AUDIT_ACTOR_TYPES = ["user", "api-key", "service", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** What a matching ACL entry does. Mirrors `SIP_ACL_ACTIONS` in `@optimiq-voice/pbx-db`. */
export const SIP_ACL_ACTIONS = ["allow", "deny"] as const;
export type SipAclAction = (typeof SIP_ACL_ACTIONS)[number];

/**
 * Which surface an ACL entry guards, and the same four an auth-failure event is filed under.
 *
 * Not one list with a "everywhere" option: the server's unique index is
 * `(organization_id, scope, network)`, so the same network in two scopes is two rows and a form
 * that offered "all scopes" would be offering to write four rows behind one button. Keeping them
 * apart is what the server calls the anti-toll-fraud boundary — `provisioning` is already read by
 * the device provisioner, and widening a rule from it to `trunk` is a decision, not a checkbox.
 */
export const SIP_ACL_SCOPES = ["registration", "trunk", "provisioning", "api"] as const;
export type SipAclScope = (typeof SIP_ACL_SCOPES)[number];

/**
 * Why an attempt was refused — the REASON, never the surface. The surface is the scope.
 *
 * `unknown-account` and `disabled-account` are deliberately separate and mean opposite things to
 * whoever is reading the log: the first is somebody guessing, the second is a credential that
 * outlived its authorisation. A screen that folded them together would hide the one an
 * administrator can act on today.
 */
export const SIP_AUTH_EVENT_TYPES = [
	"acl-denied",
	"rate-limited",
	"unknown-account",
	"bad-credentials",
	"token-invalid",
	"token-expired",
	"disabled-account",
] as const;
export type SipAuthEventType = (typeof SIP_AUTH_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export interface DestinationData {
	readonly value?: string;
	readonly args?: Readonly<Record<string, string | number | boolean>>;
	readonly cause?: string;
}

export interface EntityRow {
	readonly id: string;
	readonly organizationId: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface FollowMeTarget {
	readonly destination: string;
	readonly delaySeconds: number;
	readonly timeoutSeconds: number;
	readonly confirm?: boolean;
}

/**
 * `sipSecretRef` and `sipPasswordHa1` are absent, and their absence is the contract.
 *
 * Both are in `secretColumns` on the server's `EXTENSION_RESOURCE`, so they are stripped from
 * every list, get, create and update body. They remain writable — `extensionCreateFormSchema`
 * still requires a reference, and the edit form sends one when the operator types one — which is
 * the asymmetry worth naming: a credential goes in and does not come back, so nothing here can
 * render it, pre-fill it, or diff against it.
 */
export interface ExtensionRow extends EntityRow {
	readonly number: string;
	readonly label: string;
	readonly callerIdName: string | null;
	readonly callerIdNumber: string | null;
	readonly outboundCallerIdName: string | null;
	readonly outboundCallerIdNumber: string | null;
	readonly emergencyCallerIdName: string | null;
	readonly emergencyCallerIdNumber: string | null;
	readonly voicemailEnabled: boolean;
	readonly doNotDisturb: boolean;
	readonly forwardAllEnabled: boolean;
	readonly forwardAllDestination: string | null;
	readonly forwardBusyEnabled: boolean;
	readonly forwardBusyDestination: string | null;
	readonly forwardNoAnswerEnabled: boolean;
	readonly forwardNoAnswerDestination: string | null;
	readonly forwardUnregisteredEnabled: boolean;
	readonly forwardUnregisteredDestination: string | null;
	readonly followMe: {
		readonly enabled: boolean;
		readonly ignoreBusy?: boolean;
		readonly targets: readonly FollowMeTarget[];
	} | null;
	readonly recordPolicy: RecordPolicy;
	readonly tollClass: TollClass;
	/**
	 * The `*8` pickup group this extension belongs to, or `null` for none.
	 *
	 * A free-text label, not a reference: groups are named by whoever administers the phones
	 * (`sales`, `floor-2`) and have no rows of their own. Matching is exact and case-sensitive in
	 * the compiled artifact, so `Sales` and `sales` are two groups.
	 *
	 * `null` is not a group called `""` — it means the extension is in no group, and the engine
	 * falls back to organization-wide pickup for it. That fallback is why the field is optional on
	 * every form: leaving it blank is the behaviour a tenant had before groups existed.
	 */
	readonly pickupGroup: string | null;
	/**
	 * Screen EXTERNAL callers before this extension is rung.
	 *
	 * The caller records their name, the extension hears "call from <recording>" and presses a key
	 * to accept; a rejected call takes the same branch an unanswered one would, so the caller meets
	 * voicemail rather than a dead line. Internal callers are never screened — a colleague already
	 * arrives with a name on the handset's display.
	 *
	 * `false` on a fresh row, because the feature lengthens every inbound call it touches. Note that
	 * the column being on is not by itself enough: the engine's screening RUNTIME is behind a
	 * deployment flag that ships off (`callScreeningEnabled` in `plan-walker.ts`), so an extension
	 * with this set on a default deployment simply rings. The form says so rather than implying a
	 * behaviour change nobody would observe.
	 */
	readonly callScreening: boolean;
	readonly callTimeoutSeconds: number;
	readonly maxRegistrations: number;
	/**
	 * Which hold-music class this extension's own holds play from.
	 *
	 * It is the extension putting somebody on hold that this governs, not the extension being
	 * held — a call parked or transferred BY this endpoint plays this class, and `null` falls back
	 * to the organization's default class. The column has always been on the row and in the API's
	 * DTO; it was missing from this interface until the class list had a CRUD endpoint to select
	 * from, which meant TypeScript quietly agreed that a `PATCH` could not carry it.
	 */
	readonly mohClassId: string | null;
	readonly codecOverride: string | null;
	readonly enabled: boolean;
}

/** The three columns of one destination trio, spread onto the row rather than nested. */
export interface DestinationTrio {
	readonly destinationType: DestinationType | null;
	readonly destinationRef: string | null;
	readonly destinationData: DestinationData | null;
}

export interface PhoneNumberRow extends EntityRow, DestinationTrio {
	readonly e164: string;
	readonly label: string | null;
	readonly callerIdNamePrefix: string | null;
	readonly recordEnabled: boolean;
	readonly emergencyAddressId: string | null;
	readonly voiceEnabled: boolean;
	readonly faxEnabled: boolean;
	readonly enabled: boolean;
	/**
	 * Set when the platform bought this DID from the managed carrier; `null` for one an admin typed
	 * in. It is what decides which delete the Numbers screen calls — the plain one, or the one that
	 * also gives the number back and stops the bill.
	 */
	readonly carrierProvider: string | null;
	readonly carrierRef: string | null;
}

export interface TrunkRow extends EntityRow {
	readonly name: string;
	readonly kind: TrunkKind;
	readonly sipDomain: string;
	readonly sipProxy: string;
	readonly outboundProxy: string | null;
	/**
	 * The SIP username — the public half of the pair, and the one an operator needs when a
	 * registration is failing. `sipSecretRef` is the other half's address and is `secretColumns`
	 * on the server, so it is not on the wire and is not declared here.
	 */
	readonly authUser: string | null;
	readonly registerExpiresSeconds: number;
	readonly transport: SipTransport;
	readonly codecPrefs: string | null;
	readonly maxChannels: number | null;
	readonly callerIdNumberOverride: string | null;
	/**
	 * The ruleset that normalises the caller id ARRIVING on this trunk, before anything reads it.
	 *
	 * One carrier presents `0044…`, the next presents `+44…`, and without a rewrite the tenant's
	 * call-block list, their inbound routes and their CDR all have to know which trunk a call came in
	 * on. Nothing composes with this — a trunk has no inline manipulation — so it runs first and
	 * alone.
	 *
	 * Read-only in this app, and that is the API's shape rather than a decision here:
	 * `createTrunkDto` is a `z.strictObject` and does not declare the column, so a form that sent it
	 * would get a 400 naming the field. It arrives on every read because the compiler reads it, and
	 * the trunk dialog renders it as a fact rather than as a control.
	 */
	readonly inboundTranslationRulesetId: string | null;
	/**
	 * The four columns the qualify loop writes, and the only ones on this row no request may set.
	 *
	 * `updateTrunkDto` excludes them deliberately — they are machine-written state, not tenant
	 * configuration, and a PATCH that accepted them could forge a carrier outage — so a form must
	 * never send one back. They arrive on every read because "when did this carrier last move, and
	 * what did the media server actually say" is the first question asked of a trunk that is not
	 * working.
	 *
	 * `statusChangedAt` is `null` on a trunk nothing has ever observed, which is a different fact
	 * from `status: "unknown"` with a timestamp: the first means the pinger has not reported, the
	 * second means it reported that it could not tell. `statusReason` is the media server's word
	 * verbatim (`Reachable`, `Unreachable`) rather than this platform's five-member projection of
	 * it, and `statusLatencyMs` is the qualify round trip when one was measured.
	 */
	readonly status: TrunkStatus;
	readonly statusChangedAt: string | null;
	readonly statusReason: string | null;
	readonly statusLatencyMs: number | null;
	readonly enabled: boolean;
	/** Set once the trunk has been provisioned at the managed carrier; `null` for a BYO-SIP trunk. */
	readonly carrierProvider: string | null;
	readonly carrierRef: string | null;
	readonly carrierProfileRef: string | null;
}

export interface InboundRouteRow extends EntityRow, DestinationTrio {
	readonly name: string;
	readonly priority: number;
	readonly matchKind: RouteMatchKind;
	readonly matchPattern: string | null;
	readonly phoneNumberId: string | null;
	readonly callerIdPattern: string | null;
	readonly failoverDestinationType: DestinationType | null;
	readonly failoverDestinationRef: string | null;
	readonly failoverDestinationData: DestinationData | null;
	readonly timeConditionId: string | null;
	readonly recordEnabled: boolean;
	readonly enabled: boolean;
}

export interface TrunkPriorityEntry {
	readonly trunkId: string;
	readonly order: number;
	readonly weight?: number;
}

export interface OutboundRouteRow extends EntityRow {
	readonly name: string;
	readonly priority: number;
	readonly matchKind: RouteMatchKind;
	readonly dialPatterns: readonly string[];
	readonly stripDigits: number;
	readonly prependDigits: string | null;
	readonly tollClass: TollClass;
	readonly trunkPriority: readonly TrunkPriorityEntry[];
	readonly timeConditionId: string | null;
	/**
	 * The authorisation codes a caller must satisfy before any trunk is dialled. `null` is the
	 * overwhelmingly common case and means no challenge.
	 *
	 * Read-only in this app for the same reason {@link TrunkRow.inboundTranslationRulesetId} is:
	 * `createOutboundRouteDto` is a `z.strictObject` that does not declare the column. The route
	 * dialog names the attached set rather than offering to change it — see the note there.
	 */
	readonly pinSetId: string | null;
	/**
	 * The shared rewrite applied to the dialled number, AFTER this route's own strip/prepend.
	 *
	 * The composition order is not arbitrary and the form says it: the inline pair
	 * (`stripDigits` / `prependDigits`) turns what somebody's fingers did into the number they meant,
	 * and the ruleset normalises that number for the wire. A ruleset that ran first would have to
	 * know about every route's outside-line prefix, which is the coupling the shared layer exists to
	 * remove. `applyRouteTranslation` in `packages/routing/src/resolve.ts` is the authority.
	 *
	 * Read-only in this app, as above.
	 */
	readonly translationRulesetId: string | null;
	readonly failoverDestinationType: DestinationType | null;
	readonly failoverDestinationRef: string | null;
	readonly failoverDestinationData: DestinationData | null;
	readonly callerIdNumberOverride: string | null;
	readonly recordEnabled: boolean;
	readonly enabled: boolean;
}

export interface TimeRulePredicate {
	readonly weekdays?: readonly number[];
	readonly monthDays?: readonly number[];
	readonly months?: readonly number[];
	readonly weeksOfMonth?: readonly number[];
	readonly timeOfDay?: { readonly from: string; readonly to: string };
	readonly dateRange?: { readonly from: string; readonly to: string };
}

export interface TimeConditionRow extends EntityRow, DestinationTrio {
	readonly name: string;
	readonly timezone: string;
	readonly nomatchDestinationType: DestinationType | null;
	readonly nomatchDestinationRef: string | null;
	readonly nomatchDestinationData: DestinationData | null;
	/**
	 * The manual override, and the one column on this row no `PATCH` may carry.
	 *
	 * `updateTimeConditionDto` does not declare it — it is a `z.strictObject`, so a form that sent it
	 * would get a 400 naming the field — and it moves instead through
	 * `POST /call-flows/time-conditions/:id/override`, guarded by `call-flows.toggle`. That is the
	 * receptionist's grant rather than the administrator's, on the server's argument that forcing a
	 * condition open and flipping a call flow to night are one act on two tables. See
	 * {@link setTimeConditionOverride}.
	 */
	readonly override: TimeConditionOverride;
	/**
	 * The star code that cycles the override, and the key a BLF lamp watches.
	 *
	 * WRITABLE, and by the ordinary `PATCH` rather than by the override endpoint beside it — which is
	 * the split worth reading twice, because the two look like one subject.
	 * `createTimeConditionDto`/`updateTimeConditionDto` declare it (`overrideFeatureCode:
	 * shortCode.nullish()`), so it rides `time-conditions.write`: choosing which digits a phone dials
	 * is dial-plan configuration and is compiled — the code is screened against the feature-code
	 * catalogue at compile time. PRESSING it is {@link setTimeConditionOverride}, guarded by
	 * `call-flows.toggle`, which is the receptionist's grant.
	 *
	 * `null` clears it; blank is not a value the column takes.
	 */
	readonly overrideFeatureCode: string | null;
	readonly enabled: boolean;
}

/**
 * The day/night switch.
 *
 * Two REQUIRED destination trios, which is the only shape in this area that has one: every other
 * secondary trio is a branch a tenant may leave unset, and a flow with one position is not a switch.
 *
 * `mode` is on the row and is NOT writable through `PATCH` — `createCallFlowDto` and
 * `updateCallFlowDto` both omit it. It moves through `POST /call-flows/:id/toggle`, guarded by
 * `call-flows.toggle`, which also writes the presence entry a busy-lamp key renders. A `PATCH` that
 * set the column would put the daily action behind the administrator's grant and would leave every
 * lamp in the building showing the old position.
 */
export interface CallFlowRow extends EntityRow, DestinationTrio {
	readonly name: string;
	readonly extensionNumber: string | null;
	/** The star code that toggles it, and the key a BLF lamp is provisioned with. */
	readonly featureCode: string | null;
	readonly mode: CallFlowMode;
	readonly nightDestinationType: DestinationType | null;
	readonly nightDestinationRef: string | null;
	readonly nightDestinationData: DestinationData | null;
	readonly enabled: boolean;
}

/**
 * A list of outbound authorisation codes.
 *
 * Nothing on this row is a secret and nothing on it ever will be: the codes live on the entries, are
 * stored as scrypt digests, and are set through an endpoint that hashes them. `pinHash` is in
 * `secretColumns` on the server's child resource, so it is stripped from every response and is
 * absent from {@link PinSetEntryRow} — a row simply does not carry it and this type must not pretend
 * otherwise.
 */
export interface PinSetRow extends EntityRow {
	readonly name: string;
	readonly description: string | null;
	readonly promptId: string | null;
	readonly failurePromptId: string | null;
	readonly maxAttempts: number;
	readonly digitTimeoutMs: number;
	readonly enabled: boolean;
}

/**
 * One authorisation code — its identity, never its digits.
 *
 * `label` and `ordinal` are what a call detail record names ("code 3, the night desk"), which is the
 * whole of what upstream's plaintext column was needed for: "which of our codes placed this call" is
 * answerable from an identity rather than from a secret. The ordinal is therefore a value an
 * administrator chooses rather than a position a loader happened to return, which is why the
 * collection has a reorder endpoint.
 */
export interface PinSetEntryRow extends EntityRow {
	readonly pinSetId: string;
	readonly ordinal: number;
	readonly label: string | null;
	readonly enabled: boolean;
}

/**
 * A named, ordered list of rewrites several routes and trunks can point at.
 *
 * Guarded by `routes.*` rather than by a resource of its own: a ruleset is only meaningful attached
 * to an outbound route or a trunk, and its power — deciding what digits reach which carrier — is the
 * power `routes.write` already grants.
 */
export interface TranslationRulesetRow extends EntityRow {
	readonly name: string;
	readonly description: string | null;
	readonly enabled: boolean;
}

/**
 * One rewrite in a ruleset.
 *
 * A PIPELINE and not a first-match table: every enabled rule fires in `ordinal` order and each sees
 * the previous one's output, so "strip the international prefix" before "add the plus" produces a
 * number and the other way round produces nonsense. That is why the order has a reorder endpoint and
 * why the editor never lets a rule be moved by editing its ordinal alone.
 *
 * Neither `matchPattern` nor `replacement` is validated beyond its length by the API, deliberately:
 * `validateTranslationRule` in `@optimiq-voice/routing` runs inside the write transaction, and a
 * second opinion in the browser would disagree with it on the first interesting input.
 */
export interface TranslationRuleRow extends EntityRow {
	readonly translationRulesetId: string;
	readonly ordinal: number;
	readonly label: string | null;
	readonly matchPattern: string;
	/** May be empty — that is how a strip rule is written. */
	readonly replacement: string;
	readonly enabled: boolean;
}

/**
 * A named shortcut an administrator points many routes at, so moving the target is one edit.
 *
 * FusionPBX's "Bridge" with the raw dial string removed: upstream a bridge is a FreeSWITCH dial
 * STRING, which reaches a carrier with no route, no toll class and no call-block screen. This one
 * names a destination trio instead, and the compiler expands it FLAT — an alias produces no plan
 * node, it resolves to whatever its target resolved to, and a cycle is refused at depth 8.
 */
export interface DestinationAliasRow extends EntityRow, DestinationTrio {
	readonly name: string;
	readonly description: string | null;
	readonly enabled: boolean;
}

/**
 * A remote audio source usable as a destination.
 *
 * The fallback trio is REQUIRED, which is unusual for a secondary trio and is the point: remote-URL
 * playback is the one capability here whose availability depends on the media driver, so a stream
 * with nowhere to go is a call dropped in silence on any driver that cannot play it.
 */
export interface AudioStreamRow extends EntityRow {
	readonly name: string;
	readonly description: string | null;
	/** `http(s)` only. The allow-list is a security check — a media server will open `file://`. */
	readonly url: string;
	readonly answerFirst: boolean;
	/** Zero means "until the caller hangs up", which is what an always-on radio feed wants. */
	readonly maxSeconds: number;
	readonly fallbackDestinationType: DestinationType | null;
	readonly fallbackDestinationRef: string | null;
	readonly fallbackDestinationData: DestinationData | null;
	readonly enabled: boolean;
}

/**
 * A dial-by-name directory.
 *
 * There is no child collection: the entries are DERIVED from the organization's extensions at
 * compile time. An extension whose mailbox has no recorded NAME greeting is skipped with a warning,
 * because this platform has no text-to-speech and an entry whose name cannot be spoken cannot be
 * offered.
 */
export interface DialByNameDirectoryRow extends EntityRow {
	readonly name: string;
	readonly extensionNumber: string | null;
	readonly searchField: DirectorySearchField;
	readonly minDigits: number;
	readonly greetingPromptId: string | null;
	readonly invalidPromptId: string | null;
	readonly maxFailures: number;
	readonly timeoutDestinationType: DestinationType | null;
	readonly timeoutDestinationRef: string | null;
	readonly timeoutDestinationData: DestinationData | null;
	readonly enabled: boolean;
}

/**
 * An organization-wide short code that points somewhere.
 *
 * Nothing points AT a speed dial — its `destinationType` on the server is `null` — so it never
 * appears in the destination picker. Its own trio is required, and it is a trio rather than a
 * number for the reason an alias refuses a dial string: a bare number would have to be dialled by
 * something, with no route matched and no toll class applied.
 */
export interface SpeedDialRow extends EntityRow, DestinationTrio {
	readonly code: string;
	readonly label: string;
	readonly enabled: boolean;
}

/**
 * The organization's quotas. `GET|PUT /api/v1/org-limits` — a SINGLETON, not a collection.
 *
 * Every field is nullable and `null` means "no ceiling" rather than "reset to a default": unlimited
 * IS the default and always has been, because this table arrived after tenants existed. An absent
 * ROW is an empty set of limits, which is why the read can legitimately answer `{}`.
 *
 * The write is a `PUT` and the body is the COMPLETE set: a partial one would make "remove this
 * limit" and "leave this limit alone" the same request.
 */
export interface OrgLimits {
	readonly maxExtensions?: number | null;
	readonly maxTrunks?: number | null;
	readonly maxConcurrentCalls?: number | null;
	readonly maxStorageMb?: number | null;
}

/** One line of the usage report: what is used, against what is allowed. */
export interface OrgUsageEntry {
	readonly limit: OrgLimitName;
	readonly used: number;
	/** `null` means no ceiling — the tenant is unlimited on this axis. */
	readonly ceiling: number | null;
	/**
	 * `null` when there is no ceiling to divide by, AND when {@link measured} is false.
	 *
	 * The second case is newer and is the one a renderer gets wrong: `maxConcurrentCalls` used to
	 * report `ratio: 0` beside a real ceiling, which drew a 0% bar — a confident statement that
	 * nobody is on a call, made by a process that cannot see calls. It is `null` now, so a bar drawn
	 * from it draws nothing.
	 *
	 * A fraction rather than a percentage, so a UI decides how to say it.
	 */
	readonly ratio: number | null;
	/**
	 * Whether `used` is a MEASUREMENT or a placeholder.
	 *
	 * Three of the four limits are a `select count(*)` in the API process and are true at the instant
	 * they were read. `maxConcurrentCalls` is not: simultaneous calls are live state the engines hold,
	 * and the control plane has no way to ask that does not enumerate every live leg on the platform
	 * on every page load. Its `used` is therefore zero, and this flag is what stops a screen rendering
	 * that zero as "nobody is on a call right now".
	 *
	 * This app branches on the FLAG rather than on `limit === "maxConcurrentCalls"`, which is what it
	 * used to do: the server owns which lines it can count, and a hard-coded name here would be a
	 * second copy of that decision that goes stale in the direction of claiming a number it does not
	 * have.
	 */
	readonly measured: boolean;
}

/**
 * `GET /api/v1/org-limits/usage`.
 *
 * Two of the four numbers are honest about being incomplete, and the screen has to say so rather
 * than round them off:
 *
 * - `maxConcurrentCalls` always reports `used: 0`, `ratio: null` and `measured: false`. Simultaneous
 *   calls are live state the engine holds; a number this endpoint invented would be wrong the moment
 *   it was read. The ceiling is still reported, because that is the fact an administrator came for —
 *   and it is now genuinely enforced, at admission, by the engine rather than by a form.
 * - `maxStorageMb` counts `prompt` and `voicemail_message` rows only. RECORDINGS are excluded —
 *   they live in the CDR database, a different connection and a different bounded context — so the
 *   total is smaller than the tenant's real storage. Named as a gap rather than half-counted.
 */
export interface OrgUsageReport {
	readonly entries: readonly OrgUsageEntry[];
	/** Exact bytes, before the megabyte rounding the ceiling is compared against. */
	readonly storageBytes: number;
}

export interface TimeConditionRuleRow extends EntityRow {
	readonly timeConditionId: string;
	readonly ordinal: number;
	readonly label: string | null;
	readonly predicates: readonly TimeRulePredicate[];
	readonly enabled: boolean;
}

export interface IvrMenuRow extends EntityRow {
	readonly name: string;
	readonly extensionNumber: string | null;
	readonly parentId: string | null;
	readonly greetingPromptId: string | null;
	readonly shortGreetingPromptId: string | null;
	readonly invalidPromptId: string | null;
	readonly timeoutPromptId: string | null;
	readonly digitTimeoutMs: number;
	readonly interDigitTimeoutMs: number;
	readonly maxDigits: number;
	readonly maxFailures: number;
	readonly maxTimeouts: number;
	readonly directDialEnabled: boolean;
	readonly timeoutDestinationType: DestinationType | null;
	readonly timeoutDestinationRef: string | null;
	readonly timeoutDestinationData: DestinationData | null;
	readonly invalidDestinationType: DestinationType | null;
	readonly invalidDestinationRef: string | null;
	readonly invalidDestinationData: DestinationData | null;
	readonly enabled: boolean;
}

export interface IvrMenuOptionRow extends EntityRow, DestinationTrio {
	readonly ivrMenuId: string;
	readonly ordinal: number;
	readonly matchKind: IvrOptionMatchKind;
	readonly matchValue: string;
	readonly label: string | null;
	readonly enabled: boolean;
}

export interface RingGroupRow extends EntityRow {
	readonly name: string;
	readonly extensionNumber: string | null;
	readonly strategy: RingGroupStrategy;
	readonly ringTimeoutSeconds: number;
	readonly callerIdNamePrefix: string | null;
	readonly ignoreBusy: boolean;
	readonly confirmEnabled: boolean;
	readonly confirmPromptId: string | null;
	readonly mohClassId: string | null;
	readonly ringbackPromptId: string | null;
	readonly timeoutDestinationType: DestinationType | null;
	readonly timeoutDestinationRef: string | null;
	readonly timeoutDestinationData: DestinationData | null;
	readonly enabled: boolean;
}

/**
 * A paging group. No destination trio — a page does not continue anywhere: the pager speaks, the
 * handsets auto-answer, and the announcement ends when the pager hangs up. `duplex: false` is a
 * one-way announcement; `true` is talkback (fifty open microphones, which is why `false` is the
 * server default and this mirror states it rather than assuming it).
 */
export interface PagingGroupRow extends EntityRow {
	readonly name: string;
	readonly extensionNumber: string | null;
	readonly duplex: boolean;
	readonly timeoutSeconds: number;
	readonly enabled: boolean;
}

export interface PagingGroupMemberRow extends EntityRow {
	readonly pagingGroupId: string;
	readonly extensionId: string;
	readonly ordinal: number;
	readonly enabled: boolean;
}

/**
 * A shared line (SLA / BLA) — one line that appears on several handsets and behaves as ONE seizable
 * thing. No destination trio, and the absence is the design: a shared line never routes a call out.
 * Its whole point is the state it keeps AFTER the answer — who holds it, whether it is on hold, when
 * it recalls — which lives in a KV claim the engine arbitrates, not in a branch. `extensionNumber`
 * is nullable for the reason a paging group's is: a line that is only a shared KEY across a boss and
 * an assistant has no dialable number of its own.
 */
export interface SharedLineRow extends EntityRow {
	readonly name: string;
	readonly extensionNumber: string | null;
	readonly strategy: SharedLineStrategy;
	readonly ringTimeoutSeconds: number;
	/**
	 * How long a call held on the line may sit before it recalls every appearance. `0` disables
	 * recall — the line holds indefinitely — which is a real value the column takes rather than
	 * "unset", so the detail copy says "0 disables recall" rather than rendering a blank.
	 */
	readonly holdRecallTimeoutSeconds: number;
	/**
	 * Whether an idle appearance may join a call already up on the line (the boss/admin "barge").
	 *
	 * The flag is stored and COMPILED, but the live barge-in MEDIA join awaits the media plane — a
	 * deferred seam named in the backend report — so the switch records intent rather than an effect
	 * a call would observe today. The dialog says so instead of implying a behaviour that has not
	 * landed.
	 */
	readonly bargeInEnabled: boolean;
	readonly enabled: boolean;
}

/**
 * One appearance — one extension's button on a shared line.
 *
 * `ordinal` is the APPEARANCE INDEX: the button position the phone lights and the number sipd stamps
 * into the `Call-Info` header, not a loader's display order — which is why the collection has a
 * reorder endpoint. `extensionId` is a plain foreign key rather than a destination, because only a
 * registered endpoint can be given a button on the line; an external number cannot light a lamp.
 */
export interface SharedLineAppearanceRow extends EntityRow {
	readonly sharedLineId: string;
	readonly extensionId: string;
	readonly ordinal: number;
	readonly enabled: boolean;
}

export interface RingGroupMemberRow extends EntityRow, DestinationTrio {
	readonly ringGroupId: string;
	readonly ordinal: number;
	readonly delaySeconds: number;
	readonly timeoutSeconds: number;
	readonly confirmRequired: boolean;
	readonly enabled: boolean;
}

export interface QueueRow extends EntityRow {
	readonly name: string;
	readonly extensionNumber: string | null;
	readonly strategy: QueueStrategy;
	readonly mohClassId: string | null;
	readonly greetingPromptId: string | null;
	readonly announcePromptId: string | null;
	/**
	 * Whisper-on-answer: played to the ANSWERING AGENT alone, before the caller is bridged in.
	 *
	 * The opposite side of the bridge from `greetingPromptId` and `announcePromptId`, which both
	 * play to the caller. A caller who heard the agent's cue sheet ("call from Sales queue") would
	 * be listening to the routing table, which is the whole reason this is a separate column.
	 */
	readonly agentWhisperPromptId: string | null;
	readonly maxWaitSeconds: number;
	readonly maxWaitNoAgentSeconds: number;
	readonly wrapUpSeconds: number;
	readonly announcePositionEnabled: boolean;
	readonly announceFrequencySeconds: number;
	readonly abandonedResumeAllowed: boolean;
	readonly discardAbandonedAfterSeconds: number;
	readonly tierRulesApply: boolean;
	readonly tierRuleWaitSeconds: number;
	readonly tierRuleNoAgentNoWait: boolean;
	/**
	 * When the engine records what this queue distributes — the same vocabulary an extension and a
	 * trunk carry, which REPLACED a `recordEnabled` boolean no runtime honoured.
	 *
	 * A queued call is inbound from the queue's point of view whichever direction the leg that
	 * reached the queue was travelling, so `inbound` and `all` both record here and `outbound` never
	 * does. The recording begins at the ANSWER rather than at the join: hold music is not evidence of
	 * anything, and recording it would put every abandoned call in the retention bucket.
	 */
	readonly recordPolicy: RecordPolicy;
	/**
	 * The single DTMF digit a WAITING caller may press to leave the line. `null` disables it.
	 *
	 * One character, because that is the whole feature: a caller four minutes into a hold is not
	 * going to type a string, and a multi-digit code would need an inter-digit timeout running under
	 * the music for the entire wait. Where they go is the `exit` trio below.
	 */
	readonly exitKey: string | null;
	readonly exitDestinationType: DestinationType | null;
	readonly exitDestinationRef: string | null;
	readonly exitDestinationData: DestinationData | null;
	/**
	 * The priority every caller entering this queue starts with, unless the destination that sent
	 * them overrode it — an IVR option saying "press 2 if you are a platinum customer" is exactly
	 * that override. Higher dequeues first; see {@link QUEUE_PRIORITY_MIN}.
	 */
	readonly defaultPriority: number;
	readonly timeoutDestinationType: DestinationType | null;
	readonly timeoutDestinationRef: string | null;
	readonly timeoutDestinationData: DestinationData | null;
	readonly enabled: boolean;
}

/**
 * An agent is organization-level, not queue-level: `queue_agent` carries no queue, and
 * {@link QueueTierRow} is the membership that says which queues they serve. `/queue-agents` is
 * therefore a top-level list, not a child of `/queues`.
 */
export interface QueueAgentRow extends EntityRow {
	readonly name: string;
	readonly userId: string | null;
	readonly contactKind: QueueAgentContactKind;
	readonly extensionId: string | null;
	readonly contact: string | null;
	readonly status: QueueAgentStatus;
	readonly statusChangedAt: string | null;
	readonly wrapUpSeconds: number;
	readonly maxNoAnswer: number;
	readonly noAnswerDelaySeconds: number;
	readonly busyDelaySeconds: number;
	readonly rejectDelaySeconds: number;
	readonly enabled: boolean;
}

export interface QueueTierRow extends EntityRow {
	readonly queueId: string;
	readonly queueAgentId: string;
	/** Lower levels are offered the call first. */
	readonly level: number;
	/** Order within the level. */
	readonly position: number;
	/**
	 * Played to the AGENT alone when a call distributed by THIS tier reaches them, in place of the
	 * queue's `agentWhisperPromptId`. `null` clears it and the queue's whisper takes over again.
	 *
	 * On the tier rather than on the queue because it is a fact about the MEMBERSHIP: an escalation
	 * cue for a level that is only reached after the one below it could not take the call. It is
	 * therefore behind `queues.manage-agents` like everything else on a tier — whoever staffs the
	 * levels is whoever knows what each level should be told.
	 */
	readonly announcePromptId: string | null;
}

/**
 * A conference room.
 *
 * `pinHash` / `moderatorPinHash` are not on the wire: the API does not accept a digest in a JSON
 * body, so the row reports only whether a PIN exists — and today it never does. See
 * `apps/api/src/pbx/conferences/conferences.resource.ts`.
 */
export interface ConferenceRow extends EntityRow {
	readonly name: string;
	readonly roomNumber: string;
	readonly maxMembers: number;
	readonly recordPolicy: RecordPolicy;
	readonly mohClassId: string | null;
	readonly announceJoinLeave: boolean;
	/** Join/leave beeps — distinct from `announceJoinLeave`, which plays recorded names. */
	readonly entryToneEnabled: boolean;
	readonly exitToneEnabled: boolean;
	readonly waitForModerator: boolean;
	readonly enabled: boolean;
}

export interface ParkLotRow extends EntityRow {
	readonly name: string;
	/** Inclusive dialable slot range, e.g. 701–720. */
	readonly slotStart: number;
	readonly slotEnd: number;
	readonly timeoutSeconds: number;
	readonly timeoutDestinationType: DestinationType | null;
	readonly timeoutDestinationRef: string | null;
	readonly timeoutDestinationData: DestinationData | null;
	readonly mohClassId: string | null;
	readonly enabled: boolean;
}

export interface FeatureCodeRow extends EntityRow {
	readonly code: string;
	readonly action: FeatureCodeAction;
	readonly params: Readonly<Record<string, string | number | boolean>> | null;
	readonly label: string | null;
	readonly enabled: boolean;
}

/**
 * What one feature-code action's `params` accepts, as `GET /feature-codes/param-fields` reports it.
 *
 * The server declares this so the form can render a control instead of a JSON textarea: today only
 * `call-park` takes anything (`lotId`, an entity ref into the park-lot list), and every other
 * action reports an empty list — which is a fact about the action, not a gap in the API.
 */
export interface FeatureCodeParamField {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly kind: "entity";
	readonly entityType: DestinationType;
	readonly required: boolean;
}

export type FeatureCodeParamFields = Readonly<
	Record<FeatureCodeAction, readonly FeatureCodeParamField[]>
>;

/**
 * One caller-screening rule.
 *
 * ## `pattern` is one loose string, and that is the server's decision rather than a shortcut
 *
 * The column holds an exact number, a prefix, or a regular expression, and which one it is is
 * `matchKind`'s business. The API's DTO deliberately refuses to validate the string against the
 * kind, because the function whose opinion decides whether a rule can be ENFORCED is
 * `compilePattern` in `@optimiq-voice/routing`, and it runs inside the write transaction: an
 * unusable pattern is a 422 naming `pattern` that rolls the insert back, and an unanchored regex is
 * a warning that rides out in the mutation envelope. A second regex validator here would be a
 * second opinion, and the two would disagree on the first interesting input — so
 * `callBlockRuleFormSchema` bounds the LENGTH and lets the compiler refuse what will not compile.
 *
 * ## `hitCount` and `lastHitAt` are read-only, and are the point of the screen
 *
 * They are counters the enforcement side writes, absent from both DTOs — `z.strictObject` means a
 * client that sends one gets a 400 naming the field rather than a silent drop, so nothing here may
 * put them in a request body. They are NOT secret columns: "this rule has never matched anything"
 * is the single most useful thing a screening list can say, and hiding it would leave a stale
 * blocklist looking identical to a working one.
 *
 * `lastHitAt` is `null` on a rule that has never fired, which is exactly the `hitCount: 0` case and
 * is rendered as such rather than as a missing date.
 */
export interface CallBlockRuleRow extends EntityRow {
	readonly pattern: string;
	readonly matchKind: CallBlockMatchKind;
	readonly direction: CallBlockDirection;
	readonly action: CallBlockAction;
	readonly label: string | null;
	/** Written by enforcement, never by a request. See the note above. */
	readonly hitCount: number;
	/** ISO-8601, or `null` on a rule that has never matched a call. */
	readonly lastHitAt: string | null;
	readonly enabled: boolean;
}

export interface VoicemailBoxRow extends EntityRow {
	readonly mailboxNumber: string;
	readonly label: string | null;
	readonly extensionId: string | null;
	readonly emailAddress: string | null;
	readonly emailMode: VoicemailEmailMode;
	readonly deleteAfterDelivery: boolean;
	readonly transcriptionEnabled: boolean;
	readonly mwiEnabled: boolean;
	readonly maxMessages: number;
	readonly maxMessageSeconds: number;
	readonly enabled: boolean;
}

/**
 * Whether a mailbox has a PIN.
 *
 * `pinSet`, never the digest: `voicemail_box.pin_hash` is in `secretColumns` on the server's
 * resource declaration and is stripped from every response, so a row simply does not carry it and
 * this type must not pretend otherwise. What the UI needs is the boolean, and it comes back from
 * the set/clear endpoints rather than from the row — which is why the mailbox list cannot show a
 * "PIN set" column today and the dialog says so instead of guessing.
 */
export interface VoicemailPinState {
	readonly id: string;
	readonly mailboxNumber: string;
	readonly pinSet: boolean;
}

/**
 * What a conference PIN endpoint answers with.
 *
 * Both flags on every reply, so a dialog that just set one does not have to re-fetch to render the
 * other. Never a digest and never the PIN — `secretColumns` on the API resource strips
 * `pinHash`/`moderatorPinHash` from every normal response, and these endpoints answer in booleans.
 *
 * `pinSet` reaches the compiled routing artifact as `ConferencePlanNode.requiresPin`.
 * `moderatorPinSet` is compiled too: the engine verifies it at the same entry prompt, admitting
 * the caller as moderator and releasing anyone held on `waitForModerator`.
 */
export interface ConferencePinState {
	readonly id: string;
	readonly roomNumber: string;
	readonly pinSet: boolean;
	readonly moderatorPinSet: boolean;
}

/** `new` / `saved` / `deleted` — `voicemail_message.folder`, the whole state machine. */
export const VOICEMAIL_FOLDERS = ["new", "saved", "deleted"] as const;
export type VoicemailFolder = (typeof VOICEMAIL_FOLDERS)[number];

/**
 * How far a message got through transcription. Mirrors `VOICEMAIL_TRANSCRIPTION_STATUSES`.
 *
 * Four states rather than "is `transcription` null", because a null transcript is three different
 * facts and each one wants a different thing on screen:
 *
 * | status     | what the row means                    | what the UI should do        |
 * | ---------- | ------------------------------------- | ---------------------------- |
 * | `disabled` | nobody tried, and nobody is going to  | show nothing at all          |
 * | `pending`  | queued or in flight                   | a spinner is honest here     |
 * | `done`     | a provider answered                   | show the text, even if empty |
 * | `failed`   | a provider was asked and refused      | say so; stop waiting         |
 *
 * `done` with an EMPTY transcript is legitimate — a few seconds of silence transcribes to nothing —
 * which is the case that makes this field load-bearing rather than a convenience. A UI keyed on the
 * text alone would render that identically to `disabled` and to a spinner that never stops.
 */
export const VOICEMAIL_TRANSCRIPTION_STATUSES = ["disabled", "pending", "done", "failed"] as const;
export type VoicemailTranscriptionStatus = (typeof VOICEMAIL_TRANSCRIPTION_STATUSES)[number];

/**
 * One message in a mailbox.
 *
 * `read` is DERIVED from `folder` by the server and sent anyway, because every control in the UI
 * is phrased as read/unread and re-deriving it here would put a rule about mailbox semantics in
 * two places. `objectKey` is deliberately absent: playback goes through a signed URL minted per
 * listen, so the browser never needs the store key and is never given it.
 */
export interface VoicemailMessageRow {
	readonly id: string;
	readonly voicemailBoxId: string;
	readonly folder: VoicemailFolder;
	readonly read: boolean;
	readonly callerIdName: string | null;
	readonly callerIdNumber: string | null;
	readonly receivedAt: string;
	readonly durationMs: number;
	readonly sizeBytes: number | null;
	readonly transcription: string | null;
	/** Which of the four states the transcript is in. See {@link VoicemailTranscriptionStatus}. */
	readonly transcriptionStatus: VoicemailTranscriptionStatus;
	/** ISO-8601, and null in every state but `done`. */
	readonly transcribedAt: string | null;
	readonly callLegRef: string | null;
}

/** The counts as the server has them NOW, so a badge never has to add up a page. */
export interface VoicemailMailboxSummary {
	readonly id: string;
	readonly mailboxNumber: string;
	readonly newCount: number;
	readonly savedCount: number;
}

export interface VoicemailMessagePage extends PagedEnvelope<VoicemailMessageRow> {
	readonly mailbox: VoicemailMailboxSummary;
}

export interface VoicemailMessageResult {
	readonly data: VoicemailMessageRow;
	readonly mailbox: VoicemailMailboxSummary;
}

export interface VoicemailMessageDeletion {
	readonly data: { readonly id: string; readonly purged: boolean };
	readonly mailbox: VoicemailMailboxSummary;
}

/** A short-lived, anonymous URL an `<audio src>` can actually fetch. Minutes, not hours. */
export interface VoicemailPlaybackLink {
	readonly url: string;
	readonly expiresAt: string;
	readonly expiresInSeconds: number;
}

// ---------------------------------------------------------------------------------------------
// The media library
// ---------------------------------------------------------------------------------------------

/** How a music-on-hold class sources its audio. Mirrors `MOH_SOURCES` in `@optimiq-voice/pbx-db`. */
export const MOH_SOURCES = ["library", "stream"] as const;
export type MohSource = (typeof MOH_SOURCES)[number];

/**
 * What a stored audio object is for. Mirrors `PROMPT_KINDS`.
 *
 * `phrase` is the odd member and has no audio of its own: it is an ordered sequence of OTHER prompts
 * played as one ("your call is number", "seven", "in the queue"), which is the only way to say a
 * number aloud on a platform with no text-to-speech. It is a `prompt` row rather than a table of its
 * own so that the eight `*_prompt_id` foreign keys already in the schema accept one for free — see
 * `packages/pbx-db/src/schema/media-schema.ts`.
 *
 * The consequence for this app is {@link PromptRow.objectKey} being nullable, and the consequence
 * for the media screen is a second surface rather than a second column: `PromptsController` still
 * creates a library row only through a multipart UPLOAD, and `/api/v1/phrases` creates the sequence
 * with an ordinary JSON body because a phrase owns no file. See {@link PhraseRow}.
 */
export const PROMPT_KINDS = ["prompt", "moh", "greeting", "phrase"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

/** The four greeting slots. Mirrors `VOICEMAIL_GREETING_KINDS`. */
export const VOICEMAIL_GREETING_KINDS = ["unavailable", "busy", "name", "temporary"] as const;
export type VoicemailGreetingKind = (typeof VOICEMAIL_GREETING_KINDS)[number];

export interface MohClassRow extends EntityRow {
	readonly name: string;
	readonly description: string | null;
	readonly source: MohSource;
	readonly streamUri: string | null;
	readonly shuffle: boolean;
	readonly sampleRateHz: number;
	readonly isDefault: boolean;
	readonly enabled: boolean;
}

/**
 * One stored audio object.
 *
 * `objectKey` is read-only on the wire and read-only in this app: it is the only thing standing
 * between a row and a file, and the API refuses to patch it. It is surfaced because an operator
 * looking for a file under the media mount needs to know what it is called.
 */
export interface PromptRow extends EntityRow {
	readonly name: string;
	readonly kind: PromptKind;
	/**
	 * Which class this file BELONGS to — the media library's own relation, and the one column named
	 * `mohClassId` in this file that is not a form selector.
	 *
	 * Every other `mohClassId` on a PBX row points OUT of that row at a class ("play this while the
	 * caller waits") and now has a picker on its entity form. This one points the other way: it is
	 * how a `moh`-kind prompt is filed under the class whose loop it is part of, and it is set by
	 * uploading the file into a class rather than by choosing a class for the file. See
	 * `app/(app)/media/_components/moh-files-dialog.tsx`, which is the whole of its user interface.
	 */
	readonly mohClassId: string | null;
	/**
	 * The stored object, or `null` for a `phrase`.
	 *
	 * The column became nullable when a phrase became a `prompt` row: a phrase names other rows'
	 * audio and owns none, and `prompt_object_key_kind_check` is what keeps that from widening into
	 * "a prompt with no file". Anything that renders or plays a key must therefore check the kind
	 * first — `POST /prompts/:id/play-url` answers a phrase with an invalid-link error, because the
	 * row is perfectly valid and what does not exist is a file to stream.
	 */
	readonly objectKey: string | null;
	readonly contentType: string;
	readonly durationMs: number | null;
	readonly sizeBytes: number | null;
	readonly checksum: string | null;
	readonly language: string;
}

/**
 * A phrase — an ordered sequence of prompts, played as one.
 *
 * ## It IS a {@link PromptRow}, and this interface says so rather than restating it
 *
 * `/api/v1/phrases` reads and writes the SAME `prompt` table with `kind = 'phrase'` and a null
 * `object_key`; `PHRASE_RESOURCE` in `apps/api/src/pbx/phrases/phrases.resource.ts` is a second
 * descriptor over one table, differing only in the discriminator the descriptor cannot express. So
 * this extends `PromptRow` instead of copying eleven fields, and NARROWS the two that the
 * discriminator decides: `kind` is always `"phrase"` and `objectKey` is always `null`.
 *
 * The narrowing is what makes it useful rather than an alias. A screen holding a `PhraseRow` never
 * has to check the kind before deciding there is no audio to play — `POST /prompts/:id/play-url`
 * answers a phrase with an invalid-link error, and that is not an error a phrase screen should be
 * able to provoke by accident.
 *
 * ## What is NOT on it
 *
 * No `language` control and no `mohClassId` picker, matching the DTO: a phrase's language is
 * whatever its steps' audio is, and an MOH file is a member of a class while a sequence is not a
 * file. The columns are inherited because the row carries them; nothing in this app writes them.
 *
 * The STEPS are not here either — they are a child collection under `/phrases/:id/steps`, exactly as
 * a ruleset's rules are, because the order is the sentence. See {@link PhraseStepRow}.
 */
export interface PhraseRow extends PromptRow {
	readonly kind: "phrase";
	readonly objectKey: null;
}

/**
 * One step of a phrase: the audio it plays, and where in the sentence it plays.
 *
 * ## `promptId` may not name another phrase
 *
 * Nesting is refused — `phrases.service.ts` answers a step whose `promptId` is a `kind = 'phrase'`
 * row with a `PBX_VALIDATION_FAILED` naming `promptId`, so the message lands on the picker the user
 * just used, and the compiler refuses the same shape a second time for rows that arrive by any other
 * route. The form therefore offers library prompts only; the server's refusal is the backstop, not
 * the user interface.
 *
 * ## The reference into `prompt` is `on delete restrict`
 *
 * The only such column in the PBX schema. Deleting a prompt a phrase plays is a 409 whose referrers
 * are `kind: "phrase"` and whose `id` is the PHRASE's — `idColumn: "phrase_id"` on
 * `PROMPT_RESOURCE`, because a step has no screen and the phrase does. `referenceHref` in
 * `./references.ts` is what turns that into a link, and `nameColumn` is `null` there, so the
 * reference arrives with no name and renders as a short id.
 *
 * Cascading would have silently SHORTENED a phrase, which is the failure the restrict exists to
 * prevent: "your call is number seven in the queue" quietly becoming "your call is number in the
 * queue" is worse than a refused delete.
 */
export interface PhraseStepRow extends EntityRow {
	readonly phraseId: string;
	readonly promptId: string;
	readonly ordinal: number;
	/**
	 * A step that is skipped rather than removed.
	 *
	 * `prompt` has no `enabled` column and a phrase therefore has no disabled state — it is the STEPS
	 * that carry one, because half-building a sequence is a real state and half-deleting a file is
	 * not. See the note on `PHRASE_RESOURCE`.
	 */
	readonly enabled: boolean;
}

export interface VoicemailGreetingRow extends EntityRow {
	readonly voicemailBoxId: string;
	readonly kind: VoicemailGreetingKind;
	readonly label: string | null;
	readonly objectKey: string;
	readonly durationMs: number | null;
	/** At most one per kind. Activating one stands the incumbent down in the same transaction. */
	readonly active: boolean;
}

/** A short-lived preview link. The same shape as a voicemail message's, deliberately. */
export type MediaPlaybackLink = VoicemailPlaybackLink;

// ---------------------------------------------------------------------------------------------
// E911
// ---------------------------------------------------------------------------------------------

/**
 * A dispatchable location, per RAY BAUM'S Act.
 *
 * `validated` and its three companions are written by a carrier's E911 provisioning API and by
 * nothing else — this app never sends them, and the API refuses them in a request body. An
 * unvalidated address is stored, assignable, and shown as unvalidated: the alternative is a screen
 * that claims a regulatory guarantee the platform has not obtained.
 */
export interface EmergencyAddressRow extends EntityRow {
	readonly label: string;
	readonly streetLine1: string;
	readonly streetLine2: string | null;
	/** Floor / suite / room — what turns an address into a DISPATCHABLE location. */
	readonly locationDetail: string | null;
	readonly locality: string;
	readonly administrativeArea: string;
	readonly postalCode: string;
	readonly country: string;
	readonly validated: boolean;
	readonly validatedAt: string | null;
	readonly validationProvider: string | null;
	readonly validationReference: string | null;
}

// ---------------------------------------------------------------------------------------------
// The change ledger
// ---------------------------------------------------------------------------------------------

/**
 * `GET /api/v1/audit-log` — a cursor envelope, and not the paged one above.
 *
 * The same divergence `lib/cdr/contracts.ts` documents, for the same reason on the server's side:
 * `total` needs a `count(*)` over a table that takes a row for every mutation forever, and
 * `offset` over a ledger being appended to while somebody reads it silently skips rows. So this
 * list says "1–25, more" and cannot say "1–25 of 41,882".
 *
 * `range` is the window the server actually applied AFTER defaulting (thirty days when the caller
 * sends neither bound). Render it: a filter the user cannot see is what makes "why is my change
 * missing?" unanswerable.
 */
export interface AuditCursorEnvelope<T> {
	readonly data: readonly T[];
	/** Pass back as `?cursor=` for the next page. `null` means this was the last one. */
	readonly nextCursor: string | null;
	readonly limit: number;
	readonly range: { readonly from: string; readonly to: string };
}

/**
 * One entry in the append-only change ledger.
 *
 * Not an `EntityRow`: the table has `createdAt` and deliberately no `updatedAt`, because an
 * updatable timestamp on an immutable ledger is a contradiction and the tenant database role has
 * no UPDATE privilege to maintain it. There are no create/update/delete calls for this row shape
 * anywhere in this app, and there is no endpoint behind them if one were written.
 *
 * `before` and `after` are the CHANGED columns only, already redacted server-side: a value from a
 * secret column never entered the table, though the column's NAME appears on both sides so
 * "somebody rotated this extension's SIP password" stays auditable. A create has no `before`; a
 * delete has no `after`.
 */
export interface AuditLogEntryRow {
	readonly id: string;
	readonly organizationId: string;
	readonly actorType: AuditActorType;
	/** The person, when there is one. `null` for an API key, a service or the system. */
	readonly actorUserId: string | null;
	/** The API key id or service name, when there is no person. `null` for a user. */
	readonly actorRef: string | null;
	/** Dotted verb: `extension.update`, `org-setting.create`. */
	readonly action: string;
	/** Physical table name of the changed row, e.g. `extension`. */
	readonly resourceType: string;
	readonly resourceRef: string | null;
	readonly before: Readonly<Record<string, unknown>> | null;
	readonly after: Readonly<Record<string, unknown>> | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	/** Correlation id from the request pipeline, so an entry joins to a log line. */
	readonly requestId: string | null;
	readonly occurredAt: string;
	readonly createdAt: string;
}

/**
 * The query string `GET /api/v1/audit-log` accepts.
 *
 * Every filter is EXACT — there is no free-text search, because the only text worth matching is
 * the user agent and the diff, and an `ilike` over either is a scan of the window dressed up as a
 * feature. `actorUserId` and `actorRef` are separate controls because they are separate
 * principals; see {@link AUDIT_ACTOR_TYPES}.
 */
export interface AuditLogQueryParams {
	readonly from?: string;
	readonly to?: string;
	readonly actorType?: AuditActorType;
	readonly actorUserId?: string;
	readonly actorRef?: string;
	readonly action?: string;
	readonly resourceType?: string;
	readonly resourceRef?: string;
	readonly limit?: number;
	readonly cursor?: string;
}

// ---------------------------------------------------------------------------------------------
// SIP security: the network allowlist, and the attack log
// ---------------------------------------------------------------------------------------------

/**
 * One CIDR access-control entry.
 *
 * `network` arrives NORMALISED by PostgreSQL's own `cidr` type, so a row that was written as
 * `203.0.113.0/24` comes back as `203.0.113.0/24` and one written as a bare `198.51.100.7` comes
 * back as `198.51.100.7/32`. That is why the form normalises before sending — see
 * `lib/pbx/cidr.ts` — rather than letting the two spellings become two rows that collide on the
 * unique index only after the database has widened them.
 *
 * There is no destination trio and nothing points at one of these, so a delete is never refused
 * for a reference. It is also not a routing input: saving one recompiles nothing, and reaching the
 * media server takes a generator run and a transport rebuild that this app does not perform.
 */
export interface SipAclEntryRow extends EntityRow {
	readonly name: string | null;
	readonly network: string;
	readonly action: SipAclAction;
	readonly scope: SipAclScope;
	/** Lower wins. Ties are broken by the longer prefix. */
	readonly priority: number;
	readonly description: string | null;
	readonly enabled: boolean;
}

/**
 * One refused authentication attempt.
 *
 * Not an `EntityRow`: `sip_auth_event` is append-only in the database — the tenant role holds
 * `SELECT, INSERT` and nothing else — so there is no `updatedAt` for it to carry and no create,
 * update or delete call for this shape anywhere in this app.
 *
 * `organizationId` is `NOT NULL` on the server, which bounds what this table can hold and is worth
 * knowing before reading it as "every attack": an attempt against an account that matches no
 * tenant has nowhere to be filed and is deliberately absent. Those are refused at the media server
 * and appear in its security log, not here.
 */
export interface SipAuthEventRow {
	readonly id: string;
	readonly organizationId: string;
	readonly eventType: SipAuthEventType;
	readonly scope: SipAclScope;
	/** The source address. Null when the surface that refused did not know it. */
	readonly sourceIp: string | null;
	/** The account, extension number or MAC that was attempted. Never a credential. */
	readonly accountRef: string | null;
	readonly transport: string | null;
	readonly userAgent: string | null;
	/** Whatever names the refusal: the matched ACL entry, the rate-limit window, the device id. */
	readonly detail: Readonly<Record<string, unknown>> | null;
	readonly requestId: string | null;
	readonly occurredAt: string;
	readonly createdAt: string;
}

/**
 * The query string `GET /api/v1/sip-auth-events` accepts.
 *
 * The same shape as {@link AuditLogQueryParams} — a defaulted, echoed window, a keyset cursor and
 * exact filters — because the server deliberately made the two ledgers page identically. The one
 * divergence is the default window: SEVEN days here rather than thirty, because an attack log is
 * read operationally ("what is happening now") and a change ledger historically.
 *
 * `sourceIp` is an ADDRESS and not a network: the server refuses a prefix, because the question an
 * operator asks of this table is "what has this address been doing", which is the address they are
 * about to block.
 */
export interface SipAuthEventQueryParams {
	readonly from?: string;
	readonly to?: string;
	readonly eventType?: SipAuthEventType;
	readonly scope?: SipAclScope;
	readonly sourceIp?: string;
	readonly accountRef?: string;
	readonly limit?: number;
	readonly cursor?: string;
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

/**
 * The four event families a subscription may select, and the subject root each is written as.
 *
 * Mirrored from `apps/api/src/pbx/webhooks/webhook-selectors.ts`, which builds them from
 * `@optimiq-voice/events`' `SUBJECT_ROOTS`. That package is not a dependency of this app — it
 * would drag the broker's codecs into the browser bundle — so the four roots are restated and
 * `webhook-selectors.spec.ts` pins the grammar rather than the import.
 *
 * `cdr` is `cdr.leg.v1`, not `cdr.evt.v1`. The other four families the platform publishes —
 * `media`, `registration`, `audit`, `provision` — are deliberately not deliverable: they are
 * engine plumbing, a per-REGISTER firehose, a loop over the ledger that records webhook edits, and
 * credential-adjacent provisioning detail respectively.
 */
export const WEBHOOK_FAMILIES = ["call", "queue", "voicemail", "cdr"] as const;
export type WebhookFamily = (typeof WEBHOOK_FAMILIES)[number];

export const WEBHOOK_FAMILY_ROOTS: Readonly<Record<WebhookFamily, string>> = {
	call: "calls.evt.v1",
	queue: "queue.evt.v1",
	voicemail: "voicemail.evt.v1",
	cdr: "cdr.leg.v1",
};

/**
 * One outbound webhook subscription.
 *
 * ## `secret` is present on exactly one response and nowhere else
 *
 * `secret` is in `secretColumns` on the server's resource, so the generic redaction strips it from
 * every list, get and update body. The single exception is the CREATE response, which re-attaches
 * the key — generated or supplied — precisely once, because a signing key nobody can read is a
 * subscription nobody can verify.
 *
 * It is declared optional here rather than in a separate row type so that the one screen which
 * legitimately receives it does not need a cast, and so this comment sits on the field. A screen
 * must never render it from a list row: it is not there, and `undefined` in a "Secret" column
 * would read as "this endpoint has no secret" when every endpoint has one.
 *
 * ## The failure fields are read-only and are the whole answer to "why did it stop?"
 *
 * `consecutiveFailures` counts CONSECUTIVE failures and is zeroed by the first success.
 * `autoDisabledAt` is set when the platform switched the subscription off on the tenant's behalf,
 * and is deliberately separate from `enabled`: an administrator who disabled an endpoint knows
 * why, and one who finds it disabled needs to be told that we did it and when. Re-enabling through
 * `PATCH { enabled: true }` clears both, which is what makes "fix the endpoint, turn it back on" a
 * complete recovery rather than one that re-disables on the next bad delivery.
 */
export interface WebhookRow extends EntityRow {
	readonly description: string | null;
	readonly url: string;
	/** Present ONLY on the create response. See the note above; never render it from a list row. */
	readonly secret?: string;
	readonly eventSelectors: readonly string[];
	readonly enabled: boolean;
	readonly consecutiveFailures: number;
	readonly lastFailureAt: string | null;
	/** One line: a status code, a timeout, a DNS error. Never a response body. */
	readonly lastFailureReason: string | null;
	readonly lastSuccessAt: string | null;
	/** When the platform disabled this endpoint itself, after consecutive failures. */
	readonly autoDisabledAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Routing operations
// ---------------------------------------------------------------------------------------------

export interface CompileResult {
	readonly organizationId: string;
	readonly snapshotHash: string;
	readonly compiledAt: string;
	readonly cacheKey: string;
	readonly published: boolean;
	readonly warnings: readonly WireDiagnostic[];
}

export interface SimulateResult {
	readonly matched: boolean;
	readonly routingContext: RoutingContext;
	readonly entryNodeId?: string;
	readonly destinationType?: string;
	readonly destinationRef?: string;
	readonly matchedRuleId?: string;
	readonly matchedRuleName?: string;
	readonly dialedNumber?: string;
	readonly reason?: string;
	readonly diagnostics: readonly WireDiagnostic[];
}
