import {
	and,
	conversation,
	desc,
	eq,
	ilike,
	message,
	messagingBrand,
	messagingCampaign,
	messagingNumber,
	messagingOptOut,
	messagingTollFreeVerification,
	or,
	phoneNumber,
	sql,
} from "@optimiq-voice/pbx-db";
import type { Pagination } from "../pbx/shared/pagination";
import type {
	ConversationListQuery,
	MessagingNumberListQuery,
	OptOutListQuery,
} from "./messaging.dto";
import type {
	MessageStatus,
	MessagingRegistrationStatus,
	PbxDatabaseTransaction,
	SQL,
} from "@optimiq-voice/pbx-db";

/**
 * Data access for messaging.
 *
 * Free functions taking a transaction, like `fax.repository.ts` and `cdr-exports.repository.ts`: the
 * tenant is established by `withTenantScope` before any of these run and none of them takes an
 * organization id, so RLS is the only filter and there is no place for a query to be wrong about a
 * tenant.
 *
 * The exceptions are the four functions whose names end in `Admin`. They run on the untenanted
 * connection because the question they answer is not a tenant's — "whose number is this E.164", and
 * "which message anywhere still owes a send". Each says so, and each one's result is used only to
 * ENTER a tenant scope, never to read tenant data outside one.
 */

const NUMBER_COLUMNS = {
	id: messagingNumber.id,
	phoneNumberId: messagingNumber.phoneNumberId,
	e164: messagingNumber.e164,
	numberClass: messagingNumber.numberClass,
	carrierMessagingProfileId: messagingNumber.carrierMessagingProfileId,
	campaignId: messagingNumber.campaignId,
	registrationStatus: messagingNumber.registrationStatus,
	registrationReason: messagingNumber.registrationReason,
	enabled: messagingNumber.enabled,
	retentionDays: messagingNumber.retentionDays,
	createdAt: messagingNumber.createdAt,
	updatedAt: messagingNumber.updatedAt,
} as const;

const CONVERSATION_COLUMNS = {
	id: conversation.id,
	messagingNumberId: conversation.messagingNumberId,
	remoteE164: conversation.remoteE164,
	displayName: conversation.displayName,
	lastMessageAt: conversation.lastMessageAt,
	lastMessagePreview: conversation.lastMessagePreview,
	lastMessageDirection: conversation.lastMessageDirection,
	unreadCount: conversation.unreadCount,
	archived: conversation.archived,
	createdAt: conversation.createdAt,
	updatedAt: conversation.updatedAt,
} as const;

const MESSAGE_COLUMNS = {
	id: message.id,
	conversationId: message.conversationId,
	messagingNumberId: message.messagingNumberId,
	direction: message.direction,
	status: message.status,
	kind: message.kind,
	fromE164: message.fromE164,
	toE164: message.toE164,
	body: message.body,
	mediaKeys: message.mediaKeys,
	carrierMessageId: message.carrierMessageId,
	segments: message.segments,
	errorReason: message.errorReason,
	sentByUserId: message.sentByUserId,
	complianceKeyword: message.complianceKeyword,
	attempts: message.attempts,
	completedAt: message.completedAt,
	createdAt: message.createdAt,
	updatedAt: message.updatedAt,
} as const;

const OPT_OUT_COLUMNS = {
	id: messagingOptOut.id,
	messagingNumberId: messagingOptOut.messagingNumberId,
	remoteE164: messagingOptOut.remoteE164,
	source: messagingOptOut.source,
	keyword: messagingOptOut.keyword,
	recordedByUserId: messagingOptOut.recordedByUserId,
	optedOutAt: messagingOptOut.optedOutAt,
	createdAt: messagingOptOut.createdAt,
} as const;

const BRAND_COLUMNS = {
	id: messagingBrand.id,
	carrierBrandId: messagingBrand.carrierBrandId,
	displayName: messagingBrand.displayName,
	companyName: messagingBrand.companyName,
	entityType: messagingBrand.entityType,
	vertical: messagingBrand.vertical,
	email: messagingBrand.email,
	phone: messagingBrand.phone,
	website: messagingBrand.website,
	street: messagingBrand.street,
	city: messagingBrand.city,
	state: messagingBrand.state,
	postalCode: messagingBrand.postalCode,
	country: messagingBrand.country,
	status: messagingBrand.status,
	statusReason: messagingBrand.statusReason,
	otpReference: messagingBrand.otpReference,
	lastPolledAt: messagingBrand.lastPolledAt,
	createdAt: messagingBrand.createdAt,
	updatedAt: messagingBrand.updatedAt,
} as const;

const CAMPAIGN_COLUMNS = {
	id: messagingCampaign.id,
	brandId: messagingCampaign.brandId,
	carrierCampaignId: messagingCampaign.carrierCampaignId,
	name: messagingCampaign.name,
	useCase: messagingCampaign.useCase,
	description: messagingCampaign.description,
	sampleMessages: messagingCampaign.sampleMessages,
	messageFlow: messagingCampaign.messageFlow,
	helpMessage: messagingCampaign.helpMessage,
	optOutMessage: messagingCampaign.optOutMessage,
	optInKeywords: messagingCampaign.optInKeywords,
	optOutKeywords: messagingCampaign.optOutKeywords,
	helpKeywords: messagingCampaign.helpKeywords,
	embeddedLink: messagingCampaign.embeddedLink,
	ageGated: messagingCampaign.ageGated,
	quietHoursStartMinute: messagingCampaign.quietHoursStartMinute,
	quietHoursEndMinute: messagingCampaign.quietHoursEndMinute,
	quietHoursTimeZone: messagingCampaign.quietHoursTimeZone,
	status: messagingCampaign.status,
	statusReason: messagingCampaign.statusReason,
	throughputPerSecond: messagingCampaign.throughputPerSecond,
	lastPolledAt: messagingCampaign.lastPolledAt,
	createdAt: messagingCampaign.createdAt,
	updatedAt: messagingCampaign.updatedAt,
} as const;

