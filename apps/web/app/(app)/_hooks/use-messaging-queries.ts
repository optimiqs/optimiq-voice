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
	assignCampaignNumber,
	createBrand,
	createCampaign,
	createOptOut,
	createTollFreeVerification,
	deleteOptOut,
	disableMessagingNumber,
	enableMessagingNumber,
	getConversation,
	listBrands,
	listCampaigns,
	listConversationMessages,
	listConversations,
	listMessagingNumbers,
	listOptOuts,
	listTollFreeVerifications,
	markConversationRead,
	mintMessageMediaUrl,
	sendBrandOtp,
	sendMessage,
	unassignCampaignNumber,
	updateBrand,
	updateCampaign,
	updateConversation,
	updateMessagingNumber,
	uploadMessagingMedia,
	verifyBrandOtp,
	type ConversationListQuery,
	type SendMessageInput,
} from "~/lib/messaging/client";
import { messagingToastMessage } from "~/lib/messaging/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";
import type {
	BrandRow,
	CampaignRow,
	ConversationRow,
	ItemEnvelope,
	MediaUploadResult,
	MessageMediaLink,
	MessageRow,
	MessagingNumberRow,
	NumberClass,
	OptOutRow,
	TollFreeVerificationRow,
} from "~/lib/messaging/contracts";

/**
 * Server state for the messaging area.
 *
 * ## Why this is not in `use-pbx-queries.ts`
 *
 * That file is parameterised by a `PbxResourceDescriptor`, and every mutation in it invalidates a
 * resource subtree and — when the resource is a routing input — the compile view. Not one messaging
 * write is a routing input: registering a number, creating a campaign and sending a text all leave
 * the compiled dial plan untouched, so routing must NOT be invalidated by any of them. Bending the
 * generic machinery around that would put a special case inside the hooks every other resource
 * depends on.
 *
 * ## The one place a toast is wrong
 *
 * `useSendMessage` reports nothing on failure. The three refusals that matter — unregistered
 * number, opted-out recipient, quiet hours — are rendered IN the composer, verbatim, where they can
 * be re-read; a corner overlay that repeats "quiet hours until 08:00" and then vanishes is the
 * worst possible home for the only sentence that explains why a message did not go. The composer
 * owns that error; this hook just hands it over.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

export interface MessagingNumbersResult {
	readonly query: UseQueryResult<{ readonly data: readonly MessagingNumberRow[] }>;
	readonly rows: readonly MessagingNumberRow[];
}

export function useMessagingNumbers(): MessagingNumbersResult {
	const organizationId = useOrganizationId();
	const query = useQuery({
		queryKey: queryKeys.messagingNumbers(organizationId),
		queryFn: listMessagingNumbers,
		enabled: organizationId.length > 0,
	});

	return { query, rows: query.data?.data ?? [] };
}

/**
 * Invalidates the whole messaging subtree.
 *
 * Coarse on purpose. Registering a number, assigning it to a campaign or turning it off changes
 * what the COMPOSER may do on every thread hanging off that number, and the composer's answer is
 * derived from rows in three different lists. Invalidating only the numbers list would leave an
 * inbox offering to send on a number that was disabled a second ago.
 */
function useInvalidateMessaging(): () => Promise<void> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return async () => {
		await queryClient.invalidateQueries({ queryKey: queryKeys.messaging(organizationId) });
	};
}

export function useEnableMessagingNumber(): UseMutationResult<
	ItemEnvelope<MessagingNumberRow>,
	Error,
	{ readonly phoneNumberId: string; readonly numberClass?: NumberClass }
> {
	const invalidate = useInvalidateMessaging();

	return useMutation({
		mutationFn: enableMessagingNumber,
		onSuccess: async (result) => {
			await invalidate();
			toast.success(`Messaging enabled on ${result.data.e164}`);
		},
		onError: (error) => {
			toast.error(messagingToastMessage(error, "Could not enable messaging on that number"));
		},
	});
}

export function useUpdateMessagingNumber(): UseMutationResult<
	ItemEnvelope<MessagingNumberRow>,
	Error,
	{
		readonly id: string;
		readonly values: {
			readonly enabled?: boolean;
			readonly campaignId?: string | null;
			readonly retentionDays?: number | null;
		};
	}
> {
	const invalidate = useInvalidateMessaging();

	return useMutation({
		mutationFn: ({
			id,
			values,
		}: {
			id: string;
			values: {
				enabled?: boolean;
				campaignId?: string | null;
				retentionDays?: number | null;
			};
		}) => updateMessagingNumber(id, values),
		onSuccess: async () => {
			await invalidate();
			toast.success("Number updated");
		},
		onError: (error) => {
			toast.error(messagingToastMessage(error, "Could not update that number"));
		},
	});
}

