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
	clearVoicemailPin,
	deleteVoicemailMessage,
	listVoicemailMessages,
	mintVoicemailPlaybackUrl,
	setVoicemailMessageRead,
	setVoicemailPin,
	type VoicemailMessageQuery,
} from "~/lib/pbx/client";
import { pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";
import type {
	MutationEnvelope,
	VoicemailMailboxSummary,
	VoicemailMessageDeletion,
	VoicemailMessagePage,
	VoicemailMessageResult,
	VoicemailMessageRow,
	VoicemailPinState,
	VoicemailPlaybackLink,
} from "~/lib/pbx/contracts";

/**
 * Server state for a mailbox's contents, and for its PIN.
 *
 * ## Why this is not in `use-pbx-queries.ts`
 *
 * That file is the generic CRUD machinery: every hook in it is parameterised by a
 * `PbxResourceDescriptor` and every mutation invalidates a resource subtree and, when the resource
 * is a routing input, the compile view. A voicemail MESSAGE is neither — it has no descriptor
 * because it is not one of the eleven CRUD resources, and `affectsRouting("voicemail_message")` is
 * false, so a message move must NOT invalidate the compile view. Bending the generic hooks around
 * that would mean a special case inside the machinery every other resource depends on.
 *
 * ## The PIN, by contrast, DOES affect routing
 *
 * `voicemail_box.pin_hash` is part of the compiled artifact — it is what the engine verifies a
 * `*97` caller's digits against — so setting or clearing a PIN recompiles the tenant, and the
 * compile view has to be invalidated exactly as a mailbox `PATCH` would. That asymmetry between
 * two endpoints on the same resource is the reason both live here, where it can be stated once.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

export interface VoicemailMessagesResult {
	readonly query: UseQueryResult<VoicemailMessagePage>;
	readonly rows: readonly VoicemailMessageRow[];
	readonly total: number;
	readonly totalPages: number;
	readonly mailbox: VoicemailMailboxSummary | undefined;
}

/**
 * One page of a mailbox.
 *
 * `enabled` on the box id, so the drawer costs nothing until it is opened — the list page behind it
 * renders every mailbox, and a query per row would be one request per mailbox on every page load.
 * `placeholderData: previous` keeps the current page on screen while the next one loads, which is
 * what stops the drawer collapsing to a spinner on every "mark read".
 */
export function useVoicemailMessages(
	boxId: string | undefined,
	query: VoicemailMessageQuery,
): VoicemailMessagesResult {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.voicemailMessages(organizationId, boxId ?? "", { ...query }),
		queryFn: () => listVoicemailMessages(boxId as string, query),
		enabled: organizationId.length > 0 && boxId !== undefined,
		placeholderData: (previous) => previous,
	});

	return {
		query: result,
		rows: result.data?.data ?? [],
		total: result.data?.total ?? 0,
		totalPages: result.data?.totalPages ?? 0,
		mailbox: result.data?.mailbox,
	};
}

/**
 * Invalidates one mailbox's message lists — every folder and every page of them.
 *
 * The key prefix stops at the box, deliberately: marking a message read moves it OUT of the `new`
 * folder and INTO `saved`, so the folder the user is looking at and the one they are not are both
 * now wrong. Invalidating only the visible query would leave the trash view stale in exactly the
 * case where a user is switching between them to find something.
 */
function useInvalidateMailbox(): (boxId: string) => Promise<void> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return async (boxId: string) => {
		await queryClient.invalidateQueries({
			queryKey: queryKeys.voicemailMessagesFor(organizationId, boxId),
		});
	};
}

export interface MessageMutationInput {
	readonly boxId: string;
	readonly messageId: string;
}

export function useSetVoicemailMessageRead(): UseMutationResult<
	VoicemailMessageResult,
	Error,
	MessageMutationInput & { readonly read: boolean }
> {
	const invalidate = useInvalidateMailbox();

	return useMutation({
		mutationFn: ({ boxId, messageId, read }: MessageMutationInput & { read: boolean }) =>
			setVoicemailMessageRead(boxId, messageId, read),
		onSuccess: async (_result, variables) => {
			await invalidate(variables.boxId);
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not update the message"));
		},
	});
}

export function useDeleteVoicemailMessage(): UseMutationResult<
	VoicemailMessageDeletion,
	Error,
	MessageMutationInput & { readonly purge?: boolean }
> {
	const invalidate = useInvalidateMailbox();

	return useMutation({
		mutationFn: ({ boxId, messageId, purge }: MessageMutationInput & { purge?: boolean }) =>
			deleteVoicemailMessage(boxId, messageId, purge ?? false),
		onSuccess: async (result, variables) => {
			await invalidate(variables.boxId);
			toast.success(result.data.purged ? "Message permanently deleted" : "Message deleted");
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not delete the message"));
		},
	});
}

/**
 * Mints a playback URL.
 *
 * A mutation rather than a query, and never cached: the URL expires in minutes, so a cached one is
 * a link that works until it silently does not. Every play asks for a fresh one — one request, and
 * a whole class of "it worked ten minutes ago" reports removed. The same rule
 * `useRecordingDownloadUrl` follows, for the same reason.
 */
export function useVoicemailPlaybackUrl(): UseMutationResult<
	VoicemailPlaybackLink,
	Error,
	MessageMutationInput
> {
	return useMutation({
		mutationFn: ({ boxId, messageId }: MessageMutationInput) =>
			mintVoicemailPlaybackUrl(boxId, messageId),
	});
}

/**
 * Sets or clears a mailbox PIN.
 *
 * Invalidates the mailbox resource AND the compile view: `pin_hash` is in the compiled artifact, so
 * this write moved the tenant's `snapshotHash` — see the note at the top of this file.
 */
export function useVoicemailPin(): UseMutationResult<
	MutationEnvelope<VoicemailPinState>,
	Error,
	{ readonly boxId: string; readonly pin: string | null }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: ({ boxId, pin }: { boxId: string; pin: string | null }) =>
			pin === null ? clearVoicemailPin(boxId) : setVoicemailPin(boxId, pin),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.pbxResource(organizationId, "voicemail-boxes"),
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.routingCompile(organizationId),
			});
			toast.success(result.data.pinSet ? "Mailbox PIN set" : "Mailbox PIN cleared");
		},
		/**
		 * No toast on failure: the PIN form renders the message under its own input, where it can be
		 * re-read and acted on. A toast repeating "a PIN is between 4 and 10 digits" and then
		 * vanishing is the worst of both.
		 */
	});
}
