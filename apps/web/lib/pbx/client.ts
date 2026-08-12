/**
 * The PBX REST surface, as data.
 *
 * Ten of the eleven T1 resources are structurally identical CRUD — `apps/api` says so explicitly
 * and implements them from one declaration — so the client says it once too. A per-entity
 * hand-written client would be ten copies of the same four fetches, and the eleventh copy is
 * where the `?limit` cap or the `PATCH` semantics would be forgotten.
 *
 * The type parameter is what keeps this honest: `PBX_RESOURCES.extensions` is a
 * `PbxResourceDescriptor<ExtensionRow>`, so `listPbx(PBX_RESOURCES.extensions, …)` returns pages
 * of extensions and nothing else.
 */

import { apiFetch, apiUpload } from "../api-client";
import { ledgerSearchParams } from "./ledger";
import type { Permission } from "../permissions";
import type {
	AudioStreamRow,
	AuditCursorEnvelope,
	AuditLogEntryRow,
	AuditLogQueryParams,
	CallBlockRuleRow,
	CallFlowMode,
	CallFlowRow,
	CompileResult,
	ConferencePinState,
	ConferenceRow,
	DestinationAliasRow,
	DialByNameDirectoryRow,
	EmergencyAddressRow,
	ExtensionRow,
	FeatureCodeParamFields,
	FeatureCodeRow,
	InboundRouteRow,
	ItemEnvelope,
	IvrMenuOptionRow,
	IvrMenuRow,
	MediaPlaybackLink,
	MohClassRow,
	MutationEnvelope,
	OrgLimits,
	OrgUsageReport,
	OutboundRouteRow,
	PagedEnvelope,
	PagingGroupMemberRow,
	PagingGroupRow,
	ParkLotRow,
	PhoneNumberRow,
	PinSetEntryRow,
	PinSetRow,
	PromptKind,
	PromptRow,
	QueueAgentRow,
	QueueRow,
	QueueTierRow,
	RingGroupMemberRow,
	RingGroupRow,
	RoutingContext,
	SimulateResult,
	SipAclEntryRow,
	SipAuthEventQueryParams,
	SipAuthEventRow,
	SpeedDialRow,
	TimeConditionOverride,
	TimeConditionRow,
	TimeConditionRuleRow,
	TranslationRulesetRow,
	TranslationRuleRow,
	TrunkRow,
	VoicemailBoxRow,
	VoicemailFolder,
	VoicemailGreetingKind,
	VoicemailGreetingRow,
	VoicemailMessageDeletion,
	VoicemailMessagePage,
	VoicemailMessageResult,
	VoicemailPinState,
	VoicemailPlaybackLink,
	WebhookRow,
} from "./contracts";

/** The API's own cap. Asking for more is a 400, so the control that offers page sizes stops here. */
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 20;

export interface PbxListQuery {
	readonly page?: number;
	readonly limit?: number;
	readonly search?: string | undefined;
	readonly enabled?: boolean | undefined;
}

/**
 * One resource, declared.
 *
 * `permissions` restates what the controller's `@RequirePermissions` asks for, so a create button
 * and the endpoint behind it cannot disagree about which grant they need. `key` is the query-key
 * segment; `label`/`labelPlural` are the words the shared list scaffold puts in its empty state
 * and its confirmations, so those never say "resource".
 */
export interface PbxResourceDescriptor<TRow> {
	readonly key: string;
	readonly path: string;
	readonly label: string;
	readonly labelPlural: string;
	readonly permissions: {
		readonly read: Permission;
		readonly write: Permission;
		readonly delete: Permission;
	};
	/**
	 * Whether writing one of these can change what a call does.
	 *
	 * `ROUTING_TABLE_TO_ENTITY` in `@optimiq-voice/routing` is the authority — "anything not in this
	 * map is not a routing input and must not evict the cache" — and `contracts.spec.ts` holds each
	 * of these against it. It lives on the descriptor rather than in a set beside the mutation hooks
	 * so that adding a resource cannot quietly forget to say.
	 */
	readonly affectsRouting: boolean;
	/** Used by the destination picker and reference lists to name a row. */
	readonly displayName: (row: TRow) => string;
}

function descriptor<TRow>(value: PbxResourceDescriptor<TRow>): PbxResourceDescriptor<TRow> {
	return value;
}