export function useDisableMessagingNumber(): UseMutationResult<
	ItemEnvelope<{ readonly id: string }>,
	Error,
	string
> {
	const invalidate = useInvalidateMessaging();

	return useMutation({
		mutationFn: (id: string) => disableMessagingNumber(id),
		onSuccess: async () => {
			await invalidate();
			toast.success("Messaging disabled on that number");
		},
		onError: (error) => {
			toast.error(messagingToastMessage(error, "Could not disable messaging"));
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------------

export interface ConversationsResult {
	readonly query: UseQueryResult<{
		readonly data: readonly ConversationRow[];
		readonly total: number;
		readonly totalPages: number;
	}>;
	readonly rows: readonly ConversationRow[];
	readonly total: number;
	readonly totalPages: number;
}

/**
 * One page of threads.
 *
 * `placeholderData: previous` keeps the list on screen while the next page loads — the same rule
 * the voicemail drawer follows, and it matters more here: the conversation list is the navigation,
 * so collapsing it to a spinner on every search keystroke would take the user's place away from
 * them mid-typing.
 */
export function useConversations(query: ConversationListQuery): ConversationsResult {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.messagingConversationList(organizationId, {
			numberId: query.numberId ?? null,
			archived: query.archived ?? null,
			search: query.search ?? null,
			page: query.page ?? 1,
			limit: query.limit ?? null,
		}),
		queryFn: () => listConversations(query),
		enabled: organizationId.length > 0,
		placeholderData: (previous) => previous,
	});

	return {
		query: result,
		rows: result.data?.data ?? [],
		total: result.data?.total ?? 0,
		totalPages: result.data?.totalPages ?? 0,
	};
}

export function useConversation(id: string | undefined): UseQueryResult<ConversationRow> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.messagingConversation(organizationId, id ?? ""),
		queryFn: () => getConversation(id as string),
		enabled: organizationId.length > 0 && id !== undefined,
	});
}

export interface ConversationMessagesResult {
	readonly query: UseQueryResult<{
		readonly data: readonly MessageRow[];
		readonly total: number;
		readonly totalPages: number;
	}>;
	readonly rows: readonly MessageRow[];
	readonly total: number;
	readonly totalPages: number;
}

/**
 * One page of a thread.
 *
 * A thread with a message in flight refetches on an interval, and only then: a `queued` or
 * `sending` row is a promise the platform has not kept yet, and the delivery receipt that resolves
 * it arrives from a carrier rather than from anything this browser did. Polling a settled thread
 * would be a request per open tab per few seconds for an answer that cannot change.
 */
export function useConversationMessages(
	conversationId: string | undefined,
	query: { readonly page?: number; readonly limit?: number } = {},
): ConversationMessagesResult {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.messagingMessages(organizationId, conversationId ?? "", {
			page: query.page ?? 1,
			limit: query.limit ?? null,
		}),
		queryFn: () => listConversationMessages(conversationId as string, query),
		enabled: organizationId.length > 0 && conversationId !== undefined,
		placeholderData: (previous) => previous,
		refetchInterval: (result_) =>
			(result_.state.data?.data ?? []).some(
				(message) => message.status === "queued" || message.status === "sending",
			)
				? 5_000
				: false,
	});

	return {
		query: result,
		rows: result.data?.data ?? [],
		total: result.data?.total ?? 0,
		totalPages: result.data?.totalPages ?? 0,
	};
}

function useInvalidateConversations(): () => Promise<void> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return async () => {
		await queryClient.invalidateQueries({
			queryKey: queryKeys.messagingConversations(organizationId),
		});
	};
}

/**
 * Marks a thread read.
 *
 * Silent on failure. This fires when a thread is OPENED, so it is not something the user asked for
 * — a toast saying "could not mark read" would be an error about an action they did not take, and
 * the unread badge staying put is already the honest answer.
 */
export function useMarkConversationRead(): UseMutationResult<
	ItemEnvelope<ConversationRow>,
	Error,
	string
> {
	const invalidate = useInvalidateConversations();

	return useMutation({
		mutationFn: (id: string) => markConversationRead(id),
		onSuccess: async () => {
			await invalidate();
		},
	});
}

export function useUpdateConversation(): UseMutationResult<
	ItemEnvelope<ConversationRow>,
	Error,
	{
		readonly id: string;
		readonly values: { readonly displayName?: string | null; readonly archived?: boolean };
	}
