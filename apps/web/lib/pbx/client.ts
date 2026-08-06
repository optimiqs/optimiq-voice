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
import type { Permission } from "../permissions";
import type {
	CompileResult,
	ConferencePinState,
	ConferenceRow,
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
	OutboundRouteRow,
	PagedEnvelope,
	ParkLotRow,
	PhoneNumberRow,
	PromptKind,
	PromptRow,
	QueueAgentRow,
	QueueRow,
	QueueTierRow,
	RingGroupMemberRow,
	RingGroupRow,
	RoutingContext,
	SimulateResult,
	TimeConditionRow,
	TimeConditionRuleRow,
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
	ivrMenus: descriptor<IvrMenuRow>({
		key: "ivr-menus",
		affectsRouting: true,
		path: "/ivr-menus",
		label: "IVR menu",
		labelPlural: "IVR menus",
		permissions: { read: "ivr.read", write: "ivr.write", delete: "ivr.delete" },
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
	 * `affectsRouting: false`, and the reason is worth knowing before changing it: the compiler
	 * copies a `promptId` into a plan node VERBATIM and never resolves it, so renaming a prompt or
	 * replacing its audio changes nothing the artifact contains. If that ever changes, `prompt` has
	 * to be added to `ROUTING_TABLE_TO_ENTITY` in the same commit.
	 *
	 * There is no generic `createPbx` for this resource — a prompt is created by an upload, because
	 * `prompt.object_key` is `notNull` and a library entry with no audio is an entry an IVR can be
	 * pointed at that plays nothing. See {@link uploadPrompt}.
	 */
	prompts: descriptor<PromptRow>({
		key: "prompts",
		affectsRouting: false,
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
		affectsRouting: false,
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
	return await apiFetch<VoicemailMessageResult>(
		`/voicemail-boxes/${boxId}/messages/${messageId}`,
		{ method: "PATCH", body: JSON.stringify({ read }) },
	);
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