export const PBX_RESOURCES = {
	extensions: descriptor<ExtensionRow>({
		key: "extensions",
		affectsRouting: true,
		path: "/extensions",
		label: "extension",
		labelPlural: "Extensions",
		permissions: {
			read: "extensions.read",
			write: "extensions.write",
			delete: "extensions.delete",
		},
		displayName: (row) => `${row.number} · ${row.label}`,
	}),
	phoneNumbers: descriptor<PhoneNumberRow>({
		key: "phone-numbers",
		affectsRouting: true,
		path: "/phone-numbers",
		label: "number",
		labelPlural: "Numbers",
		permissions: { read: "numbers.read", write: "numbers.write", delete: "numbers.delete" },
		displayName: (row) => (row.label ? `${row.e164} · ${row.label}` : row.e164),
	}),
	trunks: descriptor<TrunkRow>({
		key: "trunks",
		affectsRouting: true,
		path: "/trunks",
		label: "trunk",
		labelPlural: "Trunks",
		permissions: { read: "trunks.read", write: "trunks.write", delete: "trunks.delete" },
		displayName: (row) => row.name,
	}),
	inboundRoutes: descriptor<InboundRouteRow>({
		key: "inbound-routes",
		affectsRouting: true,
		path: "/inbound-routes",
		label: "inbound route",
		labelPlural: "Inbound routes",
		permissions: { read: "routes.read", write: "routes.write", delete: "routes.delete" },
		displayName: (row) => row.name,
	}),
	outboundRoutes: descriptor<OutboundRouteRow>({
		key: "outbound-routes",
		affectsRouting: true,
		path: "/outbound-routes",
		label: "outbound route",
		labelPlural: "Outbound routes",
		permissions: { read: "routes.read", write: "routes.write", delete: "routes.delete" },
		displayName: (row) => row.name,
	}),
	timeConditions: descriptor<TimeConditionRow>({
		key: "time-conditions",
		affectsRouting: true,
		path: "/time-conditions",
		label: "time condition",
		labelPlural: "Time conditions",
		permissions: {
			read: "time-conditions.read",
			write: "time-conditions.write",
			delete: "time-conditions.delete",
		},
		displayName: (row) => row.name,
	}),
	/**
	 * The day/night switch.
	 *
	 * Four grants on the server and only three here, because the descriptor describes CRUD:
	 * `call-flows.toggle` is a fourth verb on a route of its own and is named by {@link toggleCallFlow}
	 * rather than by this table. That split is the whole feature — `write` decides where the two
	 * branches go, `toggle` moves the switch — and collapsing it into `write` here would make the
	 * mode button appear only for administrators, which is precisely the person who does not press it.
	 *
	 * `affectsRouting: true`: `call_flow` is in `ROUTING_TABLE_TO_ENTITY`, so a save — and a toggle,
	 * which is a save — recompiles the tenant's artifact and relights the busy lamps.
	 */
	callFlows: descriptor<CallFlowRow>({
		key: "call-flows",
		affectsRouting: true,
		path: "/call-flows",
		label: "call flow",
		labelPlural: "Call flows",
		permissions: {
			read: "call-flows.read",
			write: "call-flows.write",
			delete: "call-flows.delete",
		},
		displayName: (row) => row.name,
	}),
	/**
	 * Outbound authorisation codes.
	 *
	 * `pin-sets.*` rather than a ride on `routes.*`, and the argument is the one `numbers.order` and
	 * `calls.originate` both made: the blast radius is money. The same grant that adds a code removes
	 * one, so a holder can make an international route dialable by everybody in the building.
	 */
	pinSets: descriptor<PinSetRow>({
		key: "pin-sets",
		affectsRouting: true,
		path: "/pin-sets",
		label: "PIN set",
		labelPlural: "Authorisation codes",
		permissions: { read: "pin-sets.read", write: "pin-sets.write", delete: "pin-sets.delete" },
		displayName: (row) => row.name,
	}),
	/**
	 * Number-translation rulesets, riding `routes.*`.
	 *
	 * NOT a resource of its own and NOT part of `dial-plan.*`, which is the server's division and
	 * worth restating: a ruleset is only meaningful attached to an outbound route or a trunk, and its
	 * power — deciding what digits reach which carrier — is the power `routes.write` already grants. A
	 * `translations.*` trio would be three more names for one decision.
	 */
	translationRulesets: descriptor<TranslationRulesetRow>({
		key: "translation-rulesets",
		affectsRouting: true,
		path: "/translation-rulesets",
		label: "translation ruleset",
		labelPlural: "Number translations",
		permissions: { read: "routes.read", write: "routes.write", delete: "routes.delete" },
		displayName: (row) => row.name,
	}),
	/**
	 * The four dial-plan building blocks below share ONE permission family, which is the collapse the
	 * permission registry asks every wave to justify: none of the four has a power profile of its
	 * own, none reaches a trunk except through the outbound tables every other destination goes
	 * through, and there is no role that plausibly edits one and not the others.
	 */
	destinationAliases: descriptor<DestinationAliasRow>({
		key: "destination-aliases",
		affectsRouting: true,
		path: "/destination-aliases",
		label: "named destination",
		labelPlural: "Named destinations",
		permissions: { read: "dial-plan.read", write: "dial-plan.write", delete: "dial-plan.delete" },
		displayName: (row) => row.name,
	}),
	audioStreams: descriptor<AudioStreamRow>({
		key: "audio-streams",
		affectsRouting: true,
		path: "/audio-streams",
		label: "audio stream",
		labelPlural: "Audio streams",
		permissions: { read: "dial-plan.read", write: "dial-plan.write", delete: "dial-plan.delete" },
		displayName: (row) => row.name,
	}),
	directories: descriptor<DialByNameDirectoryRow>({
		key: "directories",
		affectsRouting: true,
		path: "/directories",
		label: "directory",
		labelPlural: "Dial-by-name directories",
		permissions: { read: "dial-plan.read", write: "dial-plan.write", delete: "dial-plan.delete" },
		displayName: (row) => (row.extensionNumber ? `${row.extensionNumber} · ${row.name}` : row.name),
	}),
	speedDials: descriptor<SpeedDialRow>({
		key: "speed-dials",
		affectsRouting: true,
		path: "/speed-dials",
		label: "speed dial",
		labelPlural: "Speed dials",
		permissions: { read: "dial-plan.read", write: "dial-plan.write", delete: "dial-plan.delete" },
		displayName: (row) => `${row.code} · ${row.label}`,
	}),
	featureCodes: descriptor<FeatureCodeRow>({
		key: "feature-codes",
		affectsRouting: true,
		path: "/feature-codes",
		label: "feature code",
		labelPlural: "Feature codes",
		permissions: {
			read: "feature-codes.read",
			write: "feature-codes.write",
			delete: "feature-codes.delete",
		},
		displayName: (row) => (row.label ? `${row.code} · ${row.label}` : row.code),
	}),
	/**
	 * Caller screening — the allow/deny list the engine has been honouring since `checkCallBlock`.
	 *
	 * `call-block.*` and NOT `routes.*`, which is the controller's own division and the reason this
	 * is a resource rather than a fifth routing tab: the person who maintains a screening list is
	 * whoever answered the phone — a receptionist adding the number that called nine times this
	 * morning — and riding it on `routes.write` would mean the only way to let somebody block a
	 * number is to hand them the dial plan. It cuts the other way too, and that is the half that
	 * decided it: an `allow` rule lifts a number OUT of a broad prefix block, which is a power worth
	 * naming in an audit row of its own rather than burying inside "edited routing".
	 *
	 * Three grants and not two. `delete` is split from `write` because disabling a rule and deleting
	 * it are not the same act here: `enabled: false` leaves the row, its `hitCount` and its
	 * `lastHitAt` in place — the evidence that this number was calling — and deleting it destroys
	 * that. The same argument `security.delete` lost, decided the other way, because a security ACL
	 * entry carries no history and a screening rule does.
	 *
	 * `affectsRouting: true` — `call_block_rule` IS in `ROUTING_TABLE_TO_ENTITY`, so every save here
	 * recompiles the tenant's artifact inside the write transaction and the next call is screened
	 * against it. `contracts.spec.ts` holds that against the routing package rather than trusting
	 * this comment.
	 */
	callBlockRules: descriptor<CallBlockRuleRow>({
		key: "call-block-rules",
		affectsRouting: true,
		path: "/call-block-rules",
		label: "screening rule",
		labelPlural: "Call blocking",
		permissions: {
			read: "call-block.read",
			write: "call-block.write",
			delete: "call-block.delete",
		},
		displayName: (row) => (row.label ? `${row.pattern} · ${row.label}` : row.pattern),
	}),
	ivrMenus: descriptor<IvrMenuRow>({
		key: "ivr-menus",
		affectsRouting: true,
		path: "/ivr-menus",
		label: "IVR menu",
		labelPlural: "IVR menus",
		permissions: { read: "ivr.read", write: "ivr.write", delete: "ivr.delete" },
		displayName: (row) => row.name,
	}),
	pagingGroups: descriptor<PagingGroupRow>({
		key: "paging-groups",
		affectsRouting: true,
		path: "/paging-groups",
		label: "paging group",
		labelPlural: "Paging groups",
		permissions: {
			read: "paging-groups.read",
			write: "paging-groups.write",
			delete: "paging-groups.delete",
		},
		displayName: (row) => row.name,
	}),
	ringGroups: descriptor<RingGroupRow>({
		key: "ring-groups",
		affectsRouting: true,
		path: "/ring-groups",
		label: "ring group",
		labelPlural: "Ring groups",
		permissions: {
			read: "ring-groups.read",
			write: "ring-groups.write",
			delete: "ring-groups.delete",
		},
		displayName: (row) => row.name,
	}),
	queues: descriptor<QueueRow>({
		key: "queues",
		affectsRouting: true,
		path: "/queues",
		label: "queue",
		labelPlural: "Queues",
		permissions: { read: "queues.read", write: "queues.write", delete: "queues.delete" },
		displayName: (row) => row.name,
	}),
	/**
	 * Agents are top-level because `queue_agent` carries no queue — one agent serves several queues
	 * through a tier. Writing one is `queues.manage-agents`, which is what staffing the floor means
	 * and is deliberately not the same grant as editing a queue's overflow behaviour.
	 */
	queueAgents: descriptor<QueueAgentRow>({
		key: "queue-agents",
		affectsRouting: false,
		path: "/queue-agents",
		label: "agent",
		labelPlural: "Queue agents",
		permissions: {
			read: "queues.read",
			write: "queues.manage-agents",
			delete: "queues.manage-agents",
		},
		displayName: (row) => row.name,
	}),
	conferences: descriptor<ConferenceRow>({
		key: "conferences",
		affectsRouting: true,
		path: "/conferences",
		label: "conference",
		labelPlural: "Conferences",
		permissions: {
			read: "conferences.read",
			write: "conferences.write",
			delete: "conferences.delete",
		},
		displayName: (row) => `${row.roomNumber} · ${row.name}`,
	}),
	parkLots: descriptor<ParkLotRow>({
		key: "park-lots",
		affectsRouting: true,
		path: "/park-lots",
		label: "park lot",
		labelPlural: "Park lots",
		permissions: { read: "park-lots.read", write: "park-lots.write", delete: "park-lots.delete" },
		displayName: (row) => `${row.name} (${row.slotStart}–${row.slotEnd})`,
	}),
	voicemailBoxes: descriptor<VoicemailBoxRow>({
		key: "voicemail-boxes",
		affectsRouting: true,
		path: "/voicemail-boxes",
		label: "voicemail box",
		labelPlural: "Voicemail boxes",
		permissions: { read: "voicemail.read", write: "voicemail.write", delete: "voicemail.delete" },
		displayName: (row) => (row.label ? `${row.mailboxNumber} · ${row.label}` : row.mailboxNumber),
	}),
	/**
	 * Music-on-hold classes.
	 *
	 * `affectsRouting: true` — `moh_class` IS in `ROUTING_TABLE_TO_ENTITY`, because five node kinds
	 * carry the class's resolved NAME and a rename therefore has to reach the engine.
	 * `contracts.spec.ts` holds this against the routing package and will fail if it is guessed.
	 *
	 * `settings.*` rather than a `media.*` pair, which does not exist: the registry is at its
	 * documented ceiling and `apps/api`'s controller makes the same compromise, with the same note
	 * that a narrower pair is the right fix.
	 */
	mohClasses: descriptor<MohClassRow>({
		key: "moh-classes",
		affectsRouting: true,
		path: "/moh-classes",
		label: "hold music class",
		labelPlural: "Hold music",
		permissions: { read: "settings.read", write: "settings.write", delete: "settings.write" },
		displayName: (row) => row.name,
	}),
	/**
	 * The prompt library.
	 *
	 * ## `affectsRouting` flipped to `true` the day a phrase became a prompt row
	 *
	 * It was `false` for good reasons, and they are still true of most of this table: the compiler
	 * copies a `promptId` into a plan node VERBATIM and never resolves it, so renaming a prompt or
	 * replacing its audio changes nothing the artifact contains. What changed is that `prompt.kind`
	 * now decides whether an id is a single piece of audio or a SEQUENCE — a phrase is a prompt row —
	 * and which ids are sequences is a compiled fact the artifact carries in its own `phrases` table.
	 *
	 * The table cannot tell the two apart, so every write to it recompiles. That is more eviction
	 * than the feature strictly needs and the cost is bounded on the server side: `isArtifactFresh`
	 * compares content hashes and skips the KV round trip when nothing routing reads has moved.
	 * `ROUTING_TABLE_TO_ENTITY.prompt` is the authority and `contracts.spec.ts` holds this against it
	 * — which is exactly how this line was found to be stale.
	 *
	 * There is no generic `createPbx` for this resource — a prompt is created by an upload. Note that
	 * `prompt.object_key` is now NULLABLE, but only for `phrase`: there is still no way to make a
	 * library entry with no audio, and no endpoint that creates a phrase at all. See
	 * {@link uploadPrompt} and the note on `PromptRow` in `contracts.ts`.
	 */
	prompts: descriptor<PromptRow>({
		key: "prompts",
		affectsRouting: true,
		path: "/prompts",
		label: "prompt",
		labelPlural: "Prompts",
		permissions: { read: "settings.read", write: "settings.write", delete: "settings.write" },
		displayName: (row) => row.name,
	}),
	/**
	 * Dispatchable locations for E911.
	 *
	 * `affectsRouting: false` — `emergency_address` is not in `ROUTING_TABLE_TO_ENTITY` and nothing
	 * in `@optimiq-voice/routing` reads it. Assigning one to a DID does recompile, because
	 * `phone_number` is a routing table, and produces an identical artifact.
	 *
	 * `numbers.emergency` for writes: the permission exists already and its catalog entry names this
	 * feature. Reads are `numbers.read` so the Numbers screen can render which DID has which
	 * location without granting the narrower one.
	 */
	emergencyAddresses: descriptor<EmergencyAddressRow>({
		key: "emergency-addresses",
		// Routing input since the E911 wave: assignments feed the artifact's
		// emergency tables (ELIN selection), so a save invalidates the compile view.
		affectsRouting: true,
		path: "/emergency-addresses",
		label: "emergency address",
		labelPlural: "Emergency addresses",
		permissions: {
			read: "numbers.read",
			write: "numbers.emergency",
			delete: "numbers.emergency",
		},
		displayName: (row) => `${row.label} — ${row.streetLine1}, ${row.locality}`,
	}),
	/**
	 * The CIDR allowlist — the toll-fraud gate.
	 *
	 * `security.*` and not `settings.*`, which is the API's own division and worth restating: every
	 * self-service role holds `settings.read` so a user's preferences screen renders, and the list of
	 * networks that may register phones or terminate calls is not a preference. Writing one is the
	 * ability to open the platform to an arbitrary network, which is the same privilege class as
	 * issuing credentials — and `security.delete` deliberately does not exist, because deleting a
	 * rule and disabling it have the same effect and leave nothing behind.
	 *
	 * `affectsRouting: false`: `sip_acl_entry` is absent from `ROUTING_TABLE_TO_ENTITY`, the compiler
	 * has no ACL input, and evicting the compile view on every ACL edit would be cache churn with no
	 * consumer. The consequence an administrator IS surprised by is a different one, and the screen
	 * says it rather than this comment: an edit here does not reach the media server by itself.
	 */
	sipAclEntries: descriptor<SipAclEntryRow>({
		key: "sip-acl-entries",
		affectsRouting: false,
		path: "/sip-acl-entries",
		label: "access rule",
		labelPlural: "Access rules",
		permissions: { read: "security.read", write: "security.write", delete: "security.write" },
		displayName: (row) => (row.name ? `${row.network} · ${row.name}` : row.network),
	}),
	/**
	 * Outbound webhook subscriptions.
	 *
	 * DELETE rides `webhooks.write` rather than a `webhooks.delete` that does not exist — the
	 * controller makes the same choice, on the argument `security.delete` lost: deleting a
	 * subscription and disabling it stop the same deliveries.
	 *
	 * `affectsRouting: false` — `webhook_subscription` is not in `ROUTING_TABLE_TO_ENTITY`, the
	 * compiler has no webhook input, and an artifact eviction per endpoint edit would evict a panel
	 * that did not change.
	 */
	webhooks: descriptor<WebhookRow>({
		key: "webhooks",
		affectsRouting: false,
		path: "/webhooks",
		label: "webhook",
		labelPlural: "Webhooks",
		permissions: { read: "webhooks.read", write: "webhooks.write", delete: "webhooks.write" },
		displayName: (row) => row.description ?? row.url,
	}),
} as const;

