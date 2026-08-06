import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { createEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logger";
import { and, asc, eq, ilike, mohClass, or, prompt, sql } from "@optimiq-voice/pbx-db";
import { openMediaResponse } from "../../media/media-response";
import { contentTypeForKey } from "../media/media-audio";
import {
	buildObjectKey,
	deleteMediaObject,
	mediaObjectSize,
	resolveMediaObjectPath,
	writeMediaObject,
} from "../media/media-storage";
import { mediaPathFor, mintMediaToken, verifyMediaToken } from "../media/media-token";
import { readUploadedAudio } from "../media/media-upload";
import {
	MediaGoneException,
	MediaLinkExpiredException,
	MediaLinkInvalidException,
	MediaNotFoundException,
	MediaSigningUnavailableException,
	MediaUploadRejectedException,
} from "../media/media.errors";
import { actorFromSession } from "../shared/audit-log";
import { parseDto } from "../shared/dto";
import { normalizePagination, paged } from "../shared/pagination";
import { toWireDiagnostic } from "../shared/pbx.errors";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME, PBX_ENV } from "../shared/pbx.tokens";
import { uploadPromptFieldsDto } from "./prompts.dto";
import { PROMPT_RESOURCE } from "./prompts.resource";
import type { MediaResponse } from "../../media/media-response";
import type { MultipartRequest, UploadedAudio } from "../media/media-upload";
import type { PagedResult } from "../shared/pagination";
import type { PbxEnv } from "../shared/pbx-env";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { WireDiagnostic } from "../shared/pbx.errors";
import type { PromptListQuery, UpdatePrompt } from "./prompts.dto";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient, PbxDatabaseTransaction, PromptKind } from "@optimiq-voice/pbx-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * The media library: uploading audio, listing it, serving it back, deleting it.
 *
 * ## Two seams, deliberately, and the rule for which one a method uses
 *
 * This service holds BOTH the Effect repository runtime and the raw `PbxDatabaseClient`, which no
 * other slice in the area does. The split is not convenience:
 *
 * - **Writes go through the repository.** `create`, `update` and `remove` get the reference guard
 *   (eight foreign keys, all `on delete set null` — see `prompts.resource.ts`), the typed
 *   404/409 failures the whole area answers with, and the tenant transaction. `prompt` is not a
 *   routing table, so `recompileIfNeeded` is a no-op and nothing is republished; the guard is what
 *   we are there for.
 * - **Reads that the repository cannot express go direct.** `list` filters on `kind` and
 *   `mohClassId`, which `PbxResource` has no vocabulary for, and the media route looks a row up by
 *   id inside an organization named by a TOKEN rather than by a session. Widening the descriptor
 *   to carry arbitrary predicates would make every other slice pay for this one's shape.
 *
 * Both paths run inside `withTenantScope`, so RLS is the filter in both and neither carries an
 * `organization_id` predicate.
 *
 * ## The order of operations on upload, and why the object is written FIRST
 *
 * ```text
 * validate multipart + magic bytes   (nothing has happened yet)
 * mint the row id                     (so the object key is final before either half exists)
 * write the object                    (a file with no row: an orphan, findable by prefix)
 * insert the row                      (a row with no file: a 410 on play, and unrecoverable)
 * on insert failure -> unlink         (best effort; the orphan is the fallback)
 * ```
 *
 * The two failure modes are not symmetric, which is what decides the order. A FILE WITHOUT A ROW is
 * inert: nothing references it, nothing serves it, and it is one `find` away from being cleaned up.
 * A ROW WITHOUT A FILE is a library entry an admin can point an IVR at, that passes every check,
 * and that plays silence to a caller. So the recoverable failure is the one we take, and the insert
 * failure unlinks on the way out to make even that one rare.
 */
