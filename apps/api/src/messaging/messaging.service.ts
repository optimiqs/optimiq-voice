import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { openMediaResponse } from "../media/media-response";
import { TELNYX_CLIENT } from "../pbx/carrier/carrier.tokens";
import { normalizePagination, paged } from "../pbx/shared/pagination";
import { PBX_DATABASE } from "../pbx/shared/pbx.tokens";
import { isWithinQuietHours } from "./compliance/quiet-hours";
import {
	buildMessagingObjectKey,
	messagingMediaContentType,
	messagingMediaExtension,
	messagingMediaPath,
	mintMessagingMediaToken,
	verifyMessagingMediaToken,
} from "./messaging-media";
import {
	MessagingMediaGoneException,
	MessagingMediaLinkExpiredException,
	MessagingMediaLinkInvalidException,
	MessagingMediaRejectedException,
	MessagingMediaSigningUnavailableException,
	MessagingNotConfiguredException,
	MessagingNotFoundException,
	MessagingNumberConflictException,
	MessagingNumberNotRegisteredException,
	MessagingQuietHoursException,
	MessagingRecipientOptedOutException,
} from "./messaging.errors";
import { messagesTotal, messagingOptOutsTotal, messagingSendsBlocked } from "./messaging.metrics";
import {
	deleteMessagingNumber,
	deleteOptOut,
	findOptOut,
	getCampaign,
	getConversation,
	getMessage,
	getMessagingNumber,
	getOptOut,
	getPhoneNumberForMessaging,
	insertMessagingNumber,
	insertOutboundMessage,
	listConversations,
	listMessages,
	listMessagingNumbers,
	listOptOuts,
	markConversationRead,
	touchConversation,
	updateConversation,
	updateMessagingNumber,
	upsertConversation,
	upsertOptOut,
} from "./messaging.repository";
import { MESSAGING_ENV, MESSAGING_PROVIDER, MESSAGING_STORE } from "./messaging.tokens";
import type { MediaResponse } from "../media/media-response";
import type { ObjectStore } from "../storage";
import type { MessagingEnv } from "./messaging-env";
import type {
	ConversationListQuery,
	CreateOptOutDto,
	EnableMessagingNumberDto,
	MessageListQuery,
	MessagingNumberListQuery,
	OptOutListQuery,
	SendMessageDto,
	UpdateConversationDto,
	UpdateMessagingNumberDto,
} from "./messaging.dto";
import type {
	CampaignRow,
	ConversationRow,
	MessageRow,
	MessagingNumberRow,
	OptOutRow,
} from "./messaging.repository";
import type { MessagingProvider } from "./provider/messaging-provider.port";
import type { AppSession } from "@optimiq-voice/auth";
import type { MessagingRegistrationStatus, PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

const logger = getLogger("api.messaging");

/** The name the platform's own messaging profile is created and re-found under. */
const PLATFORM_PROFILE_NAME = "Optimiq Voice";

/**
 * Messaging numbers, conversations, the enqueue side of the send queue, and the opt-out ledger.
 *
 * Bespoke rather than built on `PbxResourceService`, for the reason `FaxService` is: messaging is
 * not a routing destination and does not participate in compile-on-write, it owns a media store and
 * two background workers, and the message rows are a ledger rather than a CRUD resource. Everything
 * runs inside `withTenantScope`, so RLS is the filter.
 *
 * # The send gate, in order, and why that order
 *
 * {@link send} refuses in a fixed sequence, and the sequence is chosen so the refusal a caller sees
 * is the most actionable one:
 *
 * 1. **Configured?** No provider means nothing can be sent by anyone; every other check would be
 *    theatre.
 * 2. **Enabled?** The tenant themselves parked this line.
 * 3. **Registered?** The carriers will filter this traffic. Named with the stored reason.
 * 4. **Opted out?** — checked INSIDE the send transaction, immediately before the insert, so a STOP
 *    that lands between the check and the insert cannot be raced past.
 * 5. **Quiet hours?** The message is fine and the clock is wrong.
 *
 * Registration before opt-out is deliberate even though opt-out is the more serious of the two: a
 * number that cannot send at all should not be telling an agent about one recipient's consent, and
 * an admin fixing registration fixes every recipient at once.
 */
@Injectable()
export class MessagingService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(MESSAGING_ENV) private readonly env: MessagingEnv,
		@Inject(MESSAGING_STORE) private readonly store: ObjectStore,
		@Inject(MESSAGING_PROVIDER) private readonly provider: MessagingProvider | undefined,
		@Inject(TELNYX_CLIENT) private readonly carrier: TelnyxClient | undefined,
	) {}

	/**
	 * The carrier-side messaging profile every number on this deployment sends through, created on
	 * first use when the operator has not named one.
	 *
	 * Lazy rather than required, because requiring it makes the first-run experience "enable
	 * messaging, watch every send fail, read a variable name in a log". A profile is free, is
	 * account-level rather than tenant-level (the same argument `carrier-env.ts` makes for the API
	 * key), and is the thing the carrier routes inbound traffic by — so a platform with none has
	 * nothing to attach numbers to and a platform with one needs no decision made about it.
	 *
	 * Cached in memory for the process's life. A restart re-reads it from the carrier by name rather
	 * than creating a second, which is why the lookup comes before the create.
	 */
	private profilePromise: Promise<string | undefined> | undefined;

	private async ensureMessagingProfile(): Promise<string | undefined> {
		const configured = this.env.TELNYX_MESSAGING_PROFILE_ID;
		if (configured !== undefined) {
			return configured;
		}
		const carrier = this.carrier;
		if (carrier === undefined) {
			return undefined;
		}
		this.profilePromise ??= (async () => {
			try {
				const existing = await carrier.messagingProfiles.list();
				const found = existing.find((profile) => profile.name === PLATFORM_PROFILE_NAME);
				if (found !== undefined) {
					return found.id;
				}
				const created = await carrier.messagingProfiles.create({ name: PLATFORM_PROFILE_NAME });
				logger.info({ messagingProfileId: created.id }, "created the platform messaging profile");
				return created.id;
			} catch (error) {
				// Not fatal: the number is still enabled, just not attached, and the settings page
				// shows that. Clearing the cache lets the next enable retry rather than remembering a
				// failure for the life of the process.
				this.profilePromise = undefined;
				logger.error(
					{ err: String(error) },
					"could not resolve the platform messaging profile at the carrier",
				);
				return undefined;
			}
		})();
		return await this.profilePromise;
	}

	// ---- messaging numbers -------------------------------------------------------------------

	async listNumbers(session: AppSession, query: MessagingNumberListQuery) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const { rows, total } = await listMessagingNumbers(transaction, query, pagination);
			return paged(rows, total, pagination);
		});
	}

	async getNumber(session: AppSession, id: string): Promise<MessagingNumberRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getMessagingNumber(transaction, id),
		);
		if (row === undefined) {
			throw new MessagingNotFoundException("number");
		}
		return row;
	}

	/**
	 * Turns a voice DID into a messaging line.
	 *
	 * The row is created `unregistered` with a reason that already says what to do next, rather than
	 * with a null reason that renders as an empty cell. An admin who enables messaging and then finds
	 * a send refused should be reading the same sentence in both places.
	 *
	 * The carrier-side messaging-profile attachment is best-effort and does NOT fail the enable: the
	 * row is the platform's record that this DID is a messaging line, and a carrier that is briefly
	 * unreachable must not leave an admin unable to configure anything. A number whose attachment did
	 * not happen carries no `carrierMessagingProfileId`, which the settings page shows.
	 */
	async enableNumber(
		session: AppSession,
		dto: EnableMessagingNumberDto,
	): Promise<MessagingNumberRow> {
		const organizationId = requireActiveOrganizationId(session);
		const created = await this.database.withTenantScope(organizationId, async (transaction) => {
			const did = await getPhoneNumberForMessaging(transaction, dto.phoneNumberId);
			if (did === undefined) {
				// A DID in another tenant is invisible under RLS, so this is a 404 rather than a 403 —
				// and deliberately indistinguishable from a DID that does not exist.
				throw new MessagingNotFoundException("number");
			}
			const numberClass = dto.numberClass ?? classifyNumber(did.e164);
			return await insertMessagingNumber(transaction, {
				organizationId,
				phoneNumberId: did.id,
				e164: did.e164,
				numberClass,
				carrierMessagingProfileId: null,
				registrationReason: initialRegistrationReason(numberClass),
				retentionDays: dto.retentionDays ?? null,
			}).catch((error: unknown) => {
				if (isUniqueViolation(error)) {
					throw new MessagingNumberConflictException(
						"Messaging is already enabled on this number.",
					);
				}
				throw error;
			});
		});

		const profileId = await this.ensureMessagingProfile();
		if (this.carrier !== undefined && profileId !== undefined) {
			const did = await this.database.withTenantScope(
				organizationId,
				async (transaction) => await getPhoneNumberForMessaging(transaction, dto.phoneNumberId),
			);
			/**
			 * The carrier's own id for the number when we ordered it, and the E.164 otherwise.
			 *
			 * A DID an admin typed in has no `carrier_ref` — it may be hosted, or ported, or simply
			 * configured ahead of the order — and refusing to attach messaging to it would mean the
			 * feature only ever worked for numbers bought through this platform. Telnyx addresses a
			 * number's messaging settings by either.
			 */
			const carrierRef = did?.carrierRef ?? did?.e164 ?? null;
			if (carrierRef !== null) {
				try {
					await this.carrier.messagingProfiles.assignPhoneNumber(carrierRef, profileId);
					await this.database.withTenantScope(
						organizationId,
						async (transaction) =>
							await updateMessagingNumber(transaction, created.id, {
								carrierMessagingProfileId: profileId,
							}),
					);
					return { ...created, carrierMessagingProfileId: profileId };
				} catch (error) {
					logger.error(
						{ organizationId, messagingNumberId: created.id, err: String(error) },
						"a messaging number was created but could not be attached to the carrier profile",
					);
				}
			}
		}
		return created;
	}

	async updateNumber(
		session: AppSession,
		id: string,
		dto: UpdateMessagingNumberDto,
	): Promise<MessagingNumberRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(organizationId, async (transaction) => {
			const existing = await getMessagingNumber(transaction, id);
			if (existing === undefined) {
				throw new MessagingNotFoundException("number");
			}
			// A mutable local, widened from the repository's readonly parameter type: `null` and
			// `undefined` mean different things here (unbind versus leave alone), so the patch is built
			// key by key rather than spread — and a spread would carry the `undefined`s through as
			// explicit nulls.
			const patch: {
				enabled?: boolean;
				campaignId?: string | null;
				retentionDays?: number | null;
				registrationStatus?: MessagingRegistrationStatus;
				registrationReason?: string | null;
			} = {};
			if (dto.enabled !== undefined) {
				patch.enabled = dto.enabled;
			}
			if (dto.retentionDays !== undefined) {
				patch.retentionDays = dto.retentionDays;
			}
			if (dto.campaignId !== undefined) {
				// Unassigning is not just a null: a number with no campaign cannot legally send 10DLC
				// traffic, so the registration state has to move with it or the send gate would keep
				// letting traffic through on a stale `registered`.
				if (dto.campaignId === null) {
					patch.campaignId = null;
					patch.registrationStatus = "unregistered";
					patch.registrationReason = "This number is not assigned to an approved 10DLC campaign.";
				} else {
					const campaign = await getCampaign(transaction, dto.campaignId);
					if (campaign === undefined) {
						throw new MessagingNotFoundException("campaign");
					}
					patch.campaignId = campaign.id;
					const registered = campaign.status === "active";
					patch.registrationStatus = registered ? "registered" : "pending";
					patch.registrationReason = registered
						? null
						: `Campaign "${campaign.name}" is ${campaign.status}; the carriers accept traffic ` +
							"only from an active campaign.";
				}
			}
			return await updateMessagingNumber(transaction, id, patch);
		});
		if (row === undefined) {
			throw new MessagingNotFoundException("number");
		}
		return row;
	}

	/**
	 * Turns messaging off for a DID.
	 *
	 * The conversations SURVIVE — `conversation.messaging_number_id` is `on delete restrict`, so a
	 * line with history refuses to be deleted and is disabled instead. That is the intended
	 * behaviour, not an obstacle worked around: a tenant must not be able to erase the record of what
	 * was said to consumers by unticking a box, and retention is the mechanism that removes it.
	 */
	async removeNumber(session: AppSession, id: string): Promise<{ readonly deleted: boolean }> {
		const organizationId = requireActiveOrganizationId(session);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const existing = await getMessagingNumber(transaction, id);
			if (existing === undefined) {
				throw new MessagingNotFoundException("number");
			}
			try {
				const deleted = await deleteMessagingNumber(transaction, id);
				return { deleted };
			} catch (error) {
				if (isForeignKeyViolation(error)) {
					await updateMessagingNumber(transaction, id, {
						enabled: false,
						registrationReason:
							"Messaging is switched off for this number. Its conversation history is kept " +
							"until the retention policy removes it.",
					});
					return { deleted: false };
				}
				throw error;
			}
		});
	}

	// ---- conversations -----------------------------------------------------------------------

	async listConversations(session: AppSession, query: ConversationListQuery) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			if (
				query.numberId !== undefined &&
				(await getMessagingNumber(transaction, query.numberId)) === undefined
			) {
				// Proven to belong to the tenant first, so a cross-tenant id is a 404 rather than an
				// empty page that reads as "this number has no conversations".
				throw new MessagingNotFoundException("number");
			}
			const { rows, total } = await listConversations(transaction, query, pagination);
			return paged(rows, total, pagination);
		});
	}

	async getConversation(session: AppSession, id: string): Promise<ConversationRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getConversation(transaction, id),
		);
		if (row === undefined) {
			throw new MessagingNotFoundException("conversation");
		}
		return row;
	}

	async updateConversation(
		session: AppSession,
		id: string,
		dto: UpdateConversationDto,
	): Promise<ConversationRow> {
		const organizationId = requireActiveOrganizationId(session);
		const patch: { displayName?: string | null; archived?: boolean } = {};
		if (dto.displayName !== undefined) {
			patch.displayName = dto.displayName;
		}
		if (dto.archived !== undefined) {
			patch.archived = dto.archived;
		}
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await updateConversation(transaction, id, patch),
		);
		if (row === undefined) {
			throw new MessagingNotFoundException("conversation");
		}
		return row;
	}

	async markRead(session: AppSession, id: string): Promise<ConversationRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await markConversationRead(transaction, id),
		);
		if (row === undefined) {
			throw new MessagingNotFoundException("conversation");
		}
		return row;
	}

	async listMessages(session: AppSession, conversationId: string, query: MessageListQuery) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			if ((await getConversation(transaction, conversationId)) === undefined) {
				throw new MessagingNotFoundException("conversation");
			}
			const { rows, total } = await listMessages(transaction, conversationId, pagination);
			return paged(rows.map(toMessageResponse), total, pagination);
		});
	}

	async getMessage(session: AppSession, id: string) {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getMessage(transaction, id),
		);
		if (row === undefined) {
			throw new MessagingNotFoundException("message");
		}
		return toMessageResponse(row);
	}

	// ---- the send gate -----------------------------------------------------------------------

	/**
	 * Queues one outbound message, refusing at the first gate that says no.
	 *
	 * The row IS the queue — the send worker polls the column, so this returns as soon as the row is
	 * durable, the same shape the fax and CDR-export enqueues take. What a caller gets back is a
	 * `queued` message, never a sent one, and the 202 on the route says so.
	 */
	async send(session: AppSession, dto: SendMessageDto) {
		const organizationId = requireActiveOrganizationId(session);
		if (this.provider === undefined) {
			messagingSendsBlocked.inc({ reason: "not-configured" });
			throw new MessagingNotConfiguredException();
		}
		const userId = sessionUserId(session);

		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const number = await getMessagingNumber(transaction, dto.messagingNumberId);
			if (number === undefined) {
				throw new MessagingNotFoundException("number");
			}
			if (!number.enabled) {
				messagingSendsBlocked.inc({ reason: "disabled" });
				throw new MessagingNumberNotRegisteredException(
					number.e164,
					"messaging is switched off for this number.",
				);
			}
			// Gate 3: registration. The hard block the whole 10DLC feature exists to enforce, and the
			// reason is the stored one so the API and the settings page say the same thing.
			if (number.registrationStatus !== "registered") {
				messagingSendsBlocked.inc({ reason: "not-registered" });
				throw new MessagingNumberNotRegisteredException(
					number.e164,
					number.registrationReason ??
						"this number is not registered with the carriers for A2P messaging.",
				);
			}

			// Gate 4: consent. Inside the transaction, immediately before the insert — see the header.
			const suppressed = await findOptOut(transaction, number.id, dto.to);
			if (suppressed !== undefined) {
				messagingSendsBlocked.inc({ reason: "opted-out" });
				throw new MessagingRecipientOptedOutException(dto.to, suppressed.optedOutAt ?? new Date());
			}

			// Gate 5: the clock.
			const campaign =
				number.campaignId === null ? undefined : await getCampaign(transaction, number.campaignId);
			const window = quietHoursOf(campaign);
			const decision = isWithinQuietHours(window, new Date());
			if (!decision.allowed) {
				messagingSendsBlocked.inc({ reason: "quiet-hours" });
				throw new MessagingQuietHoursException(decision.localTime, decision.window);
			}

			const conversation = await upsertConversation(transaction, {
				organizationId,
				messagingNumberId: number.id,
				remoteE164: dto.to,
			});
			const body = (dto.body ?? "").trim();
			const row = await insertOutboundMessage(transaction, {
				organizationId,
				conversationId: conversation.id,
				messagingNumberId: number.id,
				fromE164: number.e164,
				toE164: dto.to,
				body: body.length === 0 ? null : body,
				mediaKeys: dto.mediaKeys ?? [],
				sentByUserId: userId,
				retentionUntil: this.retentionFor(number.retentionDays),
			});
			await touchConversation(transaction, conversation.id, {
				at: row.createdAt ?? new Date(),
				preview: body.length === 0 ? "[attachment]" : body,
				direction: "outbound",
			});
			messagesTotal.inc({ direction: "outbound", kind: row.kind });
			return toMessageResponse(row);
		});
	}

	// ---- opt-outs ----------------------------------------------------------------------------

	async listOptOuts(session: AppSession, query: OptOutListQuery) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const { rows, total } = await listOptOuts(transaction, query, pagination);
			return paged(rows, total, pagination);
		});
	}

	/** Records an opt-out that arrived somewhere this platform cannot observe. */
	async createOptOut(session: AppSession, dto: CreateOptOutDto): Promise<OptOutRow> {
		const organizationId = requireActiveOrganizationId(session);
		const userId = sessionUserId(session);
		const result = await this.database.withTenantScope(organizationId, async (transaction) => {
			const number = await getMessagingNumber(transaction, dto.messagingNumberId);
			if (number === undefined) {
				throw new MessagingNotFoundException("number");
			}
			return await upsertOptOut(transaction, {
				organizationId,
				messagingNumberId: number.id,
				remoteE164: dto.remoteE164,
				source: "manual",
				keyword: dto.note ?? null,
				recordedByUserId: userId,
			});
		});
		if (result.created) {
			messagingOptOutsTotal.inc({ action: "added", source: "manual" });
		}
		return result.row;
	}

	/**
	 * Removes a suppression — an agent recording that the consumer asked to resume.
	 *
	 * Logged at `warn`, deliberately. Every other write in this service is routine; this one asserts
	 * that a person who previously said stop has said start, and it is the single act in the
	 * messaging area most likely to be the subject of a complaint. The `messaging.manage` grant is
	 * what limits who can do it; this line is what says who did.
	 */
	async removeOptOut(session: AppSession, id: string): Promise<{ readonly deleted: true }> {
		const organizationId = requireActiveOrganizationId(session);
		const userId = sessionUserId(session);
		const removed = await this.database.withTenantScope(organizationId, async (transaction) => {
			const existing = await getOptOut(transaction, id);
			if (existing === undefined) {
				throw new MessagingNotFoundException("opt-out");
			}
			await deleteOptOut(transaction, existing.messagingNumberId, existing.remoteE164);
			return existing;
		});
		messagingOptOutsTotal.inc({ action: "removed", source: removed.source ?? "manual" });
		logger.warn(
			{
				organizationId,
				actorUserId: userId,
				messagingNumberId: removed.messagingNumberId,
				remoteE164: removed.remoteE164,
				originallyOptedOutAt: removed.optedOutAt?.toISOString(),
				originalSource: removed.source,
			},
			"a messaging opt-out was removed — the recipient may be messaged again",
		);
		return { deleted: true };
	}

	// ---- MMS media ---------------------------------------------------------------------------

	/**
	 * Stores one uploaded attachment and returns its key.
	 *
	 * The content type is decided by the ALLOW-LIST and not by what the upload claimed, and a type
	 * that is not on it is refused before a byte reaches the store — see `messaging-media.ts` for why
	 * that matters more here than anywhere else in this API.
	 */
	async storeUpload(
		session: AppSession,
		file: { readonly bytes: Buffer; readonly contentType: string | undefined },
	): Promise<{
		readonly objectKey: string;
		readonly contentType: string;
		readonly sizeBytes: number;
	}> {
		const organizationId = requireActiveOrganizationId(session);
		const extension = messagingMediaExtension(file.contentType);
		if (extension === undefined) {
			throw new MessagingMediaRejectedException(
				`${file.contentType ?? "an unknown type"} cannot be sent as an attachment.`,
			);
		}
		if (file.bytes.byteLength === 0) {
			throw new MessagingMediaRejectedException("The attachment is empty.");
		}
		if (file.bytes.byteLength > this.env.MESSAGING_MAX_MEDIA_BYTES) {
			throw new MessagingMediaRejectedException(
				`The attachment is larger than the ${String(
					Math.floor(this.env.MESSAGING_MAX_MEDIA_BYTES / 1_024 / 1_024),
				)} MB limit.`,
			);
		}
		const objectKey = buildMessagingObjectKey(organizationId, extension);
		const contentType = messagingMediaContentType(objectKey);
		await this.store.put(objectKey, file.bytes, { contentType });
		return { objectKey, contentType, sizeBytes: file.bytes.byteLength };
	}

	/** Mints a signed, expiring link to one part of a message's media. */
	async mintMediaLink(
		session: AppSession,
		messageId: string,
		/**
		 * The part, named either by its index or by its object key.
		 *
		 * The key is what a client naturally has — it came back on the message row — and resolving it
		 * to an index HERE rather than making the client count is what keeps the index an
		 * implementation detail of the token. Both are validated against the row's own array, so
		 * neither can address an object the message does not own.
		 */
		part: number | string,
	): Promise<{ readonly url: string; readonly expiresAt: string }> {
		const organizationId = requireActiveOrganizationId(session);
		const secret = this.env.MESSAGING_MEDIA_URL_SECRET;
		if (secret === undefined) {
			throw new MessagingMediaSigningUnavailableException();
		}
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getMessage(transaction, messageId),
		);
		const keys = row?.mediaKeys ?? [];
		const index = typeof part === "string" ? keys.indexOf(part) : part;
		if (row === undefined || index < 0 || index >= keys.length) {
			throw new MessagingNotFoundException("message");
		}
		const expiresAtSeconds =
			Math.floor(Date.now() / 1_000) + this.env.MESSAGING_MEDIA_URL_TTL_SECONDS;
		const token = mintMessagingMediaToken(messageId, organizationId, expiresAtSeconds, secret);
		return {
			url: messagingMediaPath(token, index),
			expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
		};
	}

	/**
	 * Verifies a media token and opens the part for a ranged response.
	 *
	 * The token names the MESSAGE and the part index; the object key is read from the row and never
	 * from the URL, so a holder of one link cannot edit it into a link for another object. See
	 * `messaging-media.ts`.
	 */
	async openSignedMedia(
		token: string,
		part: number,
		rangeHeader: string | undefined,
	): Promise<MediaResponse> {
		const secret = this.env.MESSAGING_MEDIA_URL_SECRET;
		if (secret === undefined) {
			throw new MessagingMediaSigningUnavailableException();
		}
		const verified = verifyMessagingMediaToken(token, {
			current: secret,
			...(this.env.MESSAGING_MEDIA_URL_SECRET_PREVIOUS === undefined
				? {}
				: { previous: this.env.MESSAGING_MEDIA_URL_SECRET_PREVIOUS }),
		});
		const payload = verified.payload;
		if (!verified.ok || payload === undefined) {
			throw verified.failure === "expired"
				? new MessagingMediaLinkExpiredException()
				: new MessagingMediaLinkInvalidException();
		}
		const row = await this.database.withTenantScope(
			payload.o,
			async (transaction) => await getMessage(transaction, payload.r),
		);
		const objectKey = (row?.mediaKeys ?? [])[part];
		if (row === undefined || objectKey === undefined) {
			throw new MessagingMediaLinkInvalidException();
		}
		const stat = await this.store.head(objectKey).catch(() => undefined);
		if (stat === undefined) {
			throw new MessagingMediaGoneException();
		}
		const contentType = messagingMediaContentType(objectKey);
		return await openMediaResponse(this.store, objectKey, stat.sizeBytes, {
			contentType,
			fileName: objectKey.slice(objectKey.lastIndexOf("/") + 1),
			...(rangeHeader === undefined ? {} : { rangeHeader }),
			// Anything this platform could not identify is served as a download, never rendered
			// in place — an unidentified type is exactly the one that must not be sniffed.
			disposition: contentType === "application/octet-stream" ? "attachment" : "inline",
		});
	}

	/** The retention stamp for a new row: the number's policy, else the platform's, else none. */
	retentionFor(numberRetentionDays: number | null): Date | null {
		const days = numberRetentionDays ?? this.env.MESSAGING_RETENTION_DAYS;
		if (days <= 0) {
			return null;
		}
		return new Date(Date.now() + days * 24 * 60 * 60 * 1_000);
	}
}

