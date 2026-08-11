import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import {
	and,
	desc,
	eq,
	extension,
	inArray,
	sql,
	voicemailBox,
	voicemailMessage,
} from "@optimiq-voice/pbx-db";
import { openMediaResponse } from "../../media/media-response";
import { ObjectKeyOutsideRootError } from "../../storage";
import { normalizePagination, paged } from "../shared/pagination";
import { PBX_DATABASE, PBX_ENV, PBX_VOICEMAIL_STORE } from "../shared/pbx.tokens";
import {
	mintVoicemailMediaToken,
	verifyVoicemailMediaToken,
	voicemailMediaPath,
} from "./voicemail-media-token";
import { isMessageRead } from "./voicemail-messages.dto";
import { readMailboxCounts, VoicemailMwiPublisher } from "./voicemail-mwi.publisher";
import {
	VoicemailLinkExpiredException,
	VoicemailLinkInvalidException,
	VoicemailMediaGoneException,
	VoicemailNotFoundException,
	VoicemailSigningUnavailableException,
} from "./voicemail.errors";
import type { MediaResponse } from "../../media/media-response";
import type { ObjectStore } from "../../storage";
import type { PagedResult } from "../shared/pagination";
import type { PbxEnv } from "../shared/pbx-env";
import type { UpdateVoicemailMessage, VoicemailMessageListQuery } from "./voicemail-messages.dto";
import type { MailboxCounts, MwiReason } from "./voicemail-mwi.publisher";
import type { AppSession } from "@optimiq-voice/auth";
import type {
	PbxDatabaseClient,
	PbxDatabaseTransaction,
	VoicemailFolder,
	VoicemailTranscriptionStatus,
} from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The messages in a mailbox — the read model behind both the web UI and the `*97` menu.
 *
 * ## Why this is not a `PbxResource`
 *
 * Every other entity in this area is CRUD over a routing table, and goes through the Effect
 * repository so that a write is followed by compile-on-write and a KV publish. `voicemail_message`
 * is deliberately not one of those: `affectsRouting("voicemail_message")` is FALSE, which is what
 * stops every new message from evicting a tenant's hot artifact. Routing message writes through
 * the repository would undo that on purpose, and would recompile a tenant's entire call plan every
 * time somebody pressed 7. So this service holds the database client directly — the same seam
 * `voicemail-consumer.service.ts` uses, and for the same reason — and every read and write still
 * runs inside `withTenantScope`, so RLS is the filter rather than a `where` clause we could forget.
 *
 * ## The mailbox is proved first, every time
 *
 * Nothing here takes a message id on its own. Every operation names a BOX and a message, and the
 * box is read inside the tenant scope before the message is touched. That makes the id in the URL
 * describe a tree the caller is allowed to be in, rather than a flat namespace where knowing an id
 * is the same as being entitled to it — and it means a message id from another organization
 * answers 404 twice over: RLS hides the row, and the box/message pairing would not match anyway.
 *
 * ## The RPC and the REST surface share this class
 *
 * `rpc.voicemail.v1.list` (the engine's `*97`) and `GET …/messages` (the browser) are the same
 * question asked by two callers with two different kinds of credential. Sharing the query means
 * they cannot drift about what "newest first" or "the new folder" means; the AUTHORISATION is what
 * differs, and it lives at each entry point rather than in here — see
 * {@link listForBroker} for the cross-check the broker path has to make and the browser does not.
 */
@Injectable()
export class VoicemailMessagesService {
	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(VoicemailMwiPublisher) private readonly mwi: VoicemailMwiPublisher,
		/**
		 * Message audio's store, rooted at `PBX_VOICEMAIL_MEDIA_ROOT`.
		 *
		 * This service never WRITES through it: Asterisk records the message onto the shared volume
		 * and `voicemail-consumer.service.ts` files the row and archives the bytes. What happens here
		 * is reads — one signed playback route — and the store is what makes that read survive a
		 * container whose volume was replaced, because the mirror answers when the filesystem cannot.
		 * `*97` still plays off the filesystem (see {@link listForBroker}), which is why the mirror is
		 * an archive rather than a migration.
		 */
		@Inject(PBX_VOICEMAIL_STORE) private readonly store: ObjectStore,
	) {}

	// -------------------------------------------------------------------------------------------
	// HTTP
	// -------------------------------------------------------------------------------------------

	/**
	 * One page of a mailbox, newest first.
	 *
	 * An absent `folder` means "everything except `deleted`", which is what an inbox is. Asking for
	 * `deleted` explicitly is how the trash is read — the same shape the recordings screen uses for
	 * purged rows, and for the same reason: the audit question ("was there a message and what
	 * happened to it") has no other answer.
	 */
	async list(
		session: AppSession,
		boxId: string,
		query: VoicemailMessageListQuery,
	): Promise<VoicemailMessageListEnvelope> {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);

		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const box = await requireBox(transaction, boxId);
			const folders: readonly VoicemailFolder[] =
				query.folder === undefined ? ["new", "saved"] : [query.folder];

			const rows = await transaction
				.select({
					id: voicemailMessage.id,
					voicemailBoxId: voicemailMessage.voicemailBoxId,
					folder: voicemailMessage.folder,
					callerIdName: voicemailMessage.callerIdName,
					callerIdNumber: voicemailMessage.callerIdNumber,
					receivedAt: voicemailMessage.receivedAt,
					durationMs: voicemailMessage.durationMs,
					sizeBytes: voicemailMessage.sizeBytes,
					transcription: voicemailMessage.transcription,
					transcriptionStatus: voicemailMessage.transcriptionStatus,
					transcribedAt: voicemailMessage.transcribedAt,
					callLegRef: voicemailMessage.callLegRef,
					// `count(*) over ()` on the same query rather than a second `select count(*)`, so
					// the count and the page cannot disagree about the snapshot they were taken from —
					// the rule `pagination.ts` states for every list in this area.
					total: sql<number>`count(*) over ()`.mapWith(Number),
				})
				.from(voicemailMessage)
				.where(
					and(
						eq(voicemailMessage.voicemailBoxId, boxId),
						inArray(voicemailMessage.folder, [...folders]),
					),
				)
				// `receivedAt` then `id`: two messages can share a second, and a list whose order is
				// not total repeats or skips a row across page boundaries. The id is UUID v7, so it
				// breaks the tie in the same direction time does.
				.orderBy(desc(voicemailMessage.receivedAt), desc(voicemailMessage.id))
				.limit(pagination.limit)
				.offset(pagination.offset);

			const counts = await readMailboxCounts(transaction, boxId);
			const total = rows[0]?.total ?? 0;

			return {
				...paged(rows.map(toWireMessage), total, pagination),
				mailbox: {
					id: box.id,
					mailboxNumber: box.mailboxNumber,
					newCount: counts.newCount,
					savedCount: counts.savedCount,
				},
			};
		});
	}

	/**
	 * Moves a message between folders — which is what "mark as read" means here.
	 *
	 * See `voicemail-messages.dto.ts`: there is no `read` column and there should not be, because
	 * the MWI lamp is defined by the NEW count. One fact, one place.
	 */
	async update(
		session: AppSession,
		boxId: string,
		messageId: string,
		patch: UpdateVoicemailMessage,
	): Promise<VoicemailMessageEnvelope> {
		const folder: VoicemailFolder = patch.folder ?? (patch.read === true ? "saved" : "new");
		return await this.move(session, boxId, messageId, folder, reasonForFolder(folder));
	}

	/**
	 * Deletes a message: to the `deleted` folder, or — with `purge` — out of the database.
	 *
	 * The audio object is not unlinked either way. Retention owns the object store's lifecycle and
	 * a control plane that deleted files behind its back would produce rows whose media vanished
	 * for a reason nothing recorded. Purging the ROW is the caller's decision; purging the OBJECT
	 * is a policy.
	 */
	async remove(
		session: AppSession,
		boxId: string,
		messageId: string,
		purge: boolean,
	): Promise<VoicemailMessageDeletion> {
		if (!purge) {
			const moved = await this.move(session, boxId, messageId, "deleted", "message-deleted");
			return { data: { id: moved.data.id, purged: false }, mailbox: moved.mailbox };
		}

		const organizationId = requireActiveOrganizationId(session);
		const result = await this.database.withTenantScope(organizationId, async (transaction) => {
			const box = await requireBox(transaction, boxId);
			await requireMessage(transaction, boxId, messageId);
			await transaction.delete(voicemailMessage).where(eq(voicemailMessage.id, messageId));
			return { box, counts: await readMailboxCounts(transaction, boxId) };
		});

		await this.announce(organizationId, result.box, result.counts, "message-deleted");
		return {
			data: { id: messageId, purged: true },
			mailbox: mailboxSummary(result.box, result.counts),
		};
	}

	/**
	 * Mints a short-lived playback URL.
	 *
	 * The row is read FIRST, inside the tenant scope, for the reason `recordings.service.ts`
	 * records: minting for an id without checking it exists would work — the media route would
	 * refuse — but it would also make this endpoint an oracle for which message ids are real.
	 *
	 * `POST` for a read-shaped operation, deliberately: it CREATES a credential with a lifetime,
	 * and a `GET` that minted one would be prefetched, cached and logged as though it were
	 * idempotent, which it is not in the way that matters.
	 */
	async mintPlaybackLink(
		session: AppSession,
		boxId: string,
		messageId: string,
	): Promise<{ readonly data: VoicemailPlaybackLink }> {
		const organizationId = requireActiveOrganizationId(session);
		const secret = this.env.PBX_VOICEMAIL_URL_SECRET;
		if (secret === undefined) {
			throw new VoicemailSigningUnavailableException();
		}

		await this.database.withTenantScope(organizationId, async (transaction) => {
			await requireBox(transaction, boxId);
			await requireMessage(transaction, boxId, messageId);
		});

		const ttl = this.env.PBX_VOICEMAIL_URL_TTL_SECONDS;
		const expiresAt = Math.floor(Date.now() / 1000) + ttl;
		return {
			data: {
				url: voicemailMediaPath(
					mintVoicemailMediaToken(messageId, organizationId, expiresAt, secret),
				),
				expiresAt: new Date(expiresAt * 1000).toISOString(),
				expiresInSeconds: ttl,
			},
		};
	}

	/**
	 * Verifies a token and opens the object behind it.
	 *
	 * Order: signature, expiry, tenant-scoped row read, containment check, stat, open. Every step
	 * before the last can only ever narrow, so an anonymous request that is not carrying a genuine
	 * token never reaches the filesystem. The RANGE is decided last, after the size is known,
	 * because `bytes=500-` means something different for a 100-byte object than for a 100 MB one.
	 */
	async openSignedMedia(
		token: string,
		rangeHeader?: string | undefined,
	): Promise<ResolvedVoicemailMedia> {
		const secret = this.env.PBX_VOICEMAIL_URL_SECRET;
		if (secret === undefined) {
			// No key configured means no token can be genuine. Never a fallback to unsigned access.
			throw new VoicemailLinkInvalidException();
		}
		const verified = verifyVoicemailMediaToken(token, {
			current: secret,
			previous: this.env.PBX_VOICEMAIL_URL_SECRET_PREVIOUS,
		});
		const payload = verified.payload;
		if (!verified.ok || payload === undefined) {
			throw verified.failure === "expired"
				? new VoicemailLinkExpiredException()
				: new VoicemailLinkInvalidException();
		}

		const row = await this.database.withTenantScope(payload.o, async (transaction) => {
			const found = await transaction
				.select({
					id: voicemailMessage.id,
					objectKey: voicemailMessage.objectKey,
					receivedAt: voicemailMessage.receivedAt,
				})
				.from(voicemailMessage)
				.where(eq(voicemailMessage.id, payload.r))
				.limit(1);
			return found[0];
		});
		// A token for a row that is not visible in the organization it names is indistinguishable
		// from a forged one, and is answered identically.
		if (row === undefined) {
			throw new VoicemailLinkInvalidException();
		}

		const stat = await this.store.head(row.objectKey).catch((cause: unknown) => {
			if (!(cause instanceof ObjectKeyOutsideRootError)) {
				throw cause;
			}
			// Containment refused the key. Answered identically to a forged token — the client must
			// not be able to tell "poisoned column" from "bad signature" — and logged, because only
			// one of the two is worth an investigation.
			logger.error(
				{ messageId: row.id, objectKey: row.objectKey },
				"a voicemail object key resolves outside the media root",
			);
			throw new VoicemailLinkInvalidException();
		});
		if (stat === undefined) {
			throw new VoicemailMediaGoneException();
		}

		return await openMediaResponse(this.store, row.objectKey, stat.sizeBytes, {
			contentType: contentTypeFor(row.objectKey),
			fileName: downloadFileName(row.receivedAt, row.id, row.objectKey),
			rangeHeader,
		});
	}

	// -------------------------------------------------------------------------------------------
	// The broker
	// -------------------------------------------------------------------------------------------

	/**
	 * `rpc.voicemail.v1.list` — the engine's `*97` menu asking what is in a mailbox.
	 *
	 * ## `mailboxNumber` is a claim, not authorisation
	 *
	 * `packages/events` states the rule in the request schema itself, and it is the whole reason
	 * this method is separate from {@link list}: "the responder MUST treat this as a claim to be
	 * checked against the box, not as authorisation — a responder that trusted a request purely
	 * because it arrived on the broker would hand any process on the network any tenant's
	 * messages."
	 *
	 * So the box is loaded by `voicemailBoxId` INSIDE `withTenantScope(orgId)`, and the row's own
	 * `mailboxNumber` must equal the one the request carried. Two independent facts have to line
	 * up: the box belongs to the organization (RLS says so, not a predicate here), and the caller
	 * the engine authenticated is the mailbox they asked for. A request that gets one of them wrong
	 * — a copied box id, a replayed payload with a swapped number, a bug that reused a previous
	 * call's mailbox — is answered `found: false`, never with somebody else's messages.
	 *
	 * ## `found: false` never means "empty"
	 *
	 * The engine's client is built around that distinction and the contract states it twice: an
	 * unreadable mailbox is announced as unavailable, and "you have no messages" told to somebody
	 * who has nine is a worse outcome than any error message. So every refusal here carries a
	 * reason and `found: false`; an empty array is only ever returned with `found: true`.
	 *
	 * ## Why the reply carries `objectKey` and not a URL
	 *
	 * The engine renders it as `object://<objectKey>` and plays it off a mounted filesystem — ARI
	 * has no HTTP media scheme, so a signed URL would be unplayable on the call path. The media
	 * vocabulary stays the engine's; this reply describes the ROWS.
	 */
	async listForBroker(request: BrokerListRequest): Promise<BrokerListReply> {
		return await this.database.withTenantScope(request.orgId, async (transaction) => {
			const found = await transaction
				.select({
					id: voicemailBox.id,
					mailboxNumber: voicemailBox.mailboxNumber,
					enabled: voicemailBox.enabled,
				})
				.from(voicemailBox)
				.where(eq(voicemailBox.id, request.voicemailBoxId))
				.limit(1);
			const box = found[0];
			if (box === undefined) {
				return refuse("no such mailbox in this organization");
			}
			if (box.mailboxNumber !== request.mailboxNumber) {
				// Logged as an ERROR rather than a warning: every legitimate caller has the box id and
				// the number from the same row, so a mismatch is either a bug or an attempt.
				logger.error(
					{
						orgId: request.orgId,
						voicemailBoxId: request.voicemailBoxId,
						claimed: request.mailboxNumber,
					},
					"refusing a voicemail listing whose mailbox number does not match the box",
				);
				return refuse("the mailbox number does not match this mailbox");
			}
			if (!box.enabled) {
				return refuse("this mailbox is disabled");
			}

			const rows = await transaction
				.select({
					id: voicemailMessage.id,
					folder: voicemailMessage.folder,
					objectKey: voicemailMessage.objectKey,
					durationMs: voicemailMessage.durationMs,
					receivedAt: voicemailMessage.receivedAt,
					callerIdNumber: voicemailMessage.callerIdNumber,
					callerIdName: voicemailMessage.callerIdName,
					total: sql<number>`count(*) over ()`.mapWith(Number),
				})
				.from(voicemailMessage)
				.where(
					and(
						eq(voicemailMessage.voicemailBoxId, box.id),
						eq(voicemailMessage.folder, request.folder),
					),
				)
				.orderBy(desc(voicemailMessage.receivedAt), desc(voicemailMessage.id))
				.limit(request.limit);

			const counts = await readMailboxCounts(transaction, box.id);

			return {
				found: true,
				messages: rows.map((row) => ({
					messageId: row.id,
					folder: row.folder,
					objectKey: row.objectKey,
					durationMs: row.durationMs,
					receivedAt: row.receivedAt.toISOString(),
					...(row.callerIdNumber === null ? {} : { callerIdNumber: row.callerIdNumber }),
					...(row.callerIdName === null ? {} : { callerIdName: row.callerIdName }),
				})),
				total: rows[0]?.total ?? 0,
				newCount: counts.newCount,
				savedCount: counts.savedCount,
			};
		});
	}

	// -------------------------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------------------------

	private async move(
		session: AppSession,
		boxId: string,
		messageId: string,
		folder: VoicemailFolder,
		reason: MwiReason,
	): Promise<VoicemailMessageEnvelope> {
		const organizationId = requireActiveOrganizationId(session);
		const result = await this.database.withTenantScope(organizationId, async (transaction) => {
			const box = await requireBox(transaction, boxId);
			await requireMessage(transaction, boxId, messageId);
			const updated = await transaction
				.update(voicemailMessage)
				.set({ folder })
				.where(eq(voicemailMessage.id, messageId))
				.returning();
			return { box, row: updated[0], counts: await readMailboxCounts(transaction, boxId) };
		});

		await this.announce(organizationId, result.box, result.counts, reason);
		return {
			data: toWireMessage(result.row as MessageRow),
			mailbox: mailboxSummary(result.box, result.counts),
		};
	}

	/**
	 * Publishes the mailbox's new counts, after the transaction has committed.
	 *
	 * Best effort and never awaited into the caller's failure path: the write IS durable, and a
	 * broker that refuses the lamp update must not turn a successful "mark as read" into an error.
	 * A box with `mwiEnabled = false` publishes nothing at all — the flag means "this mailbox does
	 * not drive a lamp", and emitting the event anyway would make every subscriber re-implement the
	 * check.
	 */
	private async announce(
		organizationId: string,
		box: BoxRow,
		counts: MailboxCounts,
		reason: MwiReason,
	): Promise<void> {
		if (!box.mwiEnabled) {
			return;
		}
		await this.mwi.publish(
			organizationId,
			box.id,
			box.mailboxNumber,
			box.extensionNumber ?? undefined,
			counts,
			reason,
		);
	}
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export interface WireVoicemailMessage {
	readonly id: string;
	readonly voicemailBoxId: string;
	readonly folder: VoicemailFolder;
	/** Derived from the folder. See `voicemail-messages.dto.ts`. */
	readonly read: boolean;
	readonly callerIdName: string | null;
	readonly callerIdNumber: string | null;
	readonly receivedAt: string;
	readonly durationMs: number;
	readonly sizeBytes: number | null;
	readonly transcription: string | null;
	/**
	 * Which of the four transcription states this message is in.
	 *
	 * Sent ALONGSIDE `transcription` rather than instead of it, because a null transcript is three
	 * different facts and a UI that only had the text could not tell them apart: `disabled` (nobody
	 * tried, and a spinner would be a lie), `pending` (a spinner is exactly right), `failed` (say so,
	 * and stop waiting). `done` with an empty string is also legitimate — a few seconds of silence
	 * transcribes to nothing — and is the case that makes the status load-bearing rather than a
	 * convenience.
	 */
	readonly transcriptionStatus: VoicemailTranscriptionStatus;
	/** When the transcript was written. Null in every state but `done`. */
	readonly transcribedAt: string | null;
	readonly callLegRef: string | null;
}

