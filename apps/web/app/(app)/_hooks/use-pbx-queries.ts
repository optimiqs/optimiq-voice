"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import {
	createPbx,
	createPbxChild,
	deletePbx,
	deletePbxChild,
	fetchFeatureCodeParamFields,
	fetchOrgLimits,
	fetchOrgUsage,
	getPbx,
	listPbx,
	listPbxChildren,
	PBX_RESOURCES,
	reorderPbxChildren,
	setPinSetEntryPin,
	setTimeConditionOverride,
	toggleCallFlow,
	updatePbx,
	updatePbxChild,
	writeOrgLimits,
	type PbxChildDescriptor,
	type PbxListQuery,
	type PbxResourceDescriptor,
} from "~/lib/pbx/client";
import { pbxErrorCode, pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";
import type {
	CallFlowMode,
	CallFlowRow,
	FeatureCodeParamFields,
	MutationEnvelope,
	OrgLimits,
	OrgUsageReport,
	PagedEnvelope,
	PinSetEntryRow,
	TimeConditionOverride,
	TimeConditionRow,
	WireDiagnostic,
} from "~/lib/pbx/contracts";

/**
 * Server state for the PBX area.
 *
 * ## Invalidation is coarse on purpose
 *
 * Every mutation invalidates the whole resource subtree (`queryKeys.pbxResource`), never the one
 * page it happened to be looking at. Creating an extension changes the total, which changes the
 * page count, which changes what page 3 contains — and any destination picker anywhere in the app
 * is reading the same list. Surgical invalidation here would be a permanent source of "the picker
 * does not show the thing I just made".
 *
 * A mutation that touched a **routing** table also invalidates the compile view, because the
 * artifact it describes is now a different artifact.
 *
 * ## Warnings are not errors
 *
 * A mutation envelope carries `warnings` and the write SUCCEEDED. The toast says so first, and
 * the caller is handed the diagnostics to render in the page — where they can be re-read, unlike
 * a toast. `onSuccess` never turns a warning into a failure.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

export interface PbxListResult<TRow> {
	readonly query: UseQueryResult<PagedEnvelope<TRow>>;
	readonly rows: readonly TRow[];
	readonly total: number;
	readonly totalPages: number;
}

export function usePbxList<TRow>(
	resource: PbxResourceDescriptor<TRow>,
	query: PbxListQuery,
	options: { readonly enabled?: boolean } = {},
): PbxListResult<TRow> {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.pbxList(organizationId, resource.key, {
			page: query.page ?? 1,
			limit: query.limit ?? null,
			search: query.search ?? null,
			enabled: query.enabled ?? null,
		}),
		queryFn: () => listPbx(resource, query),
		enabled: organizationId.length > 0 && options.enabled !== false,
		placeholderData: (previous) => previous,
	});

	return {
		query: result,
		rows: result.data?.data ?? [],
		total: result.data?.total ?? 0,
		totalPages: result.data?.totalPages ?? 0,
	};
}

export function usePbxItem<TRow>(
	resource: PbxResourceDescriptor<TRow>,
	id: string | undefined,
): UseQueryResult<TRow> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.pbxItem(organizationId, resource.key, id ?? ""),
		queryFn: () => getPbx(resource, id as string),
		enabled: organizationId.length > 0 && Boolean(id),
	});
}

export function usePbxChildren<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentResourceKey: string,
	parentId: string | undefined,
): UseQueryResult<readonly TRow[]> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.pbxChildren(organizationId, parentResourceKey, parentId ?? "", child.key),
		queryFn: () => listPbxChildren(child, parentId as string),
		enabled: organizationId.length > 0 && Boolean(parentId),
	});
}

/**
 * Invalidates a resource's cached pages, and the compile view when the write could change what a
 * call does.
 *
 * Whether it could is the DESCRIPTOR's answer (`affectsRouting`), pinned against
 * `@optimiq-voice/routing` in `contracts.spec.ts` — not a second list kept here, which is how the
 * two would come to disagree. A child collection passes its own, because a queue tier lives under
 * `queues` and yet is not a routing input: the compiler emits a queue node with its strategy and
 * announcements, and who is logged into it is live state the engine reads at dial time. Staffing the
 * floor must not look like republishing the dial plan.
 */
function useInvalidatePbx(resourceKey: string, affectsRouting: boolean): () => Promise<void> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return async () => {
		await queryClient.invalidateQueries({
			queryKey: queryKeys.pbxResource(organizationId, resourceKey),
		});
		if (affectsRouting) {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.routingCompile(organizationId),
			});
		}
	};
}