/**
 * A child collection under a parent, e.g. `/ivr-menus/:id/options`.
 *
 * Deliberately not paginated, because the API is not: an IVR menu with more than a screenful of
 * options is a design problem rather than a paging problem, and the editor works on the whole
 * ordered list at once.
 */
export interface PbxChildDescriptor<TRow> {
	readonly key: string;
	readonly segment: string;
	readonly label: string;
	readonly parentPath: string;
	readonly displayName: (row: TRow) => string;
	/**
	 * Whether writing one changes what a call does.
	 *
	 * `affectsRouting()` in `@optimiq-voice/routing` is the authority, and it says `queue_tier` is
	 * NOT a routing input: the compiler emits a queue node with its strategy and announcements, and
	 * agent membership is live state the engine reads at dial time. Invalidating the compile view on
	 * every tier edit would evict a panel that did not change — and, worse, imply that staffing the
	 * floor republishes the dial plan.
	 */
	readonly affectsRouting: boolean;
}

function child<TRow>(value: PbxChildDescriptor<TRow>): PbxChildDescriptor<TRow> {
	return value;
}

export const PBX_CHILDREN = {
	ivrOptions: child<IvrMenuOptionRow>({
		key: "options",
		segment: "options",
		label: "option",
		parentPath: "/ivr-menus",
		displayName: (row) => row.label ?? row.matchValue,
		affectsRouting: true,
	}),
	ringGroupMembers: child<RingGroupMemberRow>({
		key: "destinations",
		segment: "destinations",
		label: "member",
		parentPath: "/ring-groups",
		displayName: (row) => `Member ${row.ordinal + 1}`,
		affectsRouting: true,
	}),
	/**
	 * The handsets one announcement reaches.
	 *
	 * `segment: "members"` and not `"destinations"`, which is the ring-group spelling and the
	 * difference is the feature rather than a naming preference: a ring-group member is a
	 * DESTINATION and may be a mobile over a trunk, while a paging member is an `extension_id`
	 * foreign key because the engine has to originate an auto-answered leg to a registered endpoint.
	 * An external number cannot be told to pick up.
	 *
	 * `affectsRouting: true` — `paging_group_member` IS in `ROUTING_TABLE_TO_ENTITY` (unlike
	 * `queue_tier`, the other ordered child), because who a page reaches is compiled into the
	 * artifact rather than read as live state at dial time.
	 */
	pagingGroupMembers: child<PagingGroupMemberRow>({
		key: "members",
		segment: "members",
		label: "member",
		parentPath: "/paging-groups",
		displayName: (row) => `Member ${row.ordinal + 1}`,
		affectsRouting: true,
	}),
	timeConditionRules: child<TimeConditionRuleRow>({
		key: "rules",
		segment: "rules",
		label: "rule",
		parentPath: "/time-conditions",
		displayName: (row) => row.label ?? `Rule ${row.ordinal + 1}`,
		affectsRouting: true,
	}),
	/**
	 * Queue tiers have no `ordinal` and therefore no reorder endpoint: a tier's place is
	 * `(level, position)`, which the caller sets explicitly because it decides who is offered the
	 * call first. It is routing policy, not a drag handle.
	 */
	queueTiers: child<QueueTierRow>({
		key: "tiers",
		segment: "tiers",
		label: "agent",
		parentPath: "/queues",
		displayName: (row) => `Level ${row.level}, position ${row.position}`,
		affectsRouting: false,
	}),
	/**
	 * The codes in a PIN set.
	 *
	 * `key` and `segment` differ here and on the ruleset's rules below, which is new in this file and
	 * is not cosmetic: `key` is the query-key segment AND the key `contracts.spec.ts` maps to a
	 * physical table, and a second child called `rules` would collide with `timeConditionRules` in
	 * that map. The URL segment is the server's and stays `entries` / `rules`.
	 *
	 * CREATE carries the code itself. The controller merges `setPinDto` into the create body on
	 * purpose — a code with no digest is a row the compiler drops with a warning, so a two-step
	 * create-then-set would leave a window in which the set looks configured on screen and gates
	 * nothing on the wire. The generic {@link createPbxChild} is what sends it; replacing an existing
	 * code is {@link setPinSetEntryPin}, which is a `PUT` of its own because the value is hashed on
	 * the way in and never comes back.
	 */
	pinSetEntries: child<PinSetEntryRow>({
		key: "pin-set-entries",
		segment: "entries",
		label: "code",
		parentPath: "/pin-sets",
		displayName: (row) => row.label ?? `Code ${row.ordinal}`,
		affectsRouting: true,
	}),
	/**
	 * The rewrites in a ruleset.
	 *
	 * `affectsRouting: true` — `translation_rule` is in `ROUTING_TABLE_TO_ENTITY`, and it has to be:
	 * the rules are compiled into the artifact as an ordered pipeline, so adding one changes what
	 * digits reach the carrier on the next call.
	 */
	translationRules: child<TranslationRuleRow>({
		key: "translation-rules",
		segment: "rules",
		label: "rule",
		parentPath: "/translation-rulesets",
		displayName: (row) => row.label ?? row.matchPattern,
		affectsRouting: true,
	}),
} as const;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export function pbxListSearchParams(query: PbxListQuery): string {
	const params = new URLSearchParams();
	params.set("page", String(Math.max(1, query.page ?? 1)));
	params.set("limit", String(Math.min(MAX_PAGE_LIMIT, query.limit ?? DEFAULT_PAGE_LIMIT)));
	if (query.search) {
		params.set("search", query.search);
	}
	if (query.enabled !== undefined) {
		params.set("enabled", String(query.enabled));
	}
	return params.toString();
}