@Injectable()
export class PromptsService {
	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(PBX_EFFECT_RUNTIME) private readonly runtime: PbxRepositoryRuntime,
	) {}

	// -------------------------------------------------------------------------------------------
	// Reads
	// -------------------------------------------------------------------------------------------

	/**
	 * One page of the library.
	 *
	 * An absent `kind` means `prompt` and `greeting` — everything a prompt PICKER can offer — and
	 * never MOH files, which are reached through their class. See `prompts.dto.ts`.
	 */
	async list(
		session: AppSession,
		query: PromptListQuery,
	): Promise<PagedResult<Record<string, unknown>>> {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		const kinds: readonly PromptKind[] =
			query.kind === undefined ? (["prompt", "greeting"] as const) : ([query.kind] as const);

		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const clauses = [
				kinds.length === 1
					? eq(prompt.kind, kinds[0] as PromptKind)
					: or(...kinds.map((kind) => eq(prompt.kind, kind))),
			];
			if (query.mohClassId !== undefined) {
				clauses.push(eq(prompt.mohClassId, query.mohClassId));
			}
			if (query.search !== undefined) {
				// `%` and `_` are `ilike` wildcards; a user searching for "hold_music" means the literal.
				const escaped = query.search.replace(/[\\%_]/gu, (match) => `\\${match}`);
				clauses.push(
					or(ilike(prompt.name, `%${escaped}%`), ilike(prompt.objectKey, `%${escaped}%`)) as never,
				);
			}

			const rows = await transaction
				.select({ row: prompt, total: sql<number>`count(*) over ()`.mapWith(Number) })
				.from(prompt)
				.where(and(...clauses))
				.orderBy(asc(prompt.name), asc(prompt.id))
				.limit(pagination.limit)
				.offset(pagination.offset);

			return paged(
				rows.map((entry) => entry.row as unknown as Record<string, unknown>),
				rows[0]?.total ?? 0,
				pagination,
			);
		});
	}

	/** Every file in one MOH class, in play order (by name), with the class proved to exist first. */
	async listForMohClass(
		session: AppSession,
		mohClassId: string,
	): Promise<{ readonly data: readonly Record<string, unknown>[] }> {
		const organizationId = requireActiveOrganizationId(session);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			await requireMohClass(transaction, mohClassId);
			const rows = await transaction
				.select()
				.from(prompt)
				.where(and(eq(prompt.mohClassId, mohClassId), eq(prompt.kind, "moh")))
				.orderBy(asc(prompt.name), asc(prompt.id));
			return { data: rows as unknown as Record<string, unknown>[] };
		});
	}

	async get(session: AppSession, id: string): Promise<{ readonly data: Record<string, unknown> }> {
		const organizationId = requireActiveOrganizationId(session);
		return {
			data: await runEffect(this.runtime, (repository) =>
				repository.get(organizationId, PROMPT_RESOURCE, id),
			),
		};
	}

	// -------------------------------------------------------------------------------------------
	// Writes
	// -------------------------------------------------------------------------------------------

	/**
	 * Stores an uploaded file as a library prompt.
	 *
	 * `mohClassId` is taken from the ARGUMENT rather than from the form when the upload came in
	 * through `/moh-classes/:id/files`, so the URL is the authority on which class a file joins and
	 * a form field cannot contradict it. The class is proved to exist in the tenant before a byte
	 * is written — an upload into a class that is not there must not leave an object behind.
	 */
	async upload(
		session: AppSession,
		request: MultipartRequest,
		options: { readonly kind: PromptKind; readonly mohClassId?: string } = { kind: "prompt" },
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = requireActiveOrganizationId(session);

		// The stream is read FIRST, because the text parts of a multipart body arrive interleaved
		// with the file and there is no way to see one without consuming the other. That ordering
		// has a consequence worth stating: a class id that turns out not to exist is discovered
		// AFTER the bytes have been buffered, so the cap is what bounds the cost of a bad request,
		// not the class check. The cap is enforced during the read, so that bound holds.
		const audio = await readUploadedAudio(request, this.env.PBX_MEDIA_MAX_UPLOAD_BYTES);
		const fields = parseDto(uploadPromptFieldsDto, audio.fields);
		const mohClassId = options.mohClassId ?? fields.mohClassId;

		if (options.kind === "moh" && mohClassId === undefined) {
			throw new MediaUploadRejectedException(
				"An MOH file has to name the class it belongs to.",
				"mohClassId",
			);
		}
		if (mohClassId !== undefined) {
			await this.database.withTenantScope(organizationId, async (transaction) => {
				await requireMohClass(transaction, mohClassId);
			});
		}

		// The id is minted here rather than by the repository, because the OBJECT KEY contains it
		// and the object is written before the row. `pbx.repository.ts` accepts an `id` in the
		// values it is handed and overwrites it with its own — so the key would name a file that
		// does not exist. Passing the id in explicitly is not possible through that seam, which is
		// why this path inserts the key and lets the repository mint the row id, and why the key
		// uses its OWN uuid rather than the row's. They are both v7 and both unique; the key's job
		// is to address a file, not to be a foreign key.
		const fileId = createEntityId();
		const objectKey = buildObjectKey(
			options.kind === "moh" ? "moh" : "prompt",
			organizationId,
			mohClassId === undefined ? [] : [mohClassId],
			fileId,
			audio.format.extension,
		);

		await writeMediaObject(this.env.PBX_MEDIA_OBJECT_ROOT, objectKey, audio.bytes);

		try {
			const result = await runEffect(this.runtime, (repository) =>
				repository.create(
					organizationId,
					PROMPT_RESOURCE,
					{
						name: fields.name ?? audio.fileName,
						kind: options.kind,
						mohClassId: mohClassId ?? null,
						objectKey,
						contentType: audio.format.contentType,
						durationMs: audio.durationMs ?? null,
						sizeBytes: audio.sizeBytes,
						checksum: checksumOf(audio),
						...(fields.language === undefined ? {} : { language: fields.language }),
					},
					actorFromSession(session),
				),
			);
			return {
				data: result.row,
				// The compiler's warnings (always empty here — `prompt` is not a routing table) plus
				// the sniffer's, so "this will play, but it costs a resample" reaches the admin in the
				// same envelope field a form already renders.
				warnings: [...result.warnings.map(toWireDiagnostic), ...audio.warnings.map(formatWarning)],
			};
		} catch (cause) {
			// The insert failed — a duplicate name, a compile failure, a lost connection. Unlink so
			// the store does not accumulate objects nothing can name. Best effort by design: the
			// orphan is inert, and turning a failed insert into a failed unlink would replace an
			// actionable error with a confusing one.
			await deleteMediaObject(this.env.PBX_MEDIA_OBJECT_ROOT, objectKey).catch(() => undefined);
			throw cause;
		}
	}

	/** Edits a prompt's metadata. Never its audio — see `prompts.dto.ts`. */
	async update(
		session: AppSession,
		id: string,
		patch: UpdatePrompt,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = requireActiveOrganizationId(session);
		const result = await runEffect(this.runtime, (repository) =>
			repository.update(
				organizationId,
				PROMPT_RESOURCE,
				id,
				patch as Record<string, unknown>,
				actorFromSession(session),
			),
		);
		return { data: result.row, warnings: result.warnings.map(toWireDiagnostic) };
	}

	/**
	 * Deletes a prompt: the row first, then the object.
	 *
	 * The reverse of the upload order, and for the same reason read backwards. The ROW is what the
	 * reference guard protects and what makes the file reachable, so removing it first means a
	 * failure between the two steps leaves an orphaned FILE — inert — rather than a row pointing at
	 * nothing. The object key is read before the delete because the row is gone afterwards.
	 */
	async remove(
		session: AppSession,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const organizationId = requireActiveOrganizationId(session);
		const objectKey = await this.database.withTenantScope(organizationId, async (transaction) => {
			const found = await transaction
				.select({ objectKey: prompt.objectKey })
				.from(prompt)
				.where(eq(prompt.id, id))
				.limit(1);
			return found[0]?.objectKey;
		});

		const result = await runEffect(this.runtime, (repository) =>
			repository.remove(organizationId, PROMPT_RESOURCE, id, actorFromSession(session)),
		);

		if (objectKey !== undefined) {
			await this.unlinkObjects([objectKey], `prompt ${id} deleted`);
		}
		return { data: result.row, warnings: result.warnings.map(toWireDiagnostic) };
	}

	/**
	 * Removes one file from an MOH class, proving the pairing first.
	 *
	 * The pairing is the point: without it a file id would be a flat namespace and the URL's class
	 * segment would be decoration. With it, a caller has to be entitled to the class to touch
	 * anything inside it — the rule `voicemail-messages.service.ts` states for a message and its
	 * box. RLS already scopes both, so this is not a tenancy check; it is a "the URL means what it
	 * says" check, and it is what turns a copied id into a 404 instead of a deletion.
	 */
	async removeMohFile(
		session: AppSession,
		mohClassId: string,
		fileId: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const organizationId = requireActiveOrganizationId(session);
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await requireMohClass(transaction, mohClassId);
			const found = await transaction
				.select({ id: prompt.id })
				.from(prompt)
				.where(and(eq(prompt.id, fileId), eq(prompt.mohClassId, mohClassId)))
				.limit(1);
			if (found[0] === undefined) {
				throw new MediaNotFoundException("moh-file", fileId);
			}
		});
		return await this.remove(session, fileId);
	}

	/**
	 * The object keys of every file in an MOH class.
	 *
	 * Read before the class row is deleted, because `prompt.moh_class_id` is `on delete cascade`:
	 * the rows go with the class, and after that nothing names the objects. See
	 * `moh-classes.service.ts` for why this is a read here and an unlink there rather than one
	 * operation.
	 */
	async readMohClassObjectKeys(
		organizationId: string,
		mohClassId: string,
	): Promise<readonly string[]> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ objectKey: prompt.objectKey })
				.from(prompt)
				.where(and(eq(prompt.mohClassId, mohClassId), eq(prompt.kind, "moh")));
			return rows.map((row) => row.objectKey);
		});
	}

	/**
	 * Unlinks stored objects, best effort, logging each failure.
	 *
	 * Never throws: it is always called AFTER the write that made the objects unreachable has
	 * committed, so a failure here is a leaked file — an operations problem with a log line — and
	 * turning it into a 500 would tell the caller their delete failed when it did not.
	 */
	async unlinkObjects(objectKeys: readonly string[], reason: string): Promise<void> {
		for (const objectKey of objectKeys) {
			await deleteMediaObject(this.env.PBX_MEDIA_OBJECT_ROOT, objectKey).catch((cause: unknown) => {
				logger.error("could not unlink a media object", { objectKey, reason, cause });
			});
		}
	}

	// -------------------------------------------------------------------------------------------
	// Playback
	// -------------------------------------------------------------------------------------------

	/**
	 * Mints a short-lived preview link for a stored prompt.
	 *
	 * The row is read FIRST, inside the tenant scope, for the reason `recordings.service.ts`
	 * records: minting for an id without checking it exists would work — the media route would
	 * refuse — but it would also make this endpoint an oracle for which prompt ids are real.
	 */
	async mintPlaybackLink(
		session: AppSession,
		id: string,
	): Promise<{ readonly data: MediaPlaybackLink }> {
		const organizationId = requireActiveOrganizationId(session);
		const secret = this.env.PBX_VOICEMAIL_URL_SECRET;
		if (secret === undefined) {
			throw new MediaSigningUnavailableException();
		}

		await this.database.withTenantScope(organizationId, async (transaction) => {
			const found = await transaction
				.select({ id: prompt.id })
				.from(prompt)
				.where(eq(prompt.id, id))
				.limit(1);
			if (found[0] === undefined) {
				throw new MediaNotFoundException("prompt", id);
			}
		});

		const ttl = this.env.PBX_VOICEMAIL_URL_TTL_SECONDS;
		const expiresAt = Math.floor(Date.now() / 1000) + ttl;
		return {
			data: {
				url: mediaPathFor(
					"prompt",
					mintMediaToken("prompt", id, organizationId, expiresAt, secret),
				),
				expiresAt: new Date(expiresAt * 1000).toISOString(),
				expiresInSeconds: ttl,
			},
		};
	}

	/**
	 * Verifies a token and opens the object behind it, honouring one `Range`.
	 *
	 * Order: signature, expiry, tenant-scoped row read, containment check, stat, open. Every step
	 * before the last can only ever narrow, so an anonymous request that is not carrying a genuine
	 * token never reaches the filesystem. The range is decided LAST, after the size is known,
	 * because `bytes=500-` means something different for a 100-byte object than for a 100 MB one.
	 */
	async openSignedMedia(token: string, rangeHeader: string | undefined): Promise<MediaResponse> {
		const secret = this.env.PBX_VOICEMAIL_URL_SECRET;
		if (secret === undefined) {
			// No key configured means no token can be genuine. Never a fallback to unsigned access.
			throw new MediaLinkInvalidException();
		}
		const verified = verifyMediaToken("prompt", token, {
			current: secret,
			previous: this.env.PBX_VOICEMAIL_URL_SECRET_PREVIOUS,
		});
		const payload = verified.payload;
		if (!verified.ok || payload === undefined) {
			throw verified.failure === "expired"
				? new MediaLinkExpiredException()
				: new MediaLinkInvalidException();
		}

		const row = await this.database.withTenantScope(payload.o, async (transaction) => {
			const found = await transaction
				.select({ id: prompt.id, name: prompt.name, objectKey: prompt.objectKey })
				.from(prompt)
				.where(eq(prompt.id, payload.r))
				.limit(1);
			return found[0];
		});
		// A token for a row that is not visible in the organization it names is indistinguishable
		// from a forged one, and is answered identically.
		if (row === undefined) {
			throw new MediaLinkInvalidException();
		}

		return await openStoredObject(this.env.PBX_MEDIA_OBJECT_ROOT, row.objectKey, {
			fileName: downloadFileName(row.name, row.objectKey),
			rangeHeader,
			subject: { kind: "prompt", id: row.id },
		});
	}
}

