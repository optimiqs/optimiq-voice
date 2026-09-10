import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { createEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logging";
import {
	and,
	desc,
	eq,
	extension,
	inArray,
	voicemailBox,
	voicemailMessage,
} from "@optimiq-voice/pbx-db";
import { openMediaResponse } from "../../media/media-response";
import { ObjectKeyOutsideRootError } from "../../storage";
import { actorFromSession, insertAuditLog } from "../shared/audit-log";
import { normalizePagination, paged } from "../shared/pagination";
import { PBX_DATABASE, PBX_ENV, PBX_VOICEMAIL_STORE } from "../shared/pbx.tokens";
import { assertOwnsRow, holdsUnscoped, ownedVoicemailBoxIds } from "../shared/self-ownership";
import { VoicemailEmailService } from "./voicemail-email.service";
import {
	mintVoicemailMediaToken,
	verifyVoicemailMediaToken,
	voicemailContentTypeFor,
	voicemailMediaPath,
} from "./voicemail-media-token";
import { isMessageRead } from "./voicemail-messages.dto";
import { readMailboxCounts, VoicemailMwiPublisher } from "./voicemail-mwi.publisher";
import {
	VoicemailForwardTargetInvalidException,
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
import type {
	ForwardVoicemailMessage,
	UpdateVoicemailMessage,
	VoicemailMessageListQuery,
} from "./voicemail-messages.dto";
import type { MailboxCounts, MwiReason } from "./voicemail-mwi.publisher";
import type { AppSession, Permission } from "@optimiq-voice/auth";
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
		/**
		 * Voicemail-to-email for a mailbox that receives a forwarded message.
		 *
		 * The same service the deposit path calls, rather than a second event published at it: the
		 * notification's whole decision tree — the organization's policy, the box's mode and address,
		 * the `email_sent_at` compare-and-set that makes it once — lives in there, and a forwarded
		 * message is a message arriving in a mailbox by every test that tree applies.
		 */
		@Inject(VoicemailEmailService) private readonly email: VoicemailEmailService,
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
		await this.assertMayReachBox(session, organizationId, boxId, "voicemail.read");
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
			// The folder counts, not a `count(*) over ()` window. The window counts the RETURNED rows,
			// so an offset past the last row returns none and the total collapses to 0 — after which
			// `paged` reports `totalPages: 0` and the pager renders "no messages" for a mailbox
			// holding forty, with no page count to clamp back to. `readMailboxCounts` is already in
			// hand and runs in the same transaction, so it answers the same snapshot the window did.
			const total =
				(folders.includes("new") ? counts.newCount : 0) +
				(folders.includes("saved") ? counts.savedCount : 0);

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
	 *
	 * The reach check is here rather than in {@link move}, because `remove` has already made it with
	 * `voicemail.delete` before it moves a message to the `deleted` folder. Today `voicemail.write`
	 * has no `.own` variant in the registry, so a `user` cannot reach this route at all and the
	 * check is only ever satisfied by the unscoped grant — see the controller header. When
	 * `voicemail.write.own` exists this is the row half that is already in place.
	 */
	async update(
		session: AppSession,
		boxId: string,
		messageId: string,
		patch: UpdateVoicemailMessage,
	): Promise<VoicemailMessageEnvelope> {
		await this.assertMayReachBox(
			session,
			requireActiveOrganizationId(session),
			boxId,
			"voicemail.write",
		);
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
		const scopeOrganizationId = requireActiveOrganizationId(session);
		await this.assertMayReachBox(session, scopeOrganizationId, boxId, "voicemail.delete");

		if (!purge) {
			const moved = await this.move(session, boxId, messageId, "deleted", "message-deleted");
			return { data: { id: moved.data.id, purged: false }, mailbox: moved.mailbox };
		}

		const organizationId = scopeOrganizationId;
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
	 * Forwards or copies a message into another mailbox in the same organization.
	 *
	 * ## One operation, one extra step
	 *
	 * Both modes write the AUDIO and then the ROW into the target box. `forward` then deletes the
	 * source row; `copy` does not. Everything else — the tenancy proof, the object copy, the two
	 * lamps, the notification — is identical, which is why they are one method and one route rather
	 * than two that would have to be kept in step.
	 *
	 * ## The target is proved by TENANCY, not by ownership
	 *
	 * The SOURCE box takes the ordinary `.own` reach check: a self-service user may only forward out
	 * of a mailbox linked to their own extension. The TARGET takes none, deliberately — forwarding a
	 * message to a colleague is the entire point of the feature, and a user who could only forward
	 * into boxes they already own could only forward to themselves. What the target does get is the
	 * tenant boundary: `requireBox` runs inside `withTenantScope`, so a box id from another
	 * organization is invisible to RLS and answers 404, indistinguishable from an id that never
	 * existed.
	 *
	 * ## The object goes first, and the row failing reaps it
	 *
	 * The same order `branding-logo-upload.service.ts` sets out, for the same reason: an object with
	 * no row is inert and reapable, a row pointing at a missing object is a message that plays as an
	 * error. If the transaction throws, the copy this method wrote is unlinked before the failure is
	 * re-thrown.
	 *
	 * The SOURCE object is never unlinked, even on a forward. Retention owns the object store's
	 * lifecycle here as everywhere else in this file — see {@link remove} — and the copy is a new
	 * object under its own key, so nothing the forward wrote depends on the original surviving.
	 *
	 * ## A recorded introduction is out of scope
	 *
	 * A desk phone's "record your comment, then send" prepends a fresh recording to the forwarded
	 * audio. That needs a recording leg on the call path, which is `apps/engine`'s to own and which
	 * nothing in the control plane can fabricate. The DTO says so too.
	 */
	async forward(
		session: AppSession,
		boxId: string,
		messageId: string,
		input: ForwardVoicemailMessage,
	): Promise<VoicemailForwardResult> {
		const organizationId = requireActiveOrganizationId(session);
		await this.assertMayReachBox(session, organizationId, boxId, "voicemail.write");
		const targetBoxId = input.targetVoicemailBoxId;
		if (targetBoxId === boxId) {
			throw new VoicemailForwardTargetInvalidException();
		}

		const context = await this.database.withTenantScope(organizationId, async (transaction) => ({
			source: await requireBox(transaction, boxId),
			target: await requireBox(transaction, targetBoxId),
			message: await requireMessage(transaction, boxId, messageId),
		}));

		const copyId = createEntityId();
		const objectKey = copiedObjectKey(organizationId, copyId, context.message.objectKey);
		const sizeBytes = await this.copyObject(context.message.objectKey, objectKey);

		// A transcript belongs to the audio, so it travels with it — but only once it EXISTS. A copy
		// carrying `pending` would be a row nothing is coming for: the transcription queue is fed by
		// the deposit path, and no worker is ever handed this message.
		const transcribed = context.message.transcriptionStatus === "done";

		let result: {
			readonly row: MessageRow;
			readonly targetCounts: MailboxCounts;
			readonly sourceCounts: MailboxCounts;
		};
		try {
			result = await this.database.withTenantScope(organizationId, async (transaction) => {
				const inserted = await transaction
					.insert(voicemailMessage)
					.values({
						id: copyId,
						organizationId,
						voicemailBoxId: targetBoxId,
						// Always `new`: to the recipient this is a message that has just arrived, and the
						// folder is what lights their lamp.
						folder: "new",
						callerIdName: context.message.callerIdName,
						callerIdNumber: context.message.callerIdNumber,
						receivedAt: context.message.receivedAt,
						durationMs: context.message.durationMs,
						objectKey,
						sizeBytes,
						transcription: transcribed ? context.message.transcription : null,
						transcriptionStatus: transcribed ? "done" : "disabled",
						transcribedAt: transcribed ? context.message.transcribedAt : null,
						callLegRef: context.message.callLegRef,
					})
					.returning();

				if (input.mode === "forward") {
					await transaction.delete(voicemailMessage).where(eq(voicemailMessage.id, messageId));
				}

				// The ledger gap `E2E-records.md` F9 records, closed for the one message action that
				// moves a recording between two people. `before` names where it came from; `after`
				// names where it went, so "how did my message reach that mailbox" is answerable.
				await insertAuditLog(transaction, {
					organizationId,
					actor: actorFromSession(session),
					action: `voicemail-message.${input.mode}`,
					resourceType: "voicemail_message",
					resourceRef: copyId,
					before: {
						voicemailBoxId: boxId,
						mailboxNumber: context.source.mailboxNumber,
						messageId,
						removed: input.mode === "forward",
					},
					after: {
						voicemailBoxId: targetBoxId,
						mailboxNumber: context.target.mailboxNumber,
						messageId: copyId,
					},
				});

				return {
					row: inserted[0] as MessageRow,
					targetCounts: await readMailboxCounts(transaction, targetBoxId),
					sourceCounts: await readMailboxCounts(transaction, boxId),
				};
			});
		} catch (cause) {
			// The row did not take the new key, so the object it would have named must not survive.
			await this.unlink(objectKey);
			throw cause;
		}

		// Two lamps moved, and only one of them is the caller's. The target gained a NEW message; the
		// source lost one, but only on a forward — a copy leaves it exactly as it was, so publishing
		// for it would be an event claiming a change that did not happen.
		await this.announce(organizationId, context.target, result.targetCounts, "message-left");
		if (input.mode === "forward") {
			await this.announce(organizationId, context.source, result.sourceCounts, "message-deleted");
		}
		await this.notifyTarget(organizationId, targetBoxId, copyId);

		return {
			data: toWireMessage(result.row),
			mailbox: mailboxSummary(context.target, result.targetCounts),
			source: mailboxSummary(context.source, result.sourceCounts),
			mode: input.mode,
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
		await this.assertMayReachBox(session, organizationId, boxId, "voicemail.listen");
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
			contentType: voicemailContentTypeFor(row.objectKey),
			fileName: voicemailDownloadFileName(row.receivedAt, row.id, row.objectKey),
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
				// The folder's real size, not the window over the returned page — the window is capped
				// by `request.limit`, so a mailbox with forty new messages announced twenty.
				total: request.folder === "new" ? counts.newCount : counts.savedCount,
				newCount: counts.newCount,
				savedCount: counts.savedCount,
			};
		});
	}

	// -------------------------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------------------------

	/**
	 * The `.own` narrowing for the message surface — the same seam the box list takes, one level in.
	 *
	 * A `user` holds `voicemail.read.own` / `voicemail.delete.own` / `voicemail.listen.own` and no
	 * unscoped grant, so the route's guard now names the scoped variant (which an unscoped holder
	 * still satisfies). This is the row half: a `.own` holder may only touch messages in a box whose
	 * extension is linked to them. An unscoped holder returns immediately and reaches every box, as
	 * before. The box is proved again inside the tenant scope by `requireBox`, so this adds a reach
	 * check, never replaces the tenancy one.
	 */
	private async assertMayReachBox(
		session: AppSession,
		organizationId: string,
		boxId: string,
		unscoped: Permission,
	): Promise<void> {
		if (holdsUnscoped(session, unscoped)) {
			return;
		}
		const owned = await ownedVoicemailBoxIds(this.database, organizationId, session.user.id);
		assertOwnsRow(
			owned,
			boxId,
			"You hold access to your own voicemail only, and this mailbox is not linked to your account.",
		);
	}

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
	 * Copies one message's audio to a new key, and answers how many bytes landed.
	 *
	 * Buffered rather than piped because {@link ObjectStore.put} takes bytes — the seam has no
	 * streaming write, deliberately (`object-store.ts`), and a voicemail is bounded by the recorder's
	 * own limit rather than being an arbitrary object. The size is taken from what was actually read
	 * and not from the source ROW, so a copy never inherits a `size_bytes` the store disagrees with.
	 */
	private async copyObject(sourceKey: string, targetKey: string): Promise<number> {
		const stat = await this.store.head(sourceKey).catch((cause: unknown) => {
			if (!(cause instanceof ObjectKeyOutsideRootError)) {
				throw cause;
			}
			logger.error(
				{ objectKey: sourceKey },
				"a voicemail object key resolves outside the media root",
			);
			throw new VoicemailMediaGoneException();
		});
		if (stat === undefined) {
			// Nothing to forward. A row whose audio is gone is a 410 here for the same reason it is one
			// on the media route: "no such message" and "the recording is gone" are different facts.
			throw new VoicemailMediaGoneException();
		}

		const chunks: Buffer[] = [];
		for await (const chunk of await this.store.getStream(sourceKey)) {
			chunks.push(Buffer.from(chunk as Buffer));
		}
		const bytes = Buffer.concat(chunks);
		await this.store.put(targetKey, bytes, {
			contentType: voicemailContentTypeFor(sourceKey),
		});
		return bytes.byteLength;
	}

	private async unlink(objectKey: string): Promise<void> {
		await this.store.delete(objectKey).catch((cause: unknown) => {
			logger.error({ objectKey, cause }, "could not unlink a forwarded voicemail object");
		});
	}

	/**
	 * Voicemail-to-email for the mailbox that received the copy.
	 *
	 * Best-effort and after the commit, on exactly the terms the deposit path uses: the row IS
	 * filed, and a relay that is down must not turn a successful forward into an error.
	 * {@link VoicemailEmailService.notify} does not throw — every refusal is a named outcome — so
	 * this only records the one that is worth a line.
	 */
	private async notifyTarget(
		organizationId: string,
		mailboxId: string,
		messageId: string,
	): Promise<void> {
		const outcome = await this.email.notify(organizationId, mailboxId, messageId);
		if (outcome.outcome === "failed") {
			logger.warn(
				{ organizationId, mailboxId, messageId },
				"a forwarded voicemail was filed but its notification could not be sent",
			);
		}
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

/**
 * What a forward or a copy answers with.
 *
 * BOTH mailboxes' counts, not just the target's: a forward changes two lamps, and a UI that was
 * handed only the destination's numbers would leave the badge on the box the user is looking at
 * showing a message that is no longer in it.
 */
export interface VoicemailForwardResult {
	/** The copy, as it now sits in the target mailbox. */
	readonly data: WireVoicemailMessage;
	/** The TARGET box's counts after the operation. */
	readonly mailbox: MailboxSummary;
	/** The SOURCE box's counts after the operation — unchanged on a copy. */
	readonly source: MailboxSummary;
	readonly mode: "forward" | "copy";
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

/**
 * The same row plus where its audio is.
 *
 * `objectKey` is separated out rather than folded into {@link MessageRow} because the list query
 * deliberately does not read it: the browser never receives a store key — playback goes through a
 * signed link — and a column that is not selected cannot be leaked by a `toWireMessage` that
 * forgets to drop it. The forward path is the one caller that needs the key, and it asks for it.
 */
interface StoredMessageRow extends MessageRow {
	readonly objectKey: string;
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
): Promise<StoredMessageRow> {
	const found = await transaction
		.select({
			id: voicemailMessage.id,
			voicemailBoxId: voicemailMessage.voicemailBoxId,
			objectKey: voicemailMessage.objectKey,
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
		})
		.from(voicemailMessage)
		.where(and(eq(voicemailMessage.id, messageId), eq(voicemailMessage.voicemailBoxId, boxId)))
		.limit(1);
	const row = found[0];
	if (row === undefined) {
		throw new VoicemailNotFoundException("voicemail-message", messageId);
	}
	return row;
}

/**
 * Where a forwarded copy's audio lives: a key this server minted, under the tenant's own prefix.
 *
 * The same shape the deposit path writes (`<organizationId>/<messageId>.<ext>`), so an operator
 * looking at the store cannot tell a forwarded message from a deposited one — which is right, it IS
 * one. Every segment but the extension is a UUID this process created, so the containment check in
 * `ObjectStore.put` has nothing to escape with; the extension is carried from the source key and
 * falls back to `wav` when it has none.
 */
function copiedObjectKey(organizationId: string, messageId: string, sourceKey: string): string {
	const dot = sourceKey.lastIndexOf(".");
	const slash = sourceKey.lastIndexOf("/");
	const extension = dot > slash && dot < sourceKey.length - 1 ? sourceKey.slice(dot + 1) : "wav";
	return `${organizationId}/${messageId}.${extension}`;
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

/** A file name a person can find again on their desktop, rather than a UUID. */
function voicemailDownloadFileName(receivedAt: Date, id: string, objectKey: string): string {
	const stamp = receivedAt.toISOString().slice(0, 19).replace(/[:T]/gu, "-");
	const extension = objectKey.slice(objectKey.lastIndexOf(".") + 1) || "wav";
	return `voicemail-${stamp}-${id.slice(0, 8)}.${extension}`;
}