export interface MailboxSummary {
	readonly id: string;
	readonly mailboxNumber: string;
	readonly newCount: number;
	readonly savedCount: number;
}

export interface VoicemailMessageListEnvelope extends PagedResult<WireVoicemailMessage> {
	/** The counts as they are NOW, so a UI badge never has to add up a page. */
	readonly mailbox: MailboxSummary;
}

export interface VoicemailMessageEnvelope {
	readonly data: WireVoicemailMessage;
	readonly mailbox: MailboxSummary;
}

export interface VoicemailMessageDeletion {
	readonly data: { readonly id: string; readonly purged: boolean };
	readonly mailbox: MailboxSummary;
}

export interface VoicemailPlaybackLink {
	readonly url: string;
	readonly expiresAt: string;
	readonly expiresInSeconds: number;
}

/**
 * What the media route answers with.
 *
 * A {@link MediaResponse} rather than a bare stream, so a partial response can carry its own
 * status, its own `content-length` (the RANGE's length, not the object's) and its `content-range`.
 * See `src/media/http-range.ts` for why this route used to say `accept-ranges: none` and why that
 * was the reason the scrub bar did not work.
 */
export type ResolvedVoicemailMedia = MediaResponse;

/**
 * The RPC request, declared structurally.
 *
 * Not `VoicemailListRequest` imported from `@optimiq-voice/events`: naming the inferred type here
 * drags the package root's `validate.ts` into this app's compilation, which needs
 * `strictNullChecks` to narrow a discriminated union — the same collision
 * `voicemail-consumer.service.ts` records. The controller parses the payload with the real schema
 * and hands the result in, so the contract is still enforced; only the TYPE is local.
 */