export async function listPbx<TRow>(
	resource: PbxResourceDescriptor<TRow>,
	query: PbxListQuery,
): Promise<PagedEnvelope<TRow>> {
	return await apiFetch<PagedEnvelope<TRow>>(`${resource.path}?${pbxListSearchParams(query)}`);
}

/**
 * A list read for a caller that holds SEVERAL target resources at once and therefore cannot be
 * generic over one row type — the destination picker, which renders whichever list the selected
 * type names. Widening lives here rather than as a cast at the call site.
 */
export async function listPbxRows(
	path: string,
	query: PbxListQuery,
): Promise<PagedEnvelope<Record<string, unknown>>> {
	return await apiFetch<PagedEnvelope<Record<string, unknown>>>(
		`${path}?${pbxListSearchParams(query)}`,
	);
}

export async function getPbx<TRow>(
	resource: PbxResourceDescriptor<TRow>,
	id: string,
): Promise<TRow> {
	const { data } = await apiFetch<ItemEnvelope<TRow>>(`${resource.path}/${id}`);
	return data;
}

export async function createPbx<TRow>(
	resource: PbxResourceDescriptor<TRow>,
	values: Record<string, unknown>,
): Promise<MutationEnvelope<TRow>> {
	return await apiFetch<MutationEnvelope<TRow>>(resource.path, {
		method: "POST",
		body: JSON.stringify(values),
	});
}

/**
 * `PATCH`, with the API's own semantics: a key that is ABSENT is left alone, a key present as
 * `null` is cleared. Forms therefore send only what they edited — never a full row — because a
 * full row would resurrect defaults over values another surface set.
 */
export async function updatePbx<TRow>(
	resource: PbxResourceDescriptor<TRow>,
	id: string,
	values: Record<string, unknown>,
): Promise<MutationEnvelope<TRow>> {
	return await apiFetch<MutationEnvelope<TRow>>(`${resource.path}/${id}`, {
		method: "PATCH",
		body: JSON.stringify(values),
	});
}