// ---------------------------------------------------------------------------------------------
// Shared with the greetings service
// ---------------------------------------------------------------------------------------------

export interface MediaPlaybackLink {
	readonly url: string;
	readonly expiresAt: string;
	readonly expiresInSeconds: number;
}

/**
 * Resolves a key under the object root and opens it for one request.
 *
 * Shared by the prompt route and the greeting route because the two differ only in which table the
 * key came out of, and a second copy is a second chance to forget the containment check. The
 * containment check is the one that answers a different question from the signature: the signature
 * establishes that the CALLER may read this row, and this establishes that the KEY — which came out
 * of a database column — addresses a file inside the media root and not `../../etc/passwd`.
 */
export async function openStoredObject(
	root: string,
	objectKey: string,
	options: {
		readonly fileName: string;
		readonly rangeHeader: string | undefined;
		readonly subject: { readonly kind: string; readonly id: string };
	},
): Promise<MediaResponse> {
	const path = resolveMediaObjectPath(root, objectKey);
	if (path === undefined) {
		logger.error("a media object key resolves outside the object root", {
			kind: options.subject.kind,
			id: options.subject.id,
			objectKey,
		});
		throw new MediaLinkInvalidException();
	}

	const sizeBytes = await mediaObjectSize(path);
	if (sizeBytes === undefined) {
		// The row says there is audio and the object store disagrees. A 410 rather than a 404: it
		// existed, and saying so is what lets the UI distinguish the two.
		throw new MediaGoneException();
	}

	return openMediaResponse(path, sizeBytes, {
		contentType: contentTypeForKey(objectKey),
		fileName: options.fileName,
		rangeHeader: options.rangeHeader,
	});
}