/**
 * What each feature-code action's `params` accepts, so the form renders a control rather than a
 * JSON box.
 *
 * Static per deployment — it describes the action, not the tenant — so it is cached hard and never
 * refetched. The one thing it can be is FORBIDDEN, for a caller without `feature-codes.read`, and
 * the dialog treats that as "no declared parameters" rather than as an error to show.
 */
export function useFeatureCodeParamFields(): UseQueryResult<FeatureCodeParamFields> {
	return useQuery({
		queryKey: queryKeys.featureCodeParamFields(),
		queryFn: fetchFeatureCodeParamFields,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
}

export function usePbxCreate<TRow>(
	resource: PbxResourceDescriptor<TRow>,
): UseMutationResult<MutationEnvelope<TRow>, Error, Record<string, unknown>> {
	const invalidate = useInvalidatePbx(resource.key, resource.affectsRouting);

	return useMutation({
		mutationFn: (values: Record<string, unknown>) => createPbx(resource, values),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, `${capitalize(resource.label)} created`);
		},
		/**
		 * No toast for a validation failure. The messages are already attached to the controls that
		 * caused them, and a toast repeating them is a second copy that disappears — see the
		 * convention in `components/ui/toast.tsx`.
		 */
		onError: (error) => {
			if (!isFieldAddressable(error)) {
				toast.error(pbxToastMessage(error, `Could not create the ${resource.label}`));
			}
		},
	});
}

export function usePbxUpdate<TRow>(
	resource: PbxResourceDescriptor<TRow>,
): UseMutationResult<
	MutationEnvelope<TRow>,
	Error,
	{ readonly id: string; readonly values: Record<string, unknown> }
> {
	const invalidate = useInvalidatePbx(resource.key, resource.affectsRouting);

	return useMutation({
		mutationFn: ({ id, values }: { id: string; values: Record<string, unknown> }) =>
			updatePbx(resource, id, values),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, `${capitalize(resource.label)} saved`);
		},
		onError: (error) => {
			if (!isFieldAddressable(error)) {
				toast.error(pbxToastMessage(error, `Could not save the ${resource.label}`));
			}
		},
	});
}

export function usePbxDelete<TRow>(
	resource: PbxResourceDescriptor<TRow>,
): UseMutationResult<MutationEnvelope<{ readonly id: string }>, Error, string> {
	const invalidate = useInvalidatePbx(resource.key, resource.affectsRouting);

	return useMutation({
		mutationFn: (id: string) => deletePbx(resource, id),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, `${capitalize(resource.label)} deleted`);
		},
		/**
		 * A `PBX_REFERENCED` 409 stays on screen: the confirmation dialog renders the referring rows
		 * as links, and a toast cannot carry a link the user can follow.
		 */
		onError: (error) => {
			toast.error(pbxToastMessage(error, `Could not delete the ${resource.label}`));
		},
	});
}

export function usePbxChildCreate<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentResourceKey: string,
	parentId: string | undefined,
): UseMutationResult<MutationEnvelope<TRow>, Error, Record<string, unknown>> {
	const invalidate = useInvalidatePbx(parentResourceKey, child.affectsRouting);

	return useMutation({
		mutationFn: (values: Record<string, unknown>) =>
			createPbxChild(child, parentId as string, values),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, `${capitalize(child.label)} added`);
		},
		onError: (error) => {
			if (!isFieldAddressable(error)) {
				toast.error(pbxToastMessage(error, `Could not add the ${child.label}`));
			}
		},
	});
}

export function usePbxChildUpdate<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentResourceKey: string,
	parentId: string | undefined,
): UseMutationResult<
	MutationEnvelope<TRow>,
	Error,
	{ readonly id: string; readonly values: Record<string, unknown> }