/**
 * A message row as the API returns it: the stored keys turned into described PARTS.
 *
 * The row holds object keys and nothing else, because a key is all the send path and the retention
 * sweeper need. A client needs more: an inbox cannot decide whether to render a part inline or as a
 * download without knowing its type, and asking it to parse an extension out of a storage path would
 * make the key layout a public contract.
 *
 * The content type is DERIVED from the key rather than stat'ed from the store, deliberately. A
 * thread page is a list, and stat'ing every part of every message would put an object-store round
 * trip per attachment on a read path — for a value that is already determined, because the key's
 * extension was chosen from the allow-list when the bytes were stored and nothing can change it
 * afterwards.
 */
export function toMessageResponse(row: MessageRow) {
	const keys = row.mediaKeys ?? [];
	return {
		...row,
		media: keys.map((objectKey, part) => ({
			objectKey,
			part,
			contentType: messagingMediaContentType(objectKey),
		})),
	};
}

/** The campaign's window, or `undefined` when it declared none. The trio is atomic by check. */
export function quietHoursOf(campaign: CampaignRow | undefined) {
	if (
		campaign === undefined ||
		campaign.quietHoursStartMinute === null ||
		campaign.quietHoursEndMinute === null ||
		campaign.quietHoursTimeZone === null
	) {
		return undefined;
	}
	return {
		startMinute: campaign.quietHoursStartMinute,
		endMinute: campaign.quietHoursEndMinute,
		timeZone: campaign.quietHoursTimeZone,
	};
}