> {
	const invalidate = useInvalidateConversations();

	return useMutation({
		mutationFn: ({
			id,
			values,
		}: {
			id: string;
			values: { displayName?: string | null; archived?: boolean };
		}) => updateConversation(id, values),
		onSuccess: async (_result, variables) => {
			await invalidate();
			if (variables.values.archived !== undefined) {
				toast.success(
					variables.values.archived ? "Conversation archived" : "Conversation restored",
				);
			}
		},
		onError: (error) => {
			toast.error(messagingToastMessage(error, "Could not update the conversation"));
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

/**
 * Sends, and says nothing about a failure.
 *
 * See the note at the top of this file: the three policy refusals belong in the composer, verbatim
 * and re-readable, and every other failure is reported there too so that one control is the whole
 * story of one send.
 */
export function useSendMessage(): UseMutationResult<
	ItemEnvelope<MessageRow>,
	Error,
	SendMessageInput
> {
	const invalidate = useInvalidateConversations();

	return useMutation({
		mutationFn: sendMessage,
		onSuccess: async () => {
			await invalidate();
		},
	});
}

/** Uploads one attachment and answers with the object key the send will name. */
export function useUploadMessagingMedia(): UseMutationResult<MediaUploadResult, Error, File> {
	return useMutation({
		mutationFn: (file: File) => uploadMessagingMedia(file),
		onError: (error) => {
			toast.error(messagingToastMessage(error, "Could not upload that attachment"));
		},
	});
}

/**
 * Mints a signed URL for one MMS part.
 *
 * A mutation rather than a query, and never cached: the URL expires in minutes, so a cached one is
 * a link that works until it silently does not. The same rule `useVoicemailPlaybackUrl` follows.
 */
export function useMessageMediaUrl(): UseMutationResult<
	MessageMediaLink,
	Error,
	{ readonly messageId: string; readonly objectKey: string }
> {
	return useMutation({
		mutationFn: ({ messageId, objectKey }: { messageId: string; objectKey: string }) =>
			mintMessageMediaUrl(messageId, objectKey),
	});
}

// ---------------------------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------------------------

export function useBrands(): {
	readonly query: UseQueryResult<{ readonly data: readonly BrandRow[] }>;
	readonly brand: BrandRow | undefined;
} {
	const organizationId = useOrganizationId();
	const query = useQuery({
		queryKey: queryKeys.messagingBrands(organizationId),
		queryFn: listBrands,
		enabled: organizationId.length > 0,
	});

	/**
	 * One brand per organization in practice — the registry ties a brand to a legal entity and this
	 * platform's tenant IS that entity — so the form edits the first row and creates one when there
	 * is none. The endpoint is a collection because the registry's model is, not because a tenant
	 * is expected to hold several.
	 */
	return { query, brand: query.data?.data[0] };
}

export function useSaveBrand(): UseMutationResult<
	ItemEnvelope<BrandRow>,
	Error,
	{ readonly id: string | undefined; readonly values: Record<string, unknown> }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: ({ id, values }: { id: string | undefined; values: Record<string, unknown> }) =>
			id === undefined ? createBrand(values) : updateBrand(id, values),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.messaging(organizationId) });
			toast.success("Brand submitted");
		},
		/**
		 * No toast on failure: a rejected brand is a validation failure with a field named, and the
		 * form renders it under the control that caused it.
		 */
	});
}

export function useSendBrandOtp(): UseMutationResult<ItemEnvelope<BrandRow>, Error, string> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: (id: string) => sendBrandOtp(id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.messagingBrands(organizationId) });
			toast.success("PIN sent by text message");
		},
		onError: (error) => {
			toast.error(messagingToastMessage(error, "Could not send the PIN"));
		},
	});
}

export function useVerifyBrandOtp(): UseMutationResult<
	ItemEnvelope<BrandRow>,
	Error,
	{ readonly id: string; readonly pin: string }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: ({ id, pin }: { id: string; pin: string }) => verifyBrandOtp(id, pin),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.messaging(organizationId) });
			toast.success("PIN verified");
		},
		/** No toast: a wrong PIN belongs under the PIN field, which is where it is rendered. */
	});
}

// ---------------------------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------------------------

export function useCampaigns(): {
	readonly query: UseQueryResult<{ readonly data: readonly CampaignRow[] }>;
	readonly rows: readonly CampaignRow[];
} {
	const organizationId = useOrganizationId();
	const query = useQuery({
		queryKey: queryKeys.messagingCampaigns(organizationId),
		queryFn: listCampaigns,
		enabled: organizationId.length > 0,
	});

	return { query, rows: query.data?.data ?? [] };
}