export interface BrokerListRequest {
	readonly orgId: string;
	readonly voicemailBoxId: string;
	readonly mailboxNumber: string;
	readonly folder: VoicemailFolder;
	readonly limit: number;
}

export interface BrokerListReply {
	readonly found: boolean;
	readonly messages: readonly {
		readonly messageId: string;
		readonly folder: VoicemailFolder;
		readonly objectKey: string;
		readonly durationMs: number;
		readonly receivedAt: string;
		readonly callerIdNumber?: string;
		readonly callerIdName?: string;
	}[];
	readonly total: number;
	readonly newCount: number;
	readonly savedCount: number;
	readonly reason?: string;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface BoxRow {
	readonly id: string;
	readonly mailboxNumber: string;
	/** The bound extension's number, when there is one — what sipd keys the MWI lamp on. */
	readonly extensionNumber: string | null;
	readonly mwiEnabled: boolean;
}

interface MessageRow {
	readonly id: string;
	readonly voicemailBoxId: string;
	readonly folder: VoicemailFolder;
	readonly callerIdName: string | null;
	readonly callerIdNumber: string | null;
	readonly receivedAt: Date;
	readonly durationMs: number;
	readonly sizeBytes: number | null;
	readonly transcription: string | null;
	readonly transcriptionStatus: VoicemailTranscriptionStatus;
	readonly transcribedAt: Date | null;
	readonly callLegRef: string | null;
}

/** The box, or a 404. RLS has already scoped the read, so "not visible" and "absent" are one case. */
async function requireBox(transaction: PbxDatabaseTransaction, boxId: string): Promise<BoxRow> {
	const found = await transaction
		.select({
			id: voicemailBox.id,
			mailboxNumber: voicemailBox.mailboxNumber,
			extensionNumber: extension.number,
			mwiEnabled: voicemailBox.mwiEnabled,
		})
		.from(voicemailBox)
		.leftJoin(extension, eq(voicemailBox.extensionId, extension.id))
		.where(eq(voicemailBox.id, boxId))
		.limit(1);
	const box = found[0];
	if (box === undefined) {
		throw new VoicemailNotFoundException("voicemail-box", boxId);
	}
	return box;
}

/**
 * The message, proved to be IN this box.
 *
 * The pairing is the point: without it a message id would be a flat namespace, and the URL's box
 * segment would be decoration. With it, a caller has to be entitled to the box to touch anything
 * inside it.
 */
async function requireMessage(
	transaction: PbxDatabaseTransaction,
	boxId: string,
	messageId: string,
): Promise<void> {
	const found = await transaction
		.select({ id: voicemailMessage.id })
		.from(voicemailMessage)
		.where(and(eq(voicemailMessage.id, messageId), eq(voicemailMessage.voicemailBoxId, boxId)))
		.limit(1);
	if (found[0] === undefined) {
		throw new VoicemailNotFoundException("voicemail-message", messageId);
	}
}

function toWireMessage(row: MessageRow): WireVoicemailMessage {
	return {
		id: row.id,
		voicemailBoxId: row.voicemailBoxId,
		folder: row.folder,
		read: isMessageRead(row.folder),
		callerIdName: row.callerIdName,
		callerIdNumber: row.callerIdNumber,
		receivedAt: row.receivedAt.toISOString(),
		durationMs: row.durationMs,
		sizeBytes: row.sizeBytes,
		transcription: row.transcription,
		transcriptionStatus: row.transcriptionStatus,
		transcribedAt: row.transcribedAt?.toISOString() ?? null,
		callLegRef: row.callLegRef,
	};
}

function mailboxSummary(box: BoxRow, counts: MailboxCounts): MailboxSummary {
	return {
		id: box.id,
		mailboxNumber: box.mailboxNumber,
		newCount: counts.newCount,
		savedCount: counts.savedCount,
	};
}

/**
 * Why the counts moved, from where the message landed.
 *
 * Driven off the DESTINATION folder rather than off which control the caller used, because the
 * reason rides in an event a subscriber logs and "message-read" on a move to the trash would be a
 * misleading breadcrumb in exactly the investigation that needs an accurate one. Moving BACK to
 * `new` is `resync` rather than an invented "message-unread": the vocabulary is
 * `packages/events`'s, and a fourth value would have to be added there first.
 */
function reasonForFolder(folder: VoicemailFolder): MwiReason {
	if (folder === "deleted") {
		return "message-deleted";
	}
	return folder === "new" ? "resync" : "message-read";
}

/** A refusal the engine can log. `found: false` with an empty list is never "you have no messages". */
function refuse(reason: string): BrokerListReply {
	return { found: false, messages: [], total: 0, newCount: 0, savedCount: 0, reason };
}

/** Content type from the object key's extension. WAV is what the engine writes today. */
function contentTypeFor(objectKey: string): string {
	const lower = objectKey.toLowerCase();
	if (lower.endsWith(".mp3")) {
		return "audio/mpeg";
	}
	if (lower.endsWith(".ogg") || lower.endsWith(".opus")) {
		return "audio/ogg";
	}
	return "audio/wav";
}

/** A file name a person can find again on their desktop, rather than a UUID. */
function downloadFileName(receivedAt: Date, id: string, objectKey: string): string {
	const stamp = receivedAt.toISOString().slice(0, 19).replace(/[:T]/gu, "-");
	const extension = objectKey.slice(objectKey.lastIndexOf(".") + 1) || "wav";
	return `voicemail-${stamp}-${id.slice(0, 8)}.${extension}`;
}