/**
 * Toll-free or local, from the E.164.
 *
 * A NANP rule, and knowingly a partial one: it recognises the US/Canada toll-free SAC list and calls
 * everything else local. That is right for every number this platform can currently order, and the
 * DTO lets an admin override it for the day it is not — which is better than a lookup that would be
 * confidently wrong about a number from a country whose numbering plan we have not modelled.
 */
export function classifyNumber(e164: string): "local" | "toll-free" | "short-code" {
	const tollFree = /^\+1(800|833|844|855|866|877|888)\d{7}$/u;
	if (tollFree.test(e164)) {
		return "toll-free";
	}
	// Short codes are five to six digits and have no country code, so they never reach E.164 form.
	return "local";
}

/** The sentence a freshly-enabled number carries until it is registered. */
export function initialRegistrationReason(
	numberClass: "local" | "toll-free" | "short-code",
): string {
	switch (numberClass) {
		case "toll-free":
			return "This toll-free number has not completed carrier verification. Submit a toll-free verification request to start sending.";
		case "short-code":
			return "Short codes are not supported for sending on this platform.";
		default:
			return "This number is not assigned to an approved 10DLC campaign. Register a brand, get a campaign approved, then assign this number to it.";
	}
}

function sessionUserId(session: AppSession): string | null {
	const candidate = (session as { readonly user?: { readonly id?: unknown } }).user?.id;
	return typeof candidate === "string" ? candidate : null;
}

/** Postgres `23505`. Reached through `cause` because the driver wraps it. */
function isUniqueViolation(error: unknown): boolean {
	return pgCode(error) === "23505";
}

/** Postgres `23503` — the `on delete restrict` from `conversation`. */
function isForeignKeyViolation(error: unknown): boolean {
	return pgCode(error) === "23503";
}

function pgCode(error: unknown): string | undefined {
	for (let current: unknown = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
		if (typeof current === "object" && current !== null) {
			const code = (current as { readonly code?: unknown }).code;
			if (typeof code === "string") {
				return code;
			}
			current = (current as { readonly cause?: unknown }).cause;
			continue;
		}
		break;
	}
	return undefined;
}