export function useCreateCampaign(): UseMutationResult<
	ItemEnvelope<CampaignRow>,
	Error,
	Record<string, unknown>
> {
	const invalidate = useInvalidateMessaging();

	return useMutation({
		mutationFn: createCampaign,
		onSuccess: async () => {
			await invalidate();
			toast.success("Campaign submitted");
		},
	});
}

export function useUpdateCampaign(): UseMutationResult<
	ItemEnvelope<CampaignRow>,
	Error,
	{ readonly id: string; readonly values: Record<string, unknown> }
> {
	const invalidate = useInvalidateMessaging();

	return useMutation({
		mutationFn: ({ id, values }: { id: string; values: Record<string, unknown> }) =>
			updateCampaign(id, values),
		onSuccess: async () => {
			await invalidate();
			toast.success("Campaign updated");
		},
	});
}

export function useAssignCampaignNumber(): UseMutationResult<
	ItemEnvelope<CampaignRow>,
	Error,
	{ readonly campaignId: string; readonly messagingNumberId: string; readonly assigned: boolean }
> {
	const invalidate = useInvalidateMessaging();

	return useMutation({
		mutationFn: ({
			campaignId,
			messagingNumberId,
			assigned,
		}: {
			campaignId: string;
			messagingNumberId: string;
			assigned: boolean;
		}) =>
			assigned
				? assignCampaignNumber(campaignId, messagingNumberId)
				: unassignCampaignNumber(campaignId, messagingNumberId),
		onSuccess: async (_result, variables) => {
			await invalidate();
			toast.success(
				variables.assigned ? "Number assigned to the campaign" : "Number removed from the campaign",
			);
		},
		onError: (error) => {
			toast.error(messagingToastMessage(error, "Could not change the campaign's numbers"));
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Toll-free verification
// ---------------------------------------------------------------------------------------------

export function useTollFreeVerifications(): {
	readonly query: UseQueryResult<{ readonly data: readonly TollFreeVerificationRow[] }>;
	readonly rows: readonly TollFreeVerificationRow[];
} {
	const organizationId = useOrganizationId();
	const query = useQuery({
		queryKey: queryKeys.messagingTollFree(organizationId),
		queryFn: listTollFreeVerifications,
		enabled: organizationId.length > 0,
	});

	return { query, rows: query.data?.data ?? [] };
}

export function useSubmitTollFreeVerification(): UseMutationResult<
	ItemEnvelope<TollFreeVerificationRow>,
	Error,
	Record<string, unknown>
> {
	const invalidate = useInvalidateMessaging();

	return useMutation({
		mutationFn: createTollFreeVerification,
		onSuccess: async () => {
			await invalidate();
			toast.success("Verification submitted");
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------------------------

export function useOptOuts(numberId: string | undefined): {
	readonly query: UseQueryResult<{ readonly data: readonly OptOutRow[] }>;
	readonly rows: readonly OptOutRow[];
} {
	const organizationId = useOrganizationId();
	const query = useQuery({
		queryKey: queryKeys.messagingOptOuts(organizationId, numberId ?? null),
		queryFn: () => listOptOuts(numberId),
		enabled: organizationId.length > 0,
	});

	return { query, rows: query.data?.data ?? [] };
}

function useInvalidateOptOuts(): () => Promise<void> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	/**
	 * The whole messaging subtree, not just the suppression list. A recipient's consent is exactly
	 * what decides whether the composer opens on their thread, so adding or removing an opt-out has
	 * to reach the conversation the operator may be looking at right now.
	 */
	return async () => {
		await queryClient.invalidateQueries({ queryKey: queryKeys.messaging(organizationId) });
	};
}

export function useCreateOptOut(): UseMutationResult<
	ItemEnvelope<OptOutRow>,
	Error,
	{ readonly messagingNumberId: string; readonly remoteE164: string }
> {
	const invalidate = useInvalidateOptOuts();

	return useMutation({
		mutationFn: createOptOut,
		onSuccess: async (result) => {
			await invalidate();
			toast.success(`${result.data.remoteE164} will no longer receive messages`);
		},
	});
}

export function useDeleteOptOut(): UseMutationResult<
	ItemEnvelope<{ readonly id: string }>,
	Error,
	string
> {
	const invalidate = useInvalidateOptOuts();

	return useMutation({
		mutationFn: (id: string) => deleteOptOut(id),
		onSuccess: async () => {
			await invalidate();
			toast.success("Consent to resume messaging recorded");
		},
		onError: (error) => {
			toast.error(messagingToastMessage(error, "Could not remove that opt-out"));
		},
	});
}
