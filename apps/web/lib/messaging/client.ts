import { apiFetch, apiUpload } from "../api-client";
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
	PagedEnvelope,
	TollFreeVerificationRow,
} from "./contracts";

/** The API's ceiling on a page, and what this app asks for by default. */
export const MAX_MESSAGING_LIMIT = 100;
export const DEFAULT_CONVERSATION_LIMIT = 25;
export const DEFAULT_MESSAGE_LIMIT = 50;

/**
 * The query string, with everything the caller did not set OMITTED.
 *
 * The same rule `cdrSearchParams` states, and it is load-bearing twice over here. `archived` is a
 * tri-state on the wire — absent means "either", `false` means the inbox, `true` means the archive
 * — so sending `archived=` would be a parse failure rather than "no filter". And this parameter
 * set IS the React Query cache key, so `search=` and no `search` must be one entry rather than
 * two.
 *
 * `false` is therefore sent, unlike an empty string: it is a value, not an absence.
 */
export function messagingSearchParams(query: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}
		params.set(key, String(value));
	}
	return params.toString();
}

function withQuery(path: string, query: Record<string, unknown>): string {
	const params = messagingSearchParams(query);
	return params.length > 0 ? `${path}?${params}` : path;
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

export async function listMessagingNumbers(): Promise<PagedEnvelope<MessagingNumberRow>> {
	return await apiFetch<PagedEnvelope<MessagingNumberRow>>("/messaging/numbers");
}

/**
 * Turns messaging on for a voice DID.
 *
 * `numberClass` is omitted rather than defaulted when the caller has not chosen: the server infers
 * it from the number's prefix, and guessing "local" for a number starting +1800 here would submit
 * it to the wrong regulator.
 */
export async function enableMessagingNumber(input: {
	readonly phoneNumberId: string;
	readonly numberClass?: NumberClass;
}): Promise<ItemEnvelope<MessagingNumberRow>> {
	return await apiFetch<ItemEnvelope<MessagingNumberRow>>("/messaging/numbers", {
		method: "POST",
		body: JSON.stringify({
			phoneNumberId: input.phoneNumberId,
			...(input.numberClass === undefined ? {} : { numberClass: input.numberClass }),
		}),
	});
}

/**
 * Patches one messaging number.
 *
 * Every key is optional and `campaignId` is the one whose `null` MEANS something — it unassigns —
 * so the three are spread conditionally rather than sent as `undefined`. The body is strict, and
 * `{"campaignId": undefined}` serialises to `{}`, which would be a no-op patch rather than the
 * unassign the caller asked for.
 */
export async function updateMessagingNumber(
	id: string,
	values: {
		readonly enabled?: boolean;
		readonly campaignId?: string | null;
		readonly retentionDays?: number | null;
	},
): Promise<ItemEnvelope<MessagingNumberRow>> {
	const body: Record<string, unknown> = {};
	if (values.enabled !== undefined) {
		body.enabled = values.enabled;
	}
	if (values.campaignId !== undefined) {
		body.campaignId = values.campaignId;
	}
	if (values.retentionDays !== undefined) {
		body.retentionDays = values.retentionDays;
	}
	return await apiFetch<ItemEnvelope<MessagingNumberRow>>(`/messaging/numbers/${id}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}

export async function disableMessagingNumber(id: string): Promise<ItemEnvelope<{ id: string }>> {
	return await apiFetch<ItemEnvelope<{ id: string }>>(`/messaging/numbers/${id}`, {
		method: "DELETE",
	});
}

// ---------------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------------

export interface ConversationListQuery {
	readonly numberId?: string | undefined;
	readonly archived?: boolean | undefined;
	readonly search?: string | undefined;
	readonly page?: number | undefined;
	readonly limit?: number | undefined;
}

export async function listConversations(
	query: ConversationListQuery,
): Promise<PagedEnvelope<ConversationRow>> {
	return await apiFetch<PagedEnvelope<ConversationRow>>(
		withQuery("/messaging/conversations", {
			numberId: query.numberId,
			archived: query.archived,
			search: query.search,
			page: query.page,
			limit: query.limit ?? DEFAULT_CONVERSATION_LIMIT,
		}),
	);
}

export async function getConversation(id: string): Promise<ConversationRow> {
	const { data } = await apiFetch<ItemEnvelope<ConversationRow>>(`/messaging/conversations/${id}`);
	return data;
}

export async function listConversationMessages(
	id: string,
	query: { readonly page?: number; readonly limit?: number } = {},
): Promise<PagedEnvelope<MessageRow>> {
	return await apiFetch<PagedEnvelope<MessageRow>>(
		withQuery(`/messaging/conversations/${id}/messages`, {
			page: query.page,
			limit: query.limit ?? DEFAULT_MESSAGE_LIMIT,
		}),
	);
}

export async function markConversationRead(id: string): Promise<ItemEnvelope<ConversationRow>> {
	return await apiFetch<ItemEnvelope<ConversationRow>>(`/messaging/conversations/${id}/read`, {
		method: "POST",
		body: JSON.stringify({}),
	});
}

export async function updateConversation(
	id: string,
	values: { readonly displayName?: string | null; readonly archived?: boolean },
): Promise<ItemEnvelope<ConversationRow>> {
	const body: Record<string, unknown> = {};
	if (values.displayName !== undefined) {
		body.displayName = values.displayName;
	}
	if (values.archived !== undefined) {
		body.archived = values.archived;
	}
	return await apiFetch<ItemEnvelope<ConversationRow>>(`/messaging/conversations/${id}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

export interface SendMessageInput {
	readonly messagingNumberId: string;
	readonly to: string;
	readonly body?: string;
	readonly mediaKeys?: readonly string[];
}

/**
 * Sends. Answers 202 with the message row, already in `queued`.
 *
 * `body` and `mediaKeys` are both optional on the wire and at least one must be present, which the
 * composer enforces before it gets here — but an EMPTY `mediaKeys` array is still omitted rather
 * than sent, because a strict body reads `[]` as "an MMS with no parts".
 */
export async function sendMessage(input: SendMessageInput): Promise<ItemEnvelope<MessageRow>> {
	const body: Record<string, unknown> = {
		messagingNumberId: input.messagingNumberId,
		to: input.to,
	};
	if (input.body !== undefined && input.body.length > 0) {
		body.body = input.body;
	}
	if (input.mediaKeys !== undefined && input.mediaKeys.length > 0) {
		body.mediaKeys = [...input.mediaKeys];
	}
	return await apiFetch<ItemEnvelope<MessageRow>>("/messaging/messages", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export async function getMessage(id: string): Promise<MessageRow> {
	const { data } = await apiFetch<ItemEnvelope<MessageRow>>(`/messaging/messages/${id}`);
	return data;
}

/** Multipart, field `file` — the one request shape `apiFetch` cannot express. */
export async function uploadMessagingMedia(file: File): Promise<MediaUploadResult> {
	return await apiUpload<MediaUploadResult>("/messaging/media", file);
}

/**
 * A signed URL for one MMS part, minted per view and never cached.
 *
 * The same rule the voicemail playback link follows: the URL expires in minutes, so a cached one
 * is a link that works until it silently does not.
 */
export async function mintMessageMediaUrl(
	messageId: string,
	objectKey: string,
): Promise<MessageMediaLink> {
	return await apiFetch<MessageMediaLink>(`/messaging/messages/${messageId}/media-url`, {
		method: "POST",
		body: JSON.stringify({ objectKey }),
	});
}

// ---------------------------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------------------------

export async function listBrands(): Promise<PagedEnvelope<BrandRow>> {
	return await apiFetch<PagedEnvelope<BrandRow>>("/messaging/brands");
}

export async function createBrand(
	values: Record<string, unknown>,
): Promise<ItemEnvelope<BrandRow>> {
	return await apiFetch<ItemEnvelope<BrandRow>>("/messaging/brands", {
		method: "POST",
		body: JSON.stringify(values),
	});
}

export async function updateBrand(
	id: string,
	values: Record<string, unknown>,
): Promise<ItemEnvelope<BrandRow>> {
	return await apiFetch<ItemEnvelope<BrandRow>>(`/messaging/brands/${id}`, {
		method: "PATCH",
		body: JSON.stringify(values),
	});
}

export async function sendBrandOtp(id: string): Promise<ItemEnvelope<BrandRow>> {
	return await apiFetch<ItemEnvelope<BrandRow>>(`/messaging/brands/${id}/otp`, {
		method: "POST",
		body: JSON.stringify({}),
	});
}

export async function verifyBrandOtp(id: string, pin: string): Promise<ItemEnvelope<BrandRow>> {
	return await apiFetch<ItemEnvelope<BrandRow>>(`/messaging/brands/${id}/otp/verify`, {
		method: "POST",
		body: JSON.stringify({ pin }),
	});
}

// ---------------------------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------------------------

export async function listCampaigns(): Promise<PagedEnvelope<CampaignRow>> {
	return await apiFetch<PagedEnvelope<CampaignRow>>("/messaging/campaigns");
}

export async function createCampaign(
	values: Record<string, unknown>,
): Promise<ItemEnvelope<CampaignRow>> {
	return await apiFetch<ItemEnvelope<CampaignRow>>("/messaging/campaigns", {
		method: "POST",
		body: JSON.stringify(values),
	});
}

export async function updateCampaign(
	id: string,
	values: Record<string, unknown>,
): Promise<ItemEnvelope<CampaignRow>> {
	return await apiFetch<ItemEnvelope<CampaignRow>>(`/messaging/campaigns/${id}`, {
		method: "PATCH",
		body: JSON.stringify(values),
	});
}

export async function assignCampaignNumber(
	campaignId: string,
	messagingNumberId: string,
): Promise<ItemEnvelope<CampaignRow>> {
	return await apiFetch<ItemEnvelope<CampaignRow>>(`/messaging/campaigns/${campaignId}/numbers`, {
		method: "POST",
		body: JSON.stringify({ messagingNumberId }),
	});
}

export async function unassignCampaignNumber(
	campaignId: string,
	messagingNumberId: string,
): Promise<ItemEnvelope<CampaignRow>> {
	return await apiFetch<ItemEnvelope<CampaignRow>>(
		`/messaging/campaigns/${campaignId}/numbers/${messagingNumberId}`,
		{ method: "DELETE" },
	);
}

// ---------------------------------------------------------------------------------------------
// Toll-free verification
// ---------------------------------------------------------------------------------------------

export async function listTollFreeVerifications(): Promise<PagedEnvelope<TollFreeVerificationRow>> {
	return await apiFetch<PagedEnvelope<TollFreeVerificationRow>>(
		"/messaging/toll-free-verifications",
	);
}

export async function createTollFreeVerification(
	values: Record<string, unknown>,
): Promise<ItemEnvelope<TollFreeVerificationRow>> {
	return await apiFetch<ItemEnvelope<TollFreeVerificationRow>>(
		"/messaging/toll-free-verifications",
		{ method: "POST", body: JSON.stringify(values) },
	);
}

// ---------------------------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------------------------

export async function listOptOuts(numberId: string | undefined): Promise<PagedEnvelope<OptOutRow>> {
	return await apiFetch<PagedEnvelope<OptOutRow>>(withQuery("/messaging/opt-outs", { numberId }));
}

export async function createOptOut(input: {
	readonly messagingNumberId: string;
	readonly remoteE164: string;
}): Promise<ItemEnvelope<OptOutRow>> {
	return await apiFetch<ItemEnvelope<OptOutRow>>("/messaging/opt-outs", {
		method: "POST",
		body: JSON.stringify({
			messagingNumberId: input.messagingNumberId,
			remoteE164: input.remoteE164,
		}),
	});
}

export async function deleteOptOut(id: string): Promise<ItemEnvelope<{ id: string }>> {
	return await apiFetch<ItemEnvelope<{ id: string }>>(`/messaging/opt-outs/${id}`, {
		method: "DELETE",
	});
}