const TFV_COLUMNS = {
	id: messagingTollFreeVerification.id,
	messagingNumberId: messagingTollFreeVerification.messagingNumberId,
	carrierVerificationId: messagingTollFreeVerification.carrierVerificationId,
	businessName: messagingTollFreeVerification.businessName,
	corporateWebsite: messagingTollFreeVerification.corporateWebsite,
	businessRegistrationNumber: messagingTollFreeVerification.businessRegistrationNumber,
	businessRegistrationType: messagingTollFreeVerification.businessRegistrationType,
	businessRegistrationCountry: messagingTollFreeVerification.businessRegistrationCountry,
	useCase: messagingTollFreeVerification.useCase,
	useCaseSummary: messagingTollFreeVerification.useCaseSummary,
	privacyPolicyUrl: messagingTollFreeVerification.privacyPolicyUrl,
	termsAndConditionsUrl: messagingTollFreeVerification.termsAndConditionsUrl,
	status: messagingTollFreeVerification.status,
	statusReason: messagingTollFreeVerification.statusReason,
	lastPolledAt: messagingTollFreeVerification.lastPolledAt,
	createdAt: messagingTollFreeVerification.createdAt,
	updatedAt: messagingTollFreeVerification.updatedAt,
} as const;

type RowOf<TColumns extends Record<string, { _: { notNull: boolean; data: unknown } }>> = {
	[K in keyof TColumns]: TColumns[K]["_"]["notNull"] extends true
		? TColumns[K]["_"]["data"]
		: TColumns[K]["_"]["data"] | null;
};

export type MessagingNumberRow = RowOf<typeof NUMBER_COLUMNS>;
export type ConversationRow = RowOf<typeof CONVERSATION_COLUMNS>;
export type MessageRow = RowOf<typeof MESSAGE_COLUMNS>;
export type OptOutRow = RowOf<typeof OPT_OUT_COLUMNS>;
export type BrandRow = RowOf<typeof BRAND_COLUMNS>;
export type CampaignRow = RowOf<typeof CAMPAIGN_COLUMNS>;
export type TollFreeVerificationRow = RowOf<typeof TFV_COLUMNS>;

// --------------------------------------------------------------------------------------------
// Messaging numbers
// --------------------------------------------------------------------------------------------

export async function listMessagingNumbers(
	transaction: PbxDatabaseTransaction,
	query: MessagingNumberListQuery,
	pagination: Pagination,
): Promise<{ readonly rows: readonly MessagingNumberRow[]; readonly total: number }> {
	const filters: SQL[] = [];
	if (query.search !== undefined) {
		filters.push(ilike(messagingNumber.e164, `%${query.search}%`) as SQL);
	}
	if (query.enabled !== undefined) {
		filters.push(eq(messagingNumber.enabled, query.enabled) as SQL);
	}
	// `count(*) over ()` on the same query, per the area's pagination contract: one round trip, and a
	// count that cannot disagree with the page about which snapshot it describes.
	const rows = await transaction
		.select({ ...NUMBER_COLUMNS, total: sql<string>`count(*) over ()` })
		.from(messagingNumber)
		.where(filters.length === 0 ? undefined : and(...filters))
		.orderBy(desc(messagingNumber.createdAt), desc(messagingNumber.id))
		.limit(pagination.limit)
		.offset(pagination.offset);
	return {
		rows: rows.map(({ total: _total, ...row }) => row),
		total: Number(rows[0]?.total ?? 0),
	};
}