> {
	const invalidate = useInvalidatePbx(parentResourceKey, child.affectsRouting);

	return useMutation({
		mutationFn: ({ id, values }: { id: string; values: Record<string, unknown> }) =>
			updatePbxChild(child, parentId as string, id, values),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, `${capitalize(child.label)} saved`);
		},
		onError: (error) => {
			if (!isFieldAddressable(error)) {
				toast.error(pbxToastMessage(error, `Could not save the ${child.label}`));
			}
		},
	});
}

/**
 * Rewrites a child collection's order in ONE request.
 *
 * The mutation takes the COMPLETE list of ids in their new order, because that is what the server
 * takes: it refuses anything that is not an exact permutation, which turns a stale editor's reorder
 * into a recoverable 400 rather than a silent scramble. There is deliberately no optimistic update —
 * the reply carries the collection as the server stored it, and the invalidation below is what puts
 * it on screen. An optimistic swap would show an order that a refused permutation then reverted,
 * which is the one moment a drag control must not lie.
 */
export function usePbxChildReorder<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentResourceKey: string,
	parentId: string | undefined,
): UseMutationResult<MutationEnvelope<readonly TRow[]>, Error, readonly string[]> {
	const invalidate = useInvalidatePbx(parentResourceKey, child.affectsRouting);

	return useMutation({
		mutationFn: (ids: readonly string[]) => reorderPbxChildren(child, parentId as string, ids),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, "Order saved");
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, `Could not reorder the ${child.label} list`));
		},
	});
}

export function usePbxChildDelete<TRow>(
	child: PbxChildDescriptor<TRow>,
	parentResourceKey: string,
	parentId: string | undefined,
): UseMutationResult<MutationEnvelope<{ readonly id: string }>, Error, string> {
	const invalidate = useInvalidatePbx(parentResourceKey, child.affectsRouting);

	return useMutation({
		mutationFn: (id: string) => deletePbxChild(child, parentId as string, id),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, `${capitalize(child.label)} removed`);
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, `Could not remove the ${child.label}`));
		},
	});
}

// ---------------------------------------------------------------------------------------------
// The T2 admin block's verbs — the writes that are not a PATCH
// ---------------------------------------------------------------------------------------------

/**
 * Moves a call flow's switch.
 *
 * Invalidated exactly as an ordinary write is, through the SAME handle: a toggle is a routing write
 * — `call_flow` is in `ROUTING_TABLE_TO_ENTITY` — so the compile view has to be evicted with the
 * list, and the phones in the building have already been told (the server publishes the busy-lamp
 * presence entry after the commit, never before).
 *
 * The toast says which way it went rather than "saved", because that is the entire content of the
 * action and it is the thing somebody will want to confirm from across the room.
 */
export function useCallFlowToggle(): UseMutationResult<
	MutationEnvelope<CallFlowRow>,
	Error,
	{ readonly id: string; readonly mode: CallFlowMode }
> {
	const resource = PBX_RESOURCES.callFlows;
	const invalidate = useInvalidatePbx(resource.key, resource.affectsRouting);

	return useMutation({
		mutationFn: ({ id, mode }: { id: string; mode: CallFlowMode }) => toggleCallFlow(id, mode),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, `${result.data.name} is now in ${result.data.mode} mode`);
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not move the switch"));
		},
	});
}

/**
 * Forces a time condition open or closed, or hands it back to the clock.
 *
 * Invalidates the TIME-CONDITIONS resource even though the endpoint lives under `/call-flows`: the
 * row that changed is a time condition, and the screen showing it is the one that has to refetch.
 * The path is a fact about which grant guards the write, not about which cache holds the row.
 */
export function useTimeConditionOverride(): UseMutationResult<
	MutationEnvelope<TimeConditionRow>,
	Error,
	{ readonly id: string; readonly override: TimeConditionOverride }
> {
	const resource = PBX_RESOURCES.timeConditions;
	const invalidate = useInvalidatePbx(resource.key, resource.affectsRouting);

	return useMutation({
		mutationFn: ({ id, override }: { id: string; override: TimeConditionOverride }) =>
			setTimeConditionOverride(id, override),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(
				result.warnings,
				result.data.override === "auto"
					? `${result.data.name} is following its schedule again`
					: `${result.data.name} is overridden`,
			);
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not change the override"));
		},
	});
}

/**
 * Replaces one authorisation code's digits.
 *
 * The success message deliberately does not echo anything: the value was hashed on the way in and
 * the reply carries the row without it, so there is nothing to confirm except that it happened.
 */
