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

import { apiFetch } from "../api-client";
import type { Permission } from "../permissions";
import type {
	CompileResult,
	ConferenceRow,
	ExtensionRow,
	FeatureCodeParamFields,
	FeatureCodeRow,
	InboundRouteRow,
	ItemEnvelope,
	IvrMenuOptionRow,
	IvrMenuRow,
	MutationEnvelope,
	OutboundRouteRow,
	PagedEnvelope,
	ParkLotRow,
	PhoneNumberRow,
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
	/** Used by the destination picker and reference lists to name a row. */
	readonly displayName: (row: TRow) => string;
}

function descriptor<TRow>(value: PbxResourceDescriptor<TRow>): PbxResourceDescriptor<TRow> {
	return value;
}

export const PBX_RESOURCES = {
	extensions: descriptor<ExtensionRow>({
		key: "extensions",
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
		path: "/phone-numbers",
		label: "number",
		labelPlural: "Numbers",
		permissions: { read: "numbers.read", write: "numbers.write", delete: "numbers.delete" },
		displayName: (row) => (row.label ? `${row.e164} · ${row.label}` : row.e164),
	}),
	trunks: descriptor<TrunkRow>({
		key: "trunks",
		path: "/trunks",
		label: "trunk",
		labelPlural: "Trunks",
		permissions: { read: "trunks.read", write: "trunks.write", delete: "trunks.delete" },
		displayName: (row) => row.name,
	}),
	inboundRoutes: descriptor<InboundRouteRow>({
		key: "inbound-routes",
		path: "/inbound-routes",
		label: "inbound route",
		labelPlural: "Inbound routes",
		permissions: { read: "routes.read", write: "routes.write", delete: "routes.delete" },
		displayName: (row) => row.name,
	}),
	outboundRoutes: descriptor<OutboundRouteRow>({
		key: "outbound-routes",
		path: "/outbound-routes",
		label: "outbound route",
		labelPlural: "Outbound routes",
		permissions: { read: "routes.read", write: "routes.write", delete: "routes.delete" },
		displayName: (row) => row.name,
	}),
	timeConditions: descriptor<TimeConditionRow>({
		key: "time-conditions",
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
		path: "/ivr-menus",
		label: "IVR menu",
		labelPlural: "IVR menus",
		permissions: { read: "ivr.read", write: "ivr.write", delete: "ivr.delete" },
		displayName: (row) => row.name,
	}),
	ringGroups: descriptor<RingGroupRow>({
		key: "ring-groups",
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
		path: "/park-lots",
		label: "park lot",
		labelPlural: "Park lots",
		permissions: { read: "park-lots.read", write: "park-lots.write", delete: "park-lots.delete" },
		displayName: (row) => `${row.name} (${row.slotStart}–${row.slotEnd})`,
	}),
	voicemailBoxes: descriptor<VoicemailBoxRow>({
		key: "voicemail-boxes",
		path: "/voicemail-boxes",
		label: "voicemail box",
		labelPlural: "Voicemail boxes",
		permissions: { read: "voicemail.read", write: "voicemail.write", delete: "voicemail.delete" },
		displayName: (row) => (row.label ? `${row.mailboxNumber} · ${row.label}` : row.mailboxNumber),
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
	}),
	ringGroupMembers: child<RingGroupMemberRow>({
		key: "destinations",
		segment: "destinations",
		label: "member",
		parentPath: "/ring-groups",
		displayName: (row) => `Member ${row.ordinal + 1}`,
	}),
	timeConditionRules: child<TimeConditionRuleRow>({
		key: "rules",
		segment: "rules",
		label: "rule",
		parentPath: "/time-conditions",
		displayName: (row) => row.label ?? `Rule ${row.ordinal + 1}`,
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