export async function getMessagingNumber(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<MessagingNumberRow | undefined> {
	const rows = await transaction
		.select(NUMBER_COLUMNS)
		.from(messagingNumber)
		.where(eq(messagingNumber.id, id))
		.limit(1);
	return rows[0];
}

/** The DID row behind a messaging number, for the carrier-side profile attachment. */
export async function getPhoneNumberForMessaging(
	transaction: PbxDatabaseTransaction,
	phoneNumberId: string,
): Promise<
	{ readonly id: string; readonly e164: string; readonly carrierRef: string | null } | undefined
> {
	const rows = await transaction
		.select({
			id: phoneNumber.id,
			e164: phoneNumber.e164,
			carrierRef: phoneNumber.carrierRef,
		})
		.from(phoneNumber)
		.where(eq(phoneNumber.id, phoneNumberId))
		.limit(1);
	return rows[0];
}

export interface NewMessagingNumber {
	readonly organizationId: string;
	readonly phoneNumberId: string;
	readonly e164: string;
	readonly numberClass: "local" | "toll-free" | "short-code";
	readonly carrierMessagingProfileId: string | null;
	readonly registrationReason: string;
	readonly retentionDays: number | null;
}

export async function insertMessagingNumber(
	transaction: PbxDatabaseTransaction,
	values: NewMessagingNumber,
): Promise<MessagingNumberRow> {
	const rows = await transaction
		.insert(messagingNumber)
		.values({
			organizationId: values.organizationId,
			phoneNumberId: values.phoneNumberId,
			e164: values.e164,
			numberClass: values.numberClass,
			carrierMessagingProfileId: values.carrierMessagingProfileId,
			registrationStatus: "unregistered",
			registrationReason: values.registrationReason,
			retentionDays: values.retentionDays,
		})
		.returning(NUMBER_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the messaging number insert returned no row");
	}
	return row;
}

export async function updateMessagingNumber(
	transaction: PbxDatabaseTransaction,
	id: string,
	values: {
		readonly enabled?: boolean;
		readonly campaignId?: string | null;
		readonly retentionDays?: number | null;
		readonly registrationStatus?: MessagingRegistrationStatus;
		readonly registrationReason?: string | null;
		readonly carrierMessagingProfileId?: string | null;
	},
): Promise<MessagingNumberRow | undefined> {
	const rows = await transaction
		.update(messagingNumber)
		.set({ ...values, updatedAt: new Date() })
		.where(eq(messagingNumber.id, id))
		.returning(NUMBER_COLUMNS);
	return rows[0];
}

export async function deleteMessagingNumber(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<boolean> {
	const rows = await transaction
		.delete(messagingNumber)
		.where(eq(messagingNumber.id, id))
		.returning({ id: messagingNumber.id });
	return rows.length > 0;
}

/**
 * The messaging number a DID's E.164 belongs to, across every tenant.
 *
 * UNTENANTED, and the only honest way to answer an inbound webhook: it arrives with a `to` and
 * nothing else, so the DID is what tells us whose message this is. Safe because
 * `messaging_number_e164_global_key` guarantees exactly one row per E.164 platform-wide, which in
 * turn inherits `phone_number`'s own global uniqueness. The result is used only to ENTER that
 * tenant's scope.
 */
export async function findMessagingNumberByE164Admin(
	executor: { execute(query: SQL): Promise<unknown> },
	e164: string,
): Promise<
	| {
			readonly id: string;
			readonly organizationId: string;
			readonly campaignId: string | null;
			readonly enabled: boolean;
	  }
	| undefined
> {
	const query = sql`
		select ${messagingNumber.id} as id,
		       ${messagingNumber.organizationId} as organization_id,
		       ${messagingNumber.campaignId} as campaign_id,
		       ${messagingNumber.enabled} as enabled
		from ${messagingNumber}
		where ${messagingNumber.e164} = ${e164}
		limit 1
	`;
	const row = rowsOf<{
		readonly id: string;
		readonly organization_id: string;
		readonly campaign_id: string | null;
		readonly enabled: boolean;
	}>(await executor.execute(query))[0];
	if (row === undefined) {
		return undefined;
	}
	return {
		id: row.id,
		organizationId: row.organization_id,
		campaignId: row.campaign_id,
		enabled: row.enabled,
	};
}

/** The tenant a message row belongs to, for a delivery receipt that correlated on the client state. */
export async function findMessageOrgByIdAdmin(
	executor: { execute(query: SQL): Promise<unknown> },
	messageId: string,
): Promise<{ readonly id: string; readonly organizationId: string } | undefined> {
	const query = sql`
		select ${message.id} as id, ${message.organizationId} as organization_id
		from ${message}
		where ${message.id} = ${messageId}::uuid
		limit 1
	`;
	const row = rowsOf<{ readonly id: string; readonly organization_id: string }>(
		await executor.execute(query),
	)[0];
	return row === undefined ? undefined : { id: row.id, organizationId: row.organization_id };
}

/** The same, correlating on the carrier's id — the fallback when a receipt lost the client state. */
export async function findMessageOrgByCarrierIdAdmin(
	executor: { execute(query: SQL): Promise<unknown> },
	carrierMessageId: string,
): Promise<{ readonly id: string; readonly organizationId: string } | undefined> {
	const query = sql`
		select ${message.id} as id, ${message.organizationId} as organization_id
		from ${message}
		where ${message.carrierMessageId} = ${carrierMessageId}
		limit 1
	`;
	const row = rowsOf<{ readonly id: string; readonly organization_id: string }>(
		await executor.execute(query),
	)[0];
	return row === undefined ? undefined : { id: row.id, organizationId: row.organization_id };
}

// --------------------------------------------------------------------------------------------
// Conversations
// --------------------------------------------------------------------------------------------

export async function listConversations(
	transaction: PbxDatabaseTransaction,
	query: ConversationListQuery,
	pagination: Pagination,
): Promise<{ readonly rows: readonly ConversationRow[]; readonly total: number }> {
	const filters: SQL[] = [];
	if (query.numberId !== undefined) {
		filters.push(eq(conversation.messagingNumberId, query.numberId) as SQL);
	}
	// Absent means "the open inbox": archived threads are excluded unless asked for, because an
	// archive that reappears in the list is an archive that does nothing.
	filters.push(eq(conversation.archived, query.archived ?? false) as SQL);
	if (query.search !== undefined) {
		filters.push(
			or(
				ilike(conversation.remoteE164, `%${query.search}%`),
				ilike(conversation.displayName, `%${query.search}%`),
				ilike(conversation.lastMessagePreview, `%${query.search}%`),
			) as SQL,
		);
	}
	const rows = await transaction
		.select({ ...CONVERSATION_COLUMNS, total: sql<string>`count(*) over ()` })
		.from(conversation)
		.where(and(...filters))
		// Newest activity first. `createdAt` breaks the tie for a thread that has no message yet,
		// which is a thread whose first outbound send is still queued.
		.orderBy(
			sql`${conversation.lastMessageAt} desc nulls last`,
			desc(conversation.createdAt),
			desc(conversation.id),
		)
		.limit(pagination.limit)
		.offset(pagination.offset);
	return {
		rows: rows.map(({ total: _total, ...row }) => row),
		total: Number(rows[0]?.total ?? 0),
	};
}

export async function getConversation(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<ConversationRow | undefined> {
	const rows = await transaction
		.select(CONVERSATION_COLUMNS)
		.from(conversation)
		.where(eq(conversation.id, id))
		.limit(1);
	return rows[0];
}

/**
 * The thread for a (our number, their number) pair, creating it if it is new.
 *
 * An upsert rather than a select-then-insert, and that is the whole concurrency story for the
 * inbound path: two webhook deliveries for the same new consumer arrive together, both find no
 * thread, and both insert — one wins the unique index and the other would 23505. `onConflictDoUpdate`
 * with a no-op-shaped SET makes the loser read the winner's row instead, in one statement.
 */
export async function upsertConversation(
	transaction: PbxDatabaseTransaction,
	values: {
		readonly organizationId: string;
		readonly messagingNumberId: string;
		readonly remoteE164: string;
	},
): Promise<ConversationRow> {
	const rows = await transaction
		.insert(conversation)
		.values({
			organizationId: values.organizationId,
			messagingNumberId: values.messagingNumberId,
			remoteE164: values.remoteE164,
		})
		.onConflictDoUpdate({
			target: [
				conversation.organizationId,
				conversation.messagingNumberId,
				conversation.remoteE164,
			],
			// Touching `updatedAt` is what makes this a RETURNING-capable upsert; `onConflictDoNothing`
			// returns no row on the conflict, which would make the loser of the race fall through to a
			// second query.
			set: { updatedAt: new Date() },
		})
		.returning(CONVERSATION_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the conversation upsert returned no row");
	}
	return row;
}

export async function updateConversation(
	transaction: PbxDatabaseTransaction,
	id: string,
	values: { readonly displayName?: string | null; readonly archived?: boolean },
): Promise<ConversationRow | undefined> {
	const rows = await transaction
		.update(conversation)
		.set({ ...values, updatedAt: new Date() })
		.where(eq(conversation.id, id))
		.returning(CONVERSATION_COLUMNS);
	return rows[0];
}

/**
 * Stamps the thread's denormalised "last message" fields and moves the unread counter.
 *
 * `unreadCount` is incremented for inbound and RESET for outbound, not decremented: an agent
 * replying is the act that means "I have read this thread", and a counter that only ever went down
 * by one would drift permanently the first time somebody read three messages and answered once.
 */
export async function touchConversation(
	transaction: PbxDatabaseTransaction,
	id: string,
	values: {
		readonly at: Date;
		readonly preview: string;
		readonly direction: "inbound" | "outbound";
	},
): Promise<void> {
	await transaction
		.update(conversation)
		.set({
			lastMessageAt: values.at,
			lastMessagePreview: values.preview.slice(0, 160),
			lastMessageDirection: values.direction,
			unreadCount: values.direction === "inbound" ? sql`${conversation.unreadCount} + 1` : 0,
			updatedAt: new Date(),
		})
		.where(eq(conversation.id, id));
}

export async function markConversationRead(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<ConversationRow | undefined> {
	const rows = await transaction
		.update(conversation)
		.set({ unreadCount: 0, updatedAt: new Date() })
		.where(eq(conversation.id, id))
		.returning(CONVERSATION_COLUMNS);
	return rows[0];
}

// --------------------------------------------------------------------------------------------
// Messages
// --------------------------------------------------------------------------------------------

export async function listMessages(
	transaction: PbxDatabaseTransaction,
	conversationId: string,
	pagination: Pagination,
): Promise<{ readonly rows: readonly MessageRow[]; readonly total: number }> {
	const rows = await transaction
		.select({ ...MESSAGE_COLUMNS, total: sql<string>`count(*) over ()` })
		.from(message)
		.where(eq(message.conversationId, conversationId))
		// Newest first so page 1 is the bottom of the thread — the part a human reads. The client
		// reverses within the page.
		.orderBy(desc(message.createdAt), desc(message.id))
		.limit(pagination.limit)
		.offset(pagination.offset);
	return {
		rows: rows.map(({ total: _total, ...row }) => row),
		total: Number(rows[0]?.total ?? 0),
	};
}

export async function getMessage(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<MessageRow | undefined> {
	const rows = await transaction
		.select(MESSAGE_COLUMNS)
		.from(message)
		.where(eq(message.id, id))
		.limit(1);
	return rows[0];
}

export interface NewOutboundMessage {
	readonly organizationId: string;
	readonly conversationId: string;
	readonly messagingNumberId: string;
	readonly fromE164: string;
	readonly toE164: string;
	readonly body: string | null;
	readonly mediaKeys: readonly string[];
	readonly sentByUserId: string | null;
	readonly retentionUntil: Date | null;
}

export async function insertOutboundMessage(
	transaction: PbxDatabaseTransaction,
	values: NewOutboundMessage,
): Promise<MessageRow> {
	const rows = await transaction
		.insert(message)
		.values({
			organizationId: values.organizationId,
			conversationId: values.conversationId,
			messagingNumberId: values.messagingNumberId,
			direction: "outbound",
			status: "queued",
			kind: values.mediaKeys.length > 0 ? "MMS" : "SMS",
			fromE164: values.fromE164,
			toE164: values.toE164,
			body: values.body,
			mediaKeys: [...values.mediaKeys],
			sentByUserId: values.sentByUserId,
			retentionUntil: values.retentionUntil,
		})
		.returning(MESSAGE_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the outbound message insert returned no row");
	}
	return row;
}

export interface NewInboundMessage {
	readonly organizationId: string;
	readonly conversationId: string;
	readonly messagingNumberId: string;
	readonly fromE164: string;
	readonly toE164: string;
	readonly body: string | null;
	readonly carrierMessageId: string;
	readonly complianceKeyword: string | null;
	readonly hasMedia: boolean;
	readonly receivedAt: Date;
	readonly retentionUntil: Date | null;
}

/**
 * Files an inbound message, or returns `undefined` when it is a redelivery.
 *
 * `onConflictDoNothing` on the partial unique index is the redelivery guard — the carrier retries
 * anything it did not get a 200 for, and `undefined` is how the caller learns to skip the media
 * download and the event publish rather than doing them twice.
 */
export async function insertInboundMessage(
	transaction: PbxDatabaseTransaction,
	values: NewInboundMessage,
): Promise<MessageRow | undefined> {
	const rows = await transaction
		.insert(message)
		.values({
			organizationId: values.organizationId,
			conversationId: values.conversationId,
			messagingNumberId: values.messagingNumberId,
			direction: "inbound",
			status: "received",
			kind: values.hasMedia ? "MMS" : "SMS",
			fromE164: values.fromE164,
			toE164: values.toE164,
			body: values.body,
			carrierMessageId: values.carrierMessageId,
			complianceKeyword: values.complianceKeyword,
			completedAt: values.receivedAt,
			retentionUntil: values.retentionUntil,
		})
		.onConflictDoNothing({
			target: [message.organizationId, message.carrierMessageId],
			// The unique index is partial; Postgres needs the same predicate on the conflict target or
			// it finds no matching index and errors.
			where: sql`${message.carrierMessageId} is not null`,
		})
		.returning(MESSAGE_COLUMNS);
	return rows[0];
}

export async function setMessageMediaKeys(
	transaction: PbxDatabaseTransaction,
	id: string,
	mediaKeys: readonly string[],
): Promise<void> {
	await transaction
		.update(message)
		.set({ mediaKeys: [...mediaKeys], updatedAt: new Date() })
		.where(eq(message.id, id));
}

/** The send worker's "the carrier accepted it" write. */
export async function markMessageSent(
	transaction: PbxDatabaseTransaction,
	id: string,
	carrierMessageId: string,
	segments: number | undefined,
): Promise<void> {
	await transaction
		.update(message)
		.set({
			status: "sent",
			carrierMessageId,
			...(segments === undefined ? {} : { segments }),
			updatedAt: new Date(),
		})
		.where(eq(message.id, id));
}

export async function failMessage(
	transaction: PbxDatabaseTransaction,
	id: string,
	reason: string,
): Promise<void> {
	await transaction
		.update(message)
		.set({
			status: "failed",
			errorReason: reason.slice(0, 512),
			claimedAt: null,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(message.id, id));
}

/**
 * Puts a claimed row back on the queue.
 *
 * `claimedAt` of `null` means "claimable on the very next poll", which is the right behaviour for a
 * transient carrier blip on a channel where a message is expected to land in seconds. Passing a
 * FUTURE date instead dates the lease forward, so the row is re-offered one backoff from now — the
 * shape the fax worker uses for a slower medium.
 */
export async function releaseMessageClaim(
	transaction: PbxDatabaseTransaction,
	id: string,
	claimedAt: Date | null,
): Promise<void> {
	await transaction
		.update(message)
		.set({ status: "queued", claimedAt, updatedAt: new Date() })
		.where(eq(message.id, id));
}

/**
 * Applies a delivery receipt.
 *
 * Guarded so a LATE `sent` cannot overwrite a `delivered` or a `failed`. Receipts are not ordered —
 * carriers deliver them concurrently and retry them — and a thread that flickers from "delivered"
 * back to "sent" is one nobody believes. The terminal statuses win, whichever arrives last.
 */
export async function applyDeliveryReceipt(
	transaction: PbxDatabaseTransaction,
	id: string,
	values: {
		readonly status: MessageStatus;
		readonly carrierMessageId: string;
		readonly segments?: number | undefined;
		readonly errorReason?: string | undefined;
		readonly terminal: boolean;
	},
): Promise<void> {
	await transaction
		.update(message)
		.set({
			status: values.status,
			carrierMessageId: values.carrierMessageId,
			...(values.segments === undefined ? {} : { segments: values.segments }),
			...(values.errorReason === undefined
				? {}
				: { errorReason: values.errorReason.slice(0, 512) }),
			...(values.terminal ? { completedAt: new Date(), claimedAt: null } : {}),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(message.id, id),
				// See the header. Once terminal, only another terminal receipt may change the row.
				values.terminal ? sql`true` : sql`${message.status} not in ('delivered', 'failed')`,
			),
		);
}

export interface ClaimableMessage {
	readonly id: string;
	readonly organizationId: string;
	readonly messagingNumberId: string;
	readonly conversationId: string;
	readonly fromE164: string;
	readonly toE164: string;
	readonly body: string | null;
	readonly mediaKeys: readonly string[];
	readonly attempts: number;
}

/**
 * Claims the next outbound message owed a send, across every tenant.
 *
 * UNTENANTED and `for update skip locked`, the same shape `claimNextSend` in the fax repository
 * uses, and for the same reasons: "which message anywhere still owes a send" is not a tenant's
 * question, and `skip locked` lets N replicas share the queue with no coordination. `attempts` is
 * incremented by the CLAIM rather than by the carrier call, so a process that dies mid-send still
 * spent an attempt — otherwise a message that kills the worker is claimed forever.
 */
export async function claimNextMessageSend(
	executor: { execute(query: SQL): Promise<unknown> },
	leaseCutoff: Date,
): Promise<ClaimableMessage | undefined> {
	const cutoff = leaseCutoff.toISOString();
	const claim = sql`
		update ${message}
		set status = 'sending',
		    claimed_at = now(),
		    attempts = ${message.attempts} + 1,
		    updated_at = now()
		where ${message.id} = (
			select ${message.id}
			from ${message}
			where direction = 'outbound'
			  and (
				status = 'queued'
				or (status = 'sending' and claimed_at is not null and claimed_at <= ${cutoff}::timestamptz)
			  )
			order by ${message.createdAt} asc
			limit 1
			for update skip locked
		)
		  and direction = 'outbound'
		  and (
			status = 'queued'
			or (status = 'sending' and claimed_at is not null and claimed_at <= ${cutoff}::timestamptz)
		  )
		returning ${message.id} as id,
		          ${message.organizationId} as organization_id,
		          ${message.messagingNumberId} as messaging_number_id,
		          ${message.conversationId} as conversation_id,
		          ${message.fromE164} as from_e164,
		          ${message.toE164} as to_e164,
		          ${message.body} as body,
		          ${message.mediaKeys} as media_keys,
		          ${message.attempts} as attempts
	`;
	const claimed = rowsOf<{
		readonly id: string;
		readonly organization_id: string;
		readonly messaging_number_id: string;
		readonly conversation_id: string;
		readonly from_e164: string;
		readonly to_e164: string;
		readonly body: string | null;
		readonly media_keys: string[] | null;
		readonly attempts: number;
	}>(await executor.execute(claim))[0];
	if (claimed === undefined) {
		return undefined;
	}
	return {
		id: claimed.id,
		organizationId: claimed.organization_id,
		messagingNumberId: claimed.messaging_number_id,
		conversationId: claimed.conversation_id,
		fromE164: claimed.from_e164,
		toE164: claimed.to_e164,
		body: claimed.body,
		mediaKeys: claimed.media_keys ?? [],
		attempts: claimed.attempts,
	};
}

/** Rows past their retention date, across every tenant — the sweeper's question. */
export async function claimExpiredMessagesAdmin(
	executor: { execute(query: SQL): Promise<unknown> },
	limit: number,
): Promise<
	readonly {
		readonly id: string;
		readonly organizationId: string;
		readonly mediaKeys: readonly string[];
	}[]
> {
	const query = sql`
		select ${message.id} as id,
		       ${message.organizationId} as organization_id,
		       ${message.mediaKeys} as media_keys
		from ${message}
		where ${message.retentionUntil} is not null
		  and ${message.retentionUntil} <= now()
		order by ${message.retentionUntil} asc
		limit ${limit}
	`;
	return rowsOf<{
		readonly id: string;
		readonly organization_id: string;
		readonly media_keys: string[] | null;
	}>(await executor.execute(query)).map((row) => ({
		id: row.id,
		organizationId: row.organization_id,
		mediaKeys: row.media_keys ?? [],
	}));
}

export async function deleteMessage(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<boolean> {
	const rows = await transaction
		.delete(message)
		.where(eq(message.id, id))
		.returning({ id: message.id });
	return rows.length > 0;
}

// --------------------------------------------------------------------------------------------
// Opt-outs
// --------------------------------------------------------------------------------------------

export async function listOptOuts(
	transaction: PbxDatabaseTransaction,
	query: OptOutListQuery,
	pagination: Pagination,
): Promise<{ readonly rows: readonly OptOutRow[]; readonly total: number }> {
	const filters: SQL[] = [];
	if (query.numberId !== undefined) {
		filters.push(eq(messagingOptOut.messagingNumberId, query.numberId) as SQL);
	}
	if (query.search !== undefined) {
		filters.push(ilike(messagingOptOut.remoteE164, `%${query.search}%`) as SQL);
	}
	const rows = await transaction
		.select({ ...OPT_OUT_COLUMNS, total: sql<string>`count(*) over ()` })
		.from(messagingOptOut)
		.where(filters.length === 0 ? undefined : and(...filters))
		.orderBy(desc(messagingOptOut.optedOutAt), desc(messagingOptOut.id))
		.limit(pagination.limit)
		.offset(pagination.offset);
	return {
		rows: rows.map(({ total: _total, ...row }) => row),
		total: Number(rows[0]?.total ?? 0),
	};
}

/**
 * Whether this pair is suppressed.
 *
 * Called INSIDE the send transaction, immediately before the insert, so a STOP that arrives between
 * the check and the insert cannot be raced past — the two statements share a snapshot and the
 * inbound path's own insert is a separate transaction that will either be visible here or land after
 * the message row, in which case the message was already accepted and the next one is blocked.
 */
export async function findOptOut(
	transaction: PbxDatabaseTransaction,
	messagingNumberId: string,
	remoteE164: string,
): Promise<OptOutRow | undefined> {
	const rows = await transaction
		.select(OPT_OUT_COLUMNS)
		.from(messagingOptOut)
		.where(
			and(
				eq(messagingOptOut.messagingNumberId, messagingNumberId),
				eq(messagingOptOut.remoteE164, remoteE164),
			),
		)
		.limit(1);
	return rows[0];
}

/** Records an opt-out. Idempotent: a second STOP is not an error and does not move the timestamp. */
export async function upsertOptOut(
	transaction: PbxDatabaseTransaction,
	values: {
		readonly organizationId: string;
		readonly messagingNumberId: string;
		readonly remoteE164: string;
		readonly source: "keyword" | "manual" | "carrier";
		readonly keyword: string | null;
		readonly recordedByUserId: string | null;
	},
): Promise<{ readonly row: OptOutRow; readonly created: boolean }> {
	const inserted = await transaction
		.insert(messagingOptOut)
		.values({
			organizationId: values.organizationId,
			messagingNumberId: values.messagingNumberId,
			remoteE164: values.remoteE164,
			source: values.source,
			keyword: values.keyword,
			recordedByUserId: values.recordedByUserId,
		})
		.onConflictDoNothing({
			target: [
				messagingOptOut.organizationId,
				messagingOptOut.messagingNumberId,
				messagingOptOut.remoteE164,
			],
		})
		.returning(OPT_OUT_COLUMNS);
	const row = inserted[0];
	if (row !== undefined) {
		return { row, created: true };
	}
	// Already suppressed. The ORIGINAL timestamp is what matters — it is the date the consumer asked
	// — so the existing row is read back rather than refreshed.
	const existing = await findOptOut(transaction, values.messagingNumberId, values.remoteE164);
	if (existing === undefined) {
		throw new Error("the opt-out upsert neither inserted nor found a row");
	}
	return { row: existing, created: false };
}

/** Removes a suppression — a START, or an agent recording a re-subscribe. */
export async function deleteOptOut(
	transaction: PbxDatabaseTransaction,
	messagingNumberId: string,
	remoteE164: string,
): Promise<boolean> {
	const rows = await transaction
		.delete(messagingOptOut)
		.where(
			and(
				eq(messagingOptOut.messagingNumberId, messagingNumberId),
				eq(messagingOptOut.remoteE164, remoteE164),
			),
		)
		.returning({ id: messagingOptOut.id });
	return rows.length > 0;
}

export async function getOptOut(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<OptOutRow | undefined> {
	const rows = await transaction
		.select(OPT_OUT_COLUMNS)
		.from(messagingOptOut)
		.where(eq(messagingOptOut.id, id))
		.limit(1);
	return rows[0];
}

// --------------------------------------------------------------------------------------------
// Brands, campaigns and toll-free verification
// --------------------------------------------------------------------------------------------

export async function listBrands(
	transaction: PbxDatabaseTransaction,
	pagination: Pagination,
): Promise<{ readonly rows: readonly BrandRow[]; readonly total: number }> {
	const rows = await transaction
		.select({ ...BRAND_COLUMNS, total: sql<string>`count(*) over ()` })
		.from(messagingBrand)
		.orderBy(desc(messagingBrand.createdAt))
		.limit(pagination.limit)
		.offset(pagination.offset);
	return {
		rows: rows.map(({ total: _total, ...row }) => row),
		total: Number(rows[0]?.total ?? 0),
	};
}

export async function getBrand(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<BrandRow | undefined> {
	const rows = await transaction
		.select(BRAND_COLUMNS)
		.from(messagingBrand)
		.where(eq(messagingBrand.id, id))
		.limit(1);
	return rows[0];
}

/**
 * The brand's EIN, read on its own.
 *
 * Deliberately NOT in {@link BRAND_COLUMNS}: the column set is what every read returns and what the
 * controller serialises, so leaving the EIN out of it means no list, no detail and no log line can
 * leak a government identifier by accident. The one path that needs it — a resubmission to the
 * registry — asks for it explicitly, here, and hands it straight to the carrier client.
 */
export async function getBrandEin(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<string | null | undefined> {
	const rows = await transaction
		.select({ ein: messagingBrand.ein })
		.from(messagingBrand)
		.where(eq(messagingBrand.id, id))
		.limit(1);
	return rows[0]?.ein;
}

export async function insertBrand(
	transaction: PbxDatabaseTransaction,
	values: Record<string, unknown> & { readonly organizationId: string },
): Promise<BrandRow> {
	const rows = await transaction
		.insert(messagingBrand)
		.values(values as never)
		.returning(BRAND_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the brand insert returned no row");
	}
	return row;
}

export async function updateBrand(
	transaction: PbxDatabaseTransaction,
	id: string,
	values: Record<string, unknown>,
): Promise<BrandRow | undefined> {
	const rows = await transaction
		.update(messagingBrand)
		.set({ ...values, updatedAt: new Date() } as never)
		.where(eq(messagingBrand.id, id))
		.returning(BRAND_COLUMNS);
	return rows[0];
}

export async function listCampaigns(
	transaction: PbxDatabaseTransaction,
	pagination: Pagination,
): Promise<{ readonly rows: readonly CampaignRow[]; readonly total: number }> {
	const rows = await transaction
		.select({ ...CAMPAIGN_COLUMNS, total: sql<string>`count(*) over ()` })
		.from(messagingCampaign)
		.orderBy(desc(messagingCampaign.createdAt))
		.limit(pagination.limit)
		.offset(pagination.offset);
	return {
		rows: rows.map(({ total: _total, ...row }) => row),
		total: Number(rows[0]?.total ?? 0),
	};
}

export async function getCampaign(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<CampaignRow | undefined> {
	const rows = await transaction
		.select(CAMPAIGN_COLUMNS)
		.from(messagingCampaign)
		.where(eq(messagingCampaign.id, id))
		.limit(1);
	return rows[0];
}

export async function insertCampaign(
	transaction: PbxDatabaseTransaction,
	values: Record<string, unknown> & { readonly organizationId: string },
): Promise<CampaignRow> {
	const rows = await transaction
		.insert(messagingCampaign)
		.values(values as never)
		.returning(CAMPAIGN_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the campaign insert returned no row");
	}
	return row;
}

export async function updateCampaign(
	transaction: PbxDatabaseTransaction,
	id: string,
	values: Record<string, unknown>,
): Promise<CampaignRow | undefined> {
	const rows = await transaction
		.update(messagingCampaign)
		.set({ ...values, updatedAt: new Date() } as never)
		.where(eq(messagingCampaign.id, id))
		.returning(CAMPAIGN_COLUMNS);
	return rows[0];
}

export async function listTollFreeVerifications(
	transaction: PbxDatabaseTransaction,
	pagination: Pagination,
): Promise<{ readonly rows: readonly TollFreeVerificationRow[]; readonly total: number }> {
	const rows = await transaction
		.select({ ...TFV_COLUMNS, total: sql<string>`count(*) over ()` })
		.from(messagingTollFreeVerification)
		.orderBy(desc(messagingTollFreeVerification.createdAt))
		.limit(pagination.limit)
		.offset(pagination.offset);
	return {
		rows: rows.map(({ total: _total, ...row }) => row),
		total: Number(rows[0]?.total ?? 0),
	};
}

export async function insertTollFreeVerification(
	transaction: PbxDatabaseTransaction,
	values: Record<string, unknown> & { readonly organizationId: string },
): Promise<TollFreeVerificationRow> {
	const rows = await transaction
		.insert(messagingTollFreeVerification)
		.values(values as never)
		.returning(TFV_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the toll-free verification insert returned no row");
	}
	return row;
}

export async function updateTollFreeVerification(
	transaction: PbxDatabaseTransaction,
	id: string,
	values: Record<string, unknown>,
): Promise<TollFreeVerificationRow | undefined> {
	const rows = await transaction
		.update(messagingTollFreeVerification)
		.set({ ...values, updatedAt: new Date() } as never)
		.where(eq(messagingTollFreeVerification.id, id))
		.returning(TFV_COLUMNS);
	return rows[0];
}

/**
 * Every registration row that is still moving, across every tenant — the poller's question.
 *
 * Untenanted for the same reason the send queue is: "which registration anywhere is still pending"
 * belongs to the platform, and an organization-first scan would read every tenant's settled rows to
 * find the handful that are not.
 */
export async function findPendingRegistrationsAdmin(
	executor: { execute(query: SQL): Promise<unknown> },
	limit: number,
): Promise<
	readonly {
		readonly kind: "brand" | "campaign" | "toll-free";
		readonly id: string;
		readonly organizationId: string;
		readonly carrierId: string;
	}[]
> {
	const query = sql`
		select 'brand' as kind, ${messagingBrand.id} as id,
		       ${messagingBrand.organizationId} as organization_id,
		       ${messagingBrand.carrierBrandId} as carrier_id
		from ${messagingBrand}
		where ${messagingBrand.carrierBrandId} is not null
		  and ${messagingBrand.status} in ('pending', 'self-declared', 'unverified')
		union all
		select 'campaign', ${messagingCampaign.id},
		       ${messagingCampaign.organizationId},
		       ${messagingCampaign.carrierCampaignId}
		from ${messagingCampaign}
		where ${messagingCampaign.carrierCampaignId} is not null
		  and ${messagingCampaign.status} in ('pending', 'draft')
		union all
		select 'toll-free', ${messagingTollFreeVerification.id},
		       ${messagingTollFreeVerification.organizationId},
		       ${messagingTollFreeVerification.carrierVerificationId}
		from ${messagingTollFreeVerification}
		where ${messagingTollFreeVerification.carrierVerificationId} is not null
		  and ${messagingTollFreeVerification.status} in ('pending', 'in-review')
		limit ${limit}
	`;
	return rowsOf<{
		readonly kind: "brand" | "campaign" | "toll-free";
		readonly id: string;
		readonly organization_id: string;
		readonly carrier_id: string;
	}>(await executor.execute(query)).map((row) => ({
		kind: row.kind,
		id: row.id,
		organizationId: row.organization_id,
		carrierId: row.carrier_id,
	}));
}

/** Every messaging number pointed at a campaign, so a status change fans out to the numbers. */
export async function listNumbersForCampaign(
	transaction: PbxDatabaseTransaction,
	campaignId: string,
): Promise<readonly MessagingNumberRow[]> {
	return await transaction
		.select(NUMBER_COLUMNS)
		.from(messagingNumber)
		.where(eq(messagingNumber.campaignId, campaignId));
}

/**
 * Drizzle's `execute` returns either an array or a `{ rows }` result depending on the driver, and
 * this API is built against both. Same helper, same reason, as `fax.repository.ts`.
 */
function rowsOf<T>(result: unknown): readonly T[] {
	if (Array.isArray(result)) {
		return result as readonly T[];
	}
	if (typeof result === "object" && result !== null && "rows" in result) {
		return ((result as { readonly rows?: readonly T[] }).rows ?? []) as readonly T[];
	}
	return [];
}