/** A file name a person can find again on their desktop, rather than a UUID. */
export function downloadFileName(label: string | null, objectKey: string): string {
	const extension = objectKey.slice(objectKey.lastIndexOf(".") + 1) || "wav";
	const stem = (label ?? "audio")
		.replace(/[^A-Za-z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 64);
	return `${stem === "" ? "audio" : stem}.${extension}`;
}

/**
 * The content hash the schema calls for: de-duplication, and the engine's media cache key.
 *
 * SHA-256 of the exact bytes stored, prefixed with the algorithm so a future change is a new prefix
 * rather than a silent reinterpretation of a hex string.
 */
export function checksumOf(audio: Pick<UploadedAudio, "bytes">): string {
	return `sha256:${createHash("sha256").update(audio.bytes).digest("hex")}`;
}

/** The MOH class, or a 404. RLS has already scoped the read, so absent and invisible are one case. */
export async function requireMohClass(
	transaction: PbxDatabaseTransaction,
	mohClassId: string,
): Promise<void> {
	const found = await transaction
		.select({ id: mohClass.id })
		.from(mohClass)
		.where(eq(mohClass.id, mohClassId))
		.limit(1);
	if (found[0] === undefined) {
		throw new MediaNotFoundException("moh-class", mohClassId);
	}
}

/**
 * One of the sniffer's observations, in the envelope shape a mutation already returns.
 *
 * `severity: "warning"` and a stable `code`, so `apps/web`'s warnings banner renders it beside the
 * compiler's without a second code path. There is no `path`, because the observation is about the
 * FILE rather than about a field of the row.
 */
function formatWarning(message: string): WireDiagnostic {
	return { severity: "warning", code: "media-format", message };
}