export async function deletePbx<TRow>(
	resource: PbxResourceDescriptor<TRow>,
	id: string,
): Promise<MutationEnvelope<{ readonly id: string }>> {
	return await apiFetch<MutationEnvelope<{ readonly id: string }>>(`${resource.path}/${id}`, {
		method: "DELETE",
	});
}

export async function listPbxChildren<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentId: string,
): Promise<readonly TRow[]> {
	const { data } = await apiFetch<{ data: readonly TRow[] }>(
		`${child.parentPath}/${parentId}/${child.segment}`,
	);
	return data;
}

export async function createPbxChild<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentId: string,
	values: Record<string, unknown>,
): Promise<MutationEnvelope<TRow>> {
	return await apiFetch<MutationEnvelope<TRow>>(
		`${child.parentPath}/${parentId}/${child.segment}`,
		{ method: "POST", body: JSON.stringify(values) },
	);
}

export async function updatePbxChild<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentId: string,
	id: string,
	values: Record<string, unknown>,
): Promise<MutationEnvelope<TRow>> {
	return await apiFetch<MutationEnvelope<TRow>>(
		`${child.parentPath}/${parentId}/${child.segment}/${id}`,
		{ method: "PATCH", body: JSON.stringify(values) },
	);
}

export async function deletePbxChild<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentId: string,
	id: string,
): Promise<MutationEnvelope<{ readonly id: string }>> {
	return await apiFetch<MutationEnvelope<{ readonly id: string }>>(
		`${child.parentPath}/${parentId}/${child.segment}/${id}`,
		{ method: "DELETE" },
	);
}

/**
 * Rewrites a child collection's order in ONE request.
 *
 * The body is the COMPLETE list of ids in their new order, not a moved id and an index: the server
 * refuses anything that is not an exact permutation, which is what makes a stale editor's reorder a
 * recoverable 400 instead of a silent scramble. Sending N PATCHes instead would publish N
 * intermediate orders to the routing cache, each of them briefly executable.
 *
 * Returns the collection as the server stored it, so the caller renders that rather than the
 * optimistic order it sent.
 */
export async function reorderPbxChildren<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentId: string,
	ids: readonly string[],
): Promise<MutationEnvelope<readonly TRow[]>> {
	return await apiFetch<MutationEnvelope<readonly TRow[]>>(
		`${child.parentPath}/${parentId}/${child.segment}/reorder`,
		{ method: "PUT", body: JSON.stringify({ ids }) },
	);
}

// ---------------------------------------------------------------------------------------------
// The T2 admin block's verbs — the writes that are not a PATCH
// ---------------------------------------------------------------------------------------------

/**
 * Moves a call flow's switch.
 *
 * `POST` and a route of its own rather than a field on the `PATCH`, because it is a different
 * GRANT: `call-flows.toggle` is what a receptionist holds and `call-flows.write` is what re-points
 * the branches. It also writes the busy-lamp presence entry, which a `PATCH` would skip — leaving
 * every phone in the building showing the old position.
 *
 * `mode` is optional on the wire and absent means "the other one". This client always sends it,
 * which is what makes the button idempotent for a UI that has just rendered the current state: two
 * fast clicks on "Switch to night" leave the flow in night rather than back where it started.
 */
export async function toggleCallFlow(
	callFlowId: string,
	mode: CallFlowMode,
): Promise<MutationEnvelope<CallFlowRow>> {
	return await apiFetch<MutationEnvelope<CallFlowRow>>(`/call-flows/${callFlowId}/toggle`, {
		method: "POST",
		body: JSON.stringify({ mode }),
	});
}

/**
 * Overrules a time condition's clock, or hands it back.
 *
 * Under `/call-flows` rather than under `/time-conditions`, which is the server's routing decision
 * and the one this call is most likely to be argued with about. The reason is the grant: it is
 * guarded by `call-flows.toggle`, because forcing a condition open and flipping a flow to night are
 * one act on two tables. Editing the condition's RULES stays on `PATCH /time-conditions/:id` behind
 * `time-conditions.write`.
 *
 * The state is sent explicitly. Omitting it advances one step around the ring
 * (`auto → forced-match → forced-no-match → auto`), which is what a handset pressing the star code
 * does and is exactly wrong for a select that has just shown the user three named choices.
 */
export async function setTimeConditionOverride(
	timeConditionId: string,
	override: TimeConditionOverride,
): Promise<MutationEnvelope<TimeConditionRow>> {
	return await apiFetch<MutationEnvelope<TimeConditionRow>>(
		`/call-flows/time-conditions/${timeConditionId}/override`,
		{ method: "POST", body: JSON.stringify({ override }) },
	);
}

/**
 * Replaces one authorisation code's digits.
 *
 * `PUT` and a route of its own, exactly as a mailbox PIN is set: the value is hashed on the way in
 * (scrypt, the same digest format the engine already verifies) and never comes back, so a field on
 * the `PATCH` would make "did that save?" a question the response cannot answer. The ordinal and the
 * label are untouched, which is what keeps every historical "authorised by code 3" in the call
 * detail records pointing at the same code.
 */
export async function setPinSetEntryPin(
	pinSetId: string,
	entryId: string,
	pin: string,
): Promise<MutationEnvelope<PinSetEntryRow>> {
	return await apiFetch<MutationEnvelope<PinSetEntryRow>>(
		`/pin-sets/${pinSetId}/entries/${entryId}/pin`,
		{ method: "PUT", body: JSON.stringify({ pin }) },
	);
}

// ---------------------------------------------------------------------------------------------
// Organization limits — a singleton, not a resource
// ---------------------------------------------------------------------------------------------

/**
 * The organization's quotas.
 *
 * No descriptor and no `PbxResourceDescriptor`, because there is no collection: one row per
 * organization, reached without an id, and an absent row answers `{}` rather than a 404. The generic
 * CRUD machinery would be five verbs that do not exist behind a page control that cannot work.
 */
export async function fetchOrgLimits(): Promise<OrgLimits> {
	const { data } = await apiFetch<ItemEnvelope<OrgLimits>>("/org-limits");
	return data;
}

/**
 * Sets them.
 *
 * `PUT` because the body is the COMPLETE set of ceilings: a `PATCH` would make "remove this limit"
 * and "leave this limit alone" the same request. `null` clears a ceiling, which is how a limit is
 * removed — there is no default to reset to, because unlimited IS the default.
 *
 * `org-limits.write` is held by `owner` ALONE and is excluded from the admin template, on the
 * server's own argument: a quota an administrator can raise is not a quota. That is not a real
 * control-plane boundary and the screen says so rather than implying one.
 */
export async function writeOrgLimits(limits: OrgLimits): Promise<OrgLimits> {
	const { data } = await apiFetch<ItemEnvelope<OrgLimits>>("/org-limits", {
		method: "PUT",
		body: JSON.stringify(limits),
	});
	return data;
}

/** What the organization is using, against what it may. Guarded by `org-limits.read`, not `write`. */
export async function fetchOrgUsage(): Promise<OrgUsageReport> {
	const { data } = await apiFetch<ItemEnvelope<OrgUsageReport>>("/org-limits/usage");
	return data;
}

/** What each feature-code action's `params` accepts. Static per deployment; safe to cache hard. */
export async function fetchFeatureCodeParamFields(): Promise<FeatureCodeParamFields> {
	const { data } = await apiFetch<ItemEnvelope<FeatureCodeParamFields>>(
		"/feature-codes/param-fields",
	);
	return data;
}

// ---------------------------------------------------------------------------------------------
// Routing operations
// ---------------------------------------------------------------------------------------------

