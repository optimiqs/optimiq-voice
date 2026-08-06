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

export const DESTINATION_TYPES = [
	"extension",
	"ivr",
	"ring-group",
	"queue",
	"voicemail",
	"conference",
	"park",
	"time-condition",
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
	"time-condition": "entity",
	external: "value",
	application: "value",
	hangup: "terminal",
};

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

export const IVR_OPTION_MATCH_KINDS = ["digit", "regex"] as const;
export type IvrOptionMatchKind = (typeof IVR_OPTION_MATCH_KINDS)[number];

export const RING_GROUP_STRATEGIES = ["simultaneous", "sequential"] as const;
export type RingGroupStrategy = (typeof RING_GROUP_STRATEGIES)[number];

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

export interface ExtensionRow extends EntityRow {
	readonly number: string;
	readonly label: string;
	readonly sipSecretRef: string;
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
	readonly callTimeoutSeconds: number;
	readonly maxRegistrations: number;
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
	readonly authUser: string | null;
	readonly sipSecretRef: string | null;
	readonly registerExpiresSeconds: number;
	readonly transport: SipTransport;
	readonly codecPrefs: string | null;
	readonly maxChannels: number | null;
	readonly callerIdNumberOverride: string | null;
	readonly status: TrunkStatus;
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
	readonly enabled: boolean;
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
	readonly recordEnabled: boolean;
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
	readonly recordEnabled: boolean;
	readonly mohClassId: string | null;
	readonly announceJoinLeave: boolean;
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
 * `moderatorPinSet` reaches nothing yet: `ConferenceInput` in `@optimiq-voice/routing` has no
 * moderator field, so the column is stored and the engine does not read it. The dialog says so.
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

/** What a stored audio object is for. Mirrors `PROMPT_KINDS`. */
export const PROMPT_KINDS = ["prompt", "moh", "greeting"] as const;
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
	readonly mohClassId: string | null;
	readonly objectKey: string;
	readonly contentType: string;
	readonly durationMs: number | null;
	readonly sizeBytes: number | null;
	readonly checksum: string | null;
	readonly language: string;
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