export function useSetPinSetEntryPin(
	pinSetId: string | undefined,
): UseMutationResult<
	MutationEnvelope<PinSetEntryRow>,
	Error,
	{ readonly entryId: string; readonly pin: string }
> {
	const resource = PBX_RESOURCES.pinSets;
	const invalidate = useInvalidatePbx(resource.key, resource.affectsRouting);

	return useMutation({
		mutationFn: ({ entryId, pin }: { entryId: string; pin: string }) =>
			setPinSetEntryPin(pinSetId as string, entryId, pin),
		onSuccess: async (result) => {
			await invalidate();
			announceSave(result.warnings, "Code set");
		},
		onError: (error) => {
			if (!isFieldAddressable(error)) {
				toast.error(pbxToastMessage(error, "Could not set the code"));
			}
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Organization limits
// ---------------------------------------------------------------------------------------------

/**
 * The organization's quotas, and what it is using against them.
 *
 * The usage query is the ONE read in this module that is not held indefinitely: the counts move
 * whenever anybody anywhere creates an extension or uploads audio, and no mutation in this app can
 * be relied on to have been the one that did it (another admin, an API key, a voicemail left five
 * minutes ago). So it refetches on mount, which is the whole lifetime of the page it serves.
 *
 * A caller without `org-limits.read` gets a 403 — the page is gated on that grant, so this is only
 * reachable by somebody who holds it, and a failure here is a real failure worth showing.
 */
export function useOrgLimits(): UseQueryResult<OrgLimits> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.orgLimits(organizationId),
		queryFn: fetchOrgLimits,
		enabled: organizationId.length > 0,
	});
}

export function useOrgUsage(): UseQueryResult<OrgUsageReport> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.orgUsage(organizationId),
		queryFn: fetchOrgUsage,
		enabled: organizationId.length > 0,
		refetchOnMount: "always",
	});
}

/**
 * Sets them.
 *
 * Invalidates `orgLimits`, which takes the usage report with it by key hierarchy — raising a ceiling
 * changes every ratio on screen, and a bar still reading "48 of 50" beside a limit somebody has just
 * moved to 100 is the exact confusion this page exists to remove.
 *
 * No routing invalidation: `org_limit` is not in `ROUTING_TABLE_TO_ENTITY` and the compiler has no
 * quota input. `maxConcurrentCalls` IS enforced by the engine at admission, but through the org
 * settings the artifact already carries rather than through this table.
 */
export function useOrgLimitsSave(): UseMutationResult<OrgLimits, Error, OrgLimits> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: (limits: OrgLimits) => writeOrgLimits(limits),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.orgLimits(organizationId) });
			toast.success("Limits saved");
		},
		onError: (error) => {
			if (!isFieldAddressable(error)) {
				toast.error(pbxToastMessage(error, "Could not save the limits"));
			}
		},
	});
}

/**
 * A save with warnings SUCCEEDED. The toast must not be ambiguous about that, so the success
 * variant is used either way and the count is a description rather than a headline.
 */
function announceSave(warnings: readonly WireDiagnostic[], message: string): void {
	if (warnings.length === 0) {
		toast.success(message);
		return;
	}
	toast.success(message, {
		description: `Saved with ${warnings.length} warning${warnings.length === 1 ? "" : "s"} — see the details on screen.`,
	});
}

/**
 * Whether the failure will already be visible on a control.
 *
 * These four codes carry a field name, so the form has attached the message where the user is
 * looking. A toast on top of that is a second copy of the same sentence that then disappears.
 * `ROUTING_COMPILE_FAILED` is the exception that proves it: it is field-addressable AND the write
 * was rolled back, so the form shows both the field errors and the banner saying nothing saved.
 */
const FIELD_ADDRESSABLE_CODES: ReadonlySet<string> = new Set([
	"PBX_INVALID_BODY",
	"PBX_INVALID_DESTINATION",
	"ROUTING_COMPILE_FAILED",
	"PBX_CONFLICT",
]);

function isFieldAddressable(error: unknown): boolean {
	const code = pbxErrorCode(error);
	return code !== undefined && FIELD_ADDRESSABLE_CODES.has(code);
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