export async function compileRouting(): Promise<CompileResult> {
	const { data } = await apiFetch<ItemEnvelope<CompileResult>>("/routing/compile", {
		method: "POST",
		body: JSON.stringify({}),
	});
	return data;
}

export interface SimulateRequest {
	readonly routingContext: RoutingContext;
	readonly destinationNumber: string;
	readonly callerNumber?: string;
	readonly callerName?: string;
	readonly at?: string;
}

export async function simulateRouting(request: SimulateRequest): Promise<SimulateResult> {
	const { data } = await apiFetch<ItemEnvelope<SimulateResult>>("/routing/simulate", {
		method: "POST",
		body: JSON.stringify(request),
	});
	return data;
}

// ---------------------------------------------------------------------------------------------
// Voicemail: the PIN, and the messages in a mailbox
// ---------------------------------------------------------------------------------------------

/**
 * Sets a mailbox PIN.
 *
 * The plaintext travels in the body of a `POST` and nowhere else, and the server hashes it before
 * the request returns (`scrypt`, in the digest format `packages/routing` owns). Nothing here ever
 * receives a digest back — the reply is `{ pinSet: true }`.
 *
 * A dedicated route rather than a field on the mailbox `PATCH`, because a `PATCH` body that
 * sometimes contains a secret is a `PATCH` body that ends up in a debug log.
 */
export async function setVoicemailPin(
	boxId: string,
	pin: string,
): Promise<MutationEnvelope<VoicemailPinState>> {
	return await apiFetch<MutationEnvelope<VoicemailPinState>>(`/voicemail-boxes/${boxId}/pin`, {
		method: "POST",
		body: JSON.stringify({ pin }),
	});
}

/** Clears it. The mailbox falls back to authenticating by the calling extension. */
export async function clearVoicemailPin(
	boxId: string,
): Promise<MutationEnvelope<VoicemailPinState>> {
	return await apiFetch<MutationEnvelope<VoicemailPinState>>(`/voicemail-boxes/${boxId}/pin`, {
		method: "DELETE",
	});
}

export interface VoicemailMessageQuery {
	readonly folder?: VoicemailFolder | undefined;
	readonly page?: number | undefined;
	readonly limit?: number | undefined;
}

/** One page of a mailbox, newest first. An absent folder means everything except the trash. */
export async function listVoicemailMessages(
	boxId: string,
	query: VoicemailMessageQuery,
): Promise<VoicemailMessagePage> {
	const params = new URLSearchParams();
	if (query.folder !== undefined) {
		params.set("folder", query.folder);
	}
	params.set("page", String(query.page ?? 1));
	params.set("limit", String(query.limit ?? DEFAULT_PAGE_LIMIT));
	return await apiFetch<VoicemailMessagePage>(
		`/voicemail-boxes/${boxId}/messages?${params.toString()}`,
	);
}

/**
 * Marks a message read or unread.
 *
 * `read` rather than a folder, because that is the control the UI has. The server translates it —
 * read means "out of the `new` folder", which is the same fact the MWI lamp is defined by, so the
 * badge and the phone cannot disagree.
 */
export async function setVoicemailMessageRead(
	boxId: string,
	messageId: string,
	read: boolean,
): Promise<VoicemailMessageResult> {
	return await apiFetch<VoicemailMessageResult>(`/voicemail-boxes/${boxId}/messages/${messageId}`, {
		method: "PATCH",
		body: JSON.stringify({ read }),
	});
}

/**
 * Deletes a message.
 *
 * Without `purge` it moves to the `deleted` folder, which is the schema's own tombstone and is
 * recoverable. With it, the row goes. The audio object is never unlinked from here either way —
 * retention owns the object store's lifecycle.
 */
export async function deleteVoicemailMessage(
	boxId: string,
	messageId: string,
	purge = false,
): Promise<VoicemailMessageDeletion> {
	const suffix = purge ? "?purge=true" : "";
	return await apiFetch<VoicemailMessageDeletion>(
		`/voicemail-boxes/${boxId}/messages/${messageId}${suffix}`,
		{ method: "DELETE" },
	);
}

/**
 * Mints a playback URL for one message.
 *
 * `POST` because it CREATES a credential with a lifetime — the same argument
 * `mintRecordingDownloadUrl` makes, and the reason neither is ever cached: a URL minted at page
 * load and clicked twenty minutes later is a 410 that reads as "the recording is broken".
 */
export async function mintVoicemailPlaybackUrl(
	boxId: string,
	messageId: string,
): Promise<VoicemailPlaybackLink> {
	const { data } = await apiFetch<ItemEnvelope<VoicemailPlaybackLink>>(
		`/voicemail-boxes/${boxId}/messages/${messageId}/play-url`,
		{ method: "POST", body: JSON.stringify({}) },
	);
	return data;
}

// ---------------------------------------------------------------------------------------------
// Conference PINs
// ---------------------------------------------------------------------------------------------

/** Which of a room's two PINs an endpoint is setting. */
export type ConferencePinRole = "participant" | "moderator";

function conferencePinPath(conferenceId: string, role: ConferencePinRole): string {
	return `/conferences/${conferenceId}/${role === "moderator" ? "moderator-pin" : "pin"}`;
}

/**
 * Sets one of a conference room's PINs.
 *
 * The same contract as {@link setVoicemailPin}, down to the digest format: the plaintext travels in
 * the body of a `POST` and nowhere else, the server hashes it with scrypt before the request
 * returns, and nothing here ever receives a digest back.
 */
export async function setConferencePin(
	conferenceId: string,
	role: ConferencePinRole,
	pin: string,
): Promise<MutationEnvelope<ConferencePinState>> {
	return await apiFetch<MutationEnvelope<ConferencePinState>>(
		conferencePinPath(conferenceId, role),
		{ method: "POST", body: JSON.stringify({ pin }) },
	);
}

/** Clears it. Clearing the participant PIN opens the room to anyone who can dial its number. */
export async function clearConferencePin(
	conferenceId: string,
	role: ConferencePinRole,
): Promise<MutationEnvelope<ConferencePinState>> {
	return await apiFetch<MutationEnvelope<ConferencePinState>>(
		conferencePinPath(conferenceId, role),
		{ method: "DELETE" },
	);
}

// ---------------------------------------------------------------------------------------------
// Conference moderation — the live room, not the row
// ---------------------------------------------------------------------------------------------

/**
 * `/api/v1/conferences/:id/…` — the MEETING, as opposed to the configuration above it.
 *
 * A separate block from the PIN calls for the same reason the server keeps it in a separate
 * controller: nothing here touches the `conference` row, and everything here is gone when the
 * participant hangs up or the room empties. The two are also guarded differently — every route
 * declares `conferences.read` and the service makes the real decision against `conferences.moderate`
 * — so a caller that may set a room's PIN may still be refused a mute.
 *
 * ## The ACTION is in the path
 *
 * `POST …/participants/:ref/mute`, never `PATCH …/participants/:ref { muted: true }`. That is the
 * server's choice and it is worth mirroring rather than smoothing over: a path verb has exactly one
 * target, so there is no request a client can half-fill, and "POST …/kick" is what an audit trail
 * needs to read back.
 *
 * ## `:ref` is a LEG id
 *
 * The identifier `conference.joined` publishes — `lib/live/store.ts` holds it as
 * `LiveConferenceParticipant.legId` — and NOT a media channel id, which is the engine's private
 * handle onto a media server. The server treats it as an opaque token, so it is percent-encoded
 * here rather than assumed to be a UUID.
 */

export const CONFERENCE_PARTICIPANT_ACTIONS = ["mute", "unmute", "deaf", "undeaf", "kick"] as const;
export type ConferenceParticipantAction = (typeof CONFERENCE_PARTICIPANT_ACTIONS)[number];

/** Every verb this surface has, including the two that address a room rather than a person. */
export type ConferenceModerationAction = ConferenceParticipantAction | "volume" | "lock" | "unlock";

/**
 * Which half of a member's level a volume command moves. Omitted means both, which is a slider.
 *
 * Every value is refused with a typed 501 on both drivers today — see
 * {@link setConferenceParticipantVolume}.
 */
export const CONFERENCE_GAIN_SCOPES = ["talk", "listen", "both"] as const;
export type ConferenceGainScope = (typeof CONFERENCE_GAIN_SCOPES)[number];

/** Percent of unity, mirroring `setConferenceVolumeDto`. 100 is unchanged; 0 is silent. */
export const CONFERENCE_GAIN_PERCENT_MIN = 0;
export const CONFERENCE_GAIN_PERCENT_MAX = 400;

/**
 * What a moderation command answers with. Mirrors `ConferenceModerationView` in `apps/api`.
 *
 * It carries the member's WHOLE state rather than an acknowledgement, for the reason
 * `conference.participant.updated` does — so a caller may render the answer directly instead of
 * inferring what the command must have done.
 */
export interface ConferenceModerationView {
	readonly conferenceId: string;
	readonly action: ConferenceModerationAction;
	/** People in the room, cluster-wide, AFTER the command. */
	readonly memberCount: number;
	readonly locked?: boolean;
	readonly memberRef?: string;
	readonly muted?: boolean;
	readonly deafened?: boolean;
	readonly moderator?: boolean;
	readonly talkGainPercent?: number;
	readonly listenGainPercent?: number;
}

/**
 * The path a moderation command posts to.
 *
 * Exported, and built here rather than at each call site, because it is the one part of this
 * surface a spec can pin without a server: a room action and a participant action differ only by two
 * path segments, and a builder that put `:ref` on a `lock` would send a moderator's room command to
 * a member who does not exist.
 */
export function conferenceModerationPath(
	conferenceId: string,
	action: ConferenceModerationAction,
	memberRef?: string,
): string {
	if (action === "lock" || action === "unlock") {
		return `/conferences/${conferenceId}/${action}`;
	}
	// Percent-encoded because the server documents the leg id as an OPAQUE token it does not
	// validate the shape of. It is a UUID on this platform today, and encoding it costs nothing to
	// stop being true.
	return `/conferences/${conferenceId}/participants/${encodeURIComponent(memberRef ?? "")}/${action}`;
}

/**
 * The body for a volume command.
 *
 * `gainPercent` is ROUNDED, which is not tidying: the server's DTO is `z.number().int()` and a
 * slider bound to a numeric input can produce `99.5`, so an unrounded value would be a control that
 * fails validation for a reason no operator could see. `scope` is omitted when unspecified, because
 * an absent scope means "both" to the server and sending a value it would have defaulted anyway
 * turns a single slider into a request that claims to have chosen.
 */
export function conferenceVolumeBody(
	gainPercent: number,
	scope?: ConferenceGainScope,
): { readonly gainPercent: number; readonly scope?: ConferenceGainScope } {
	return {
		gainPercent: Math.round(gainPercent),
		...(scope === undefined ? {} : { scope }),
	};
}

/**
 * Mutes, unmutes, deafens, undeafens or removes one participant.
 *
 * The body is `{}` and not absent, on the `applyAgentSessionAction` precedent: the server's DTO is
 * `strictObject({})`, so a typo'd key is a 400 rather than a silently dropped value — and on this
 * surface a dropped value would be the difference between muting somebody and doing nothing.
 */
export async function moderateConferenceParticipant(
	conferenceId: string,
	memberRef: string,
	action: ConferenceParticipantAction,
): Promise<ItemEnvelope<ConferenceModerationView>> {
	return await apiFetch<ItemEnvelope<ConferenceModerationView>>(
		conferenceModerationPath(conferenceId, action, memberRef),
		{ method: "POST", body: JSON.stringify({}) },
	);
}

/**
 * Stops, or resumes, the room admitting new participants.
 *
 * The state is sent as the VERB rather than as a body field, which is what makes the control
 * idempotent for a panel that has just rendered the current state: two fast clicks on Lock leave the
 * room locked rather than back where it started. A room at its member cap is a different thing and
 * gets a different announcement — full admits the next arrival when somebody leaves, locked does
 * not admit anybody.
 */
export async function setConferenceLocked(
	conferenceId: string,
	locked: boolean,
): Promise<ItemEnvelope<ConferenceModerationView>> {
	return await apiFetch<ItemEnvelope<ConferenceModerationView>>(
		conferenceModerationPath(conferenceId, locked ? "lock" : "unlock"),
		{ method: "POST", body: JSON.stringify({}) },
	);
}

/**
 * Re-levels a participant — and is REFUSED with a typed 501 on every media plane this platform runs.
 *
 * It exists here rather than being omitted for the same reason the route exists rather than 404ing:
 * what is missing is a WIRE, not a feature. Asterisk has no per-participant gain on a mixing bridge
 * at all, and `apps/mediad`'s mixer has `Member.SetGain` with no command that reaches it. A client
 * that hid the control would tell an operator this product does not do volume control; a client that
 * offers it disabled, naming the `CONFERENCE_ACTION_NOT_SERVABLE` refusal, tells them the truth.
 *
 * So the only caller today is the one that would fire if the seam were built. See
 * `conferenceModerationMessage` in `./errors.ts` for the words the refusal is rendered as.
 */
export async function setConferenceParticipantVolume(
	conferenceId: string,
	memberRef: string,
	gainPercent: number,
	scope?: ConferenceGainScope,
): Promise<ItemEnvelope<ConferenceModerationView>> {
	return await apiFetch<ItemEnvelope<ConferenceModerationView>>(
		conferenceModerationPath(conferenceId, "volume", memberRef),
		{ method: "POST", body: JSON.stringify(conferenceVolumeBody(gainPercent, scope)) },
	);
}

// ---------------------------------------------------------------------------------------------
// The media library
// ---------------------------------------------------------------------------------------------

export interface PromptListQuery extends PbxListQuery {
	readonly kind?: PromptKind | undefined;
	readonly mohClassId?: string | undefined;
}

/**
 * One page of the prompt library.
 *
 * An absent `kind` means the two kinds a prompt PICKER can offer — `prompt` and `greeting` — and
 * never MOH files, which are reached through their class. The API decides that; this just does not
 * send a `kind` when there is none.
 */
export async function listPrompts(query: PromptListQuery): Promise<PagedEnvelope<PromptRow>> {
	const params = new URLSearchParams(pbxListSearchParams(query));
	if (query.kind !== undefined) {
		params.set("kind", query.kind);
	}
	if (query.mohClassId !== undefined) {
		params.set("mohClassId", query.mohClassId);
	}
	const search = params.toString();
	return await apiFetch<PagedEnvelope<PromptRow>>(
		`/prompts${search.length > 0 ? `?${search}` : ""}`,
	);
}

/**
 * Uploads an audio file into the library.
 *
 * `multipart/form-data` through {@link apiUpload}, because that is what a browser produces from a
 * `<input type="file">` and because `prompt.object_key` is `notNull` — there is no JSON create for
 * this resource and there will not be one.
 *
 * The server refuses anything it cannot play: content type, file extension and MAGIC BYTES are all
 * checked, and the last is the one that matters (a renamed executable declares `audio/wav`). A
 * refusal is an `ApiError` carrying `MEDIA_UPLOAD_REJECTED` and an `issues[]` entry addressed at
 * `file`, so a form renders it under the file input.
 */
export async function uploadPrompt(
	file: File,
	fields: { readonly name?: string; readonly language?: string } = {},
): Promise<MutationEnvelope<PromptRow>> {
	return await apiUpload<MutationEnvelope<PromptRow>>("/prompts", file, fields);
}

export async function updatePrompt(
	promptId: string,
	values: { readonly name?: string; readonly language?: string },
): Promise<MutationEnvelope<PromptRow>> {
	return await apiFetch<MutationEnvelope<PromptRow>>(`/prompts/${promptId}`, {
		method: "PATCH",
		body: JSON.stringify(values),
	});
}

/** Deletes a prompt and its stored object. Refused with a 409 while anything still plays it. */
export async function deletePrompt(promptId: string): Promise<MutationEnvelope<{ id: string }>> {
	return await apiFetch<MutationEnvelope<{ id: string }>>(`/prompts/${promptId}`, {
		method: "DELETE",
	});
}

/** The audio files under one hold-music class. Not paginated — the API does not paginate it. */
export async function listMohFiles(mohClassId: string): Promise<readonly PromptRow[]> {
	const { data } = await apiFetch<{ data: readonly PromptRow[] }>(
		`/moh-classes/${mohClassId}/files`,
	);
	return data;
}

export async function uploadMohFile(
	mohClassId: string,
	file: File,
	fields: { readonly name?: string } = {},
): Promise<MutationEnvelope<PromptRow>> {
	return await apiUpload<MutationEnvelope<PromptRow>>(
		`/moh-classes/${mohClassId}/files`,
		file,
		fields,
	);
}

export async function deleteMohFile(
	mohClassId: string,
	fileId: string,
): Promise<MutationEnvelope<{ id: string }>> {
	return await apiFetch<MutationEnvelope<{ id: string }>>(
		`/moh-classes/${mohClassId}/files/${fileId}`,
		{ method: "DELETE" },
	);
}

/**
 * Mints a short-lived preview link for a stored prompt.
 *
 * A `POST` for a read-shaped operation, deliberately: it creates a credential with a lifetime, and
 * a `GET` that minted one would be prefetched, cached and logged as though it were idempotent. The
 * same reasoning as {@link mintVoicemailPlaybackUrl}, and the same reason the link is never held in
 * a query cache.
 */
export async function mintPromptPlaybackUrl(promptId: string): Promise<MediaPlaybackLink> {
	const { data } = await apiFetch<ItemEnvelope<MediaPlaybackLink>>(
		`/prompts/${promptId}/play-url`,
		{ method: "POST", body: JSON.stringify({}) },
	);
	return data;
}

// ---------------------------------------------------------------------------------------------
// Voicemail greetings
// ---------------------------------------------------------------------------------------------

export async function listVoicemailGreetings(
	boxId: string,
): Promise<readonly VoicemailGreetingRow[]> {
	const { data } = await apiFetch<{ data: readonly VoicemailGreetingRow[] }>(
		`/voicemail-boxes/${boxId}/greetings`,
	);
	return data;
}

/**
 * Uploads a greeting.
 *
 * `active` defaults to TRUE on the server, and the form says so: an admin who has just uploaded a
 * greeting has expressed an intention, and leaving it inactive would mean the obvious action
 * silently does not change what callers hear. It is a multipart TEXT part, so it travels as
 * `"true"` / `"false"`.
 */
export async function uploadVoicemailGreeting(
	boxId: string,
	file: File,
	fields: {
		readonly kind?: VoicemailGreetingKind;
		readonly label?: string;
		readonly active?: boolean;
	} = {},
): Promise<MutationEnvelope<VoicemailGreetingRow>> {
	return await apiUpload<MutationEnvelope<VoicemailGreetingRow>>(
		`/voicemail-boxes/${boxId}/greetings`,
		file,
		{
			...(fields.kind === undefined ? {} : { kind: fields.kind }),
			...(fields.label === undefined ? {} : { label: fields.label }),
			...(fields.active === undefined ? {} : { active: String(fields.active) }),
		},
	);
}

/**
 * Activates or deactivates a greeting.
 *
 * Two routes rather than a `PATCH { active }`, because activation is a two-row write on the server
 * (the incumbent for that kind is stood down in the same transaction, which is what the partial
 * unique index requires) and because deactivating a `temporary` greeting is the normal way to come
 * back from holiday — a distinct verb, not a checkbox.
 */
export async function setVoicemailGreetingActive(
	boxId: string,
	greetingId: string,
	active: boolean,
): Promise<MutationEnvelope<VoicemailGreetingRow>> {
	return await apiFetch<MutationEnvelope<VoicemailGreetingRow>>(
		`/voicemail-boxes/${boxId}/greetings/${greetingId}/${active ? "activate" : "deactivate"}`,
		{ method: "POST", body: JSON.stringify({}) },
	);
}

export async function deleteVoicemailGreeting(
	boxId: string,
	greetingId: string,
): Promise<MutationEnvelope<{ id: string }>> {
	return await apiFetch<MutationEnvelope<{ id: string }>>(
		`/voicemail-boxes/${boxId}/greetings/${greetingId}`,
		{ method: "DELETE" },
	);
}

export async function mintGreetingPlaybackUrl(
	boxId: string,
	greetingId: string,
): Promise<MediaPlaybackLink> {
	const { data } = await apiFetch<ItemEnvelope<MediaPlaybackLink>>(
		`/voicemail-boxes/${boxId}/greetings/${greetingId}/play-url`,
		{ method: "POST", body: JSON.stringify({}) },
	);
	return data;
}

// ---------------------------------------------------------------------------------------------
// The two ledgers
// ---------------------------------------------------------------------------------------------

/**
 * One page of the change ledger, newest first.
 *
 * Not `listPbx`, and the difference is the envelope rather than a preference: these endpoints
 * answer `{ data, nextCursor, limit, range }` with no `total` and no `page`, because a `count(*)`
 * over a table that takes a row for every mutation forever is the exact cost keyset pagination
 * exists to avoid — and `offset` over a ledger being appended to while somebody reads it silently
 * skips rows. So there is no resource descriptor for either of these: the generic CRUD machinery
 * would be five verbs that do not exist behind a page control that cannot work.
 *
 * There is deliberately no `getAuditLogEntry`. A ledger entry IS its detail — the diff, the actor
 * and the request id are all on the list row — so the server offers no `GET /:id` to call.
 */
export async function listAuditLog(
	query: AuditLogQueryParams,
): Promise<AuditCursorEnvelope<AuditLogEntryRow>> {
	return await apiFetch<AuditCursorEnvelope<AuditLogEntryRow>>(
		`/audit-log?${ledgerSearchParams({ ...query })}`,
	);
}

/** One page of the authentication-failure ledger, newest first. The same envelope, deliberately. */
export async function listSipAuthEvents(
	query: SipAuthEventQueryParams,
): Promise<AuditCursorEnvelope<SipAuthEventRow>> {
	return await apiFetch<AuditCursorEnvelope<SipAuthEventRow>>(
		`/sip-auth-events?${ledgerSearchParams({ ...query })}`,
	);
}
