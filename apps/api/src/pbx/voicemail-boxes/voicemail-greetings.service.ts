import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { createEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logging";
import { and, asc, eq, voicemailBox, voicemailGreeting } from "@optimiq-voice/pbx-db";
import { buildObjectKey, deleteMediaObject, writeMediaObject } from "../media/media-storage";
import { mediaPathFor, mintMediaToken, verifyMediaToken } from "../media/media-token";
import { readUploadedAudio } from "../media/media-upload";
import {
	MediaLinkExpiredException,
	MediaLinkInvalidException,
	MediaNotFoundException,
	MediaSigningUnavailableException,
} from "../media/media.errors";
import { downloadFileName, openStoredObject } from "../prompts/prompts.service";
import { compileOnWrite } from "../routing/compile-on-write";
import { RoutingCachePublisher } from "../routing/routing-cache.publisher";
import { parseDto } from "../shared/dto";
import { toWireDiagnostic } from "../shared/pbx.errors";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import { uploadGreetingFieldsDto } from "./voicemail-greetings.dto";
import { VoicemailNotFoundException } from "./voicemail.errors";
import type { MediaResponse } from "../../media/media-response";
import type { MultipartRequest } from "../media/media-upload";
import type { MediaPlaybackLink } from "../prompts/prompts.service";
import type { CompiledWrite } from "../routing/compile-on-write";
import type { PbxEnv } from "../shared/pbx-env";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { UpdateGreeting } from "./voicemail-greetings.dto";
import type { AppSession } from "@optimiq-voice/auth";
import type {
	PbxDatabaseClient,
	PbxDatabaseTransaction,
	VoicemailGreetingKind,
} from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * A mailbox's recorded greetings.
 *
 * ## Why this does NOT go through the Effect repository, even though it must recompile
 *
 * `voicemail_greeting` IS a routing table. `affectsRouting("voicemail_greeting")` is true, the
 * loader reads the whole table, and the compiler embeds the ACTIVE greeting of the winning kind
 * into the mailbox's `leave` node as `object://<objectKey>`. So every write here has to recompile
 * and republish, exactly as the set-PIN endpoint does — and unlike the set-PIN endpoint, it cannot
 * do that by calling `repository.updateChild`.
 *
 * The reason is one index:
 *
 * ```sql
 * create unique index voicemail_greeting_box_kind_active_key
 *   on voicemail_greeting (organization_id, voicemail_box_id, kind) where active;
 * ```
 *
 * At most one greeting per kind may be active, enforced by the database. **Activating a greeting is
 * therefore inherently a two-row write**: clear the incumbent, set the new one. The repository's
 * `updateChild` is one row in one transaction, so doing it with two calls would mean two
 * transactions, two recompiles, and a published artifact in between in which the mailbox has NO
 * active greeting of that kind — a caller reaching the box during that window hears the
 * deployment-wide announcement instead of the tenant's recording. Doing it in the other order does
 * not help: the second statement would violate the index and the first would already have
 * committed.
 *
 * So this service opens its own tenant transaction, does both statements, and runs the same
 * `compileOnWrite` the repository runs, inside the same transaction, before the commit. What it
 * gains is atomicity; what it gives up is the repository's generic guards, and it gives up nothing
 * by doing so — a greeting has no destination trio and nothing points at it as a foreign key.
 *
 * The publish is fired after the commit, from `RoutingCachePublisher` directly, with its own
 * `catch`: the same seam and the same rule `pbx.module.ts` states — the mutation already committed,
 * and a broker that refuses the artifact must not turn a successful save into an error.
 */
@Injectable()
export class VoicemailGreetingsService {
	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(RoutingCachePublisher) private readonly publisher: RoutingCachePublisher,
	) {}

	/** Every greeting on a box, active ones first, then by kind. */
	async list(
		session: AppSession,
		boxId: string,
	): Promise<{ readonly data: readonly Record<string, unknown>[] }> {
		const organizationId = requireActiveOrganizationId(session);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			await requireBox(transaction, boxId);
			const rows = await transaction
				.select()
				.from(voicemailGreeting)
				.where(eq(voicemailGreeting.voicemailBoxId, boxId))
				.orderBy(asc(voicemailGreeting.kind), asc(voicemailGreeting.id));
			return { data: rows as unknown as Record<string, unknown>[] };
		});
	}

	/**
	 * Uploads a greeting, and by default makes it the active one for its kind.
	 *
	 * The whole thing — the incumbent's deactivation, the insert, and the recompile — is one
	 * transaction, so the artifact the engine ends up holding either has the new greeting or has
	 * the old one, and never has neither.
	 */
	async upload(
		session: AppSession,
		boxId: string,
		request: MultipartRequest,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = requireActiveOrganizationId(session);

		// The box is proved BEFORE the stream is read, unlike the prompt path: a greeting names its
		// mailbox in the URL, so the check costs one round trip and saves buffering a file into a
		// mailbox that does not exist.
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await requireBox(transaction, boxId);
		});

		const audio = await readUploadedAudio(request, this.env.PBX_MEDIA_MAX_UPLOAD_BYTES);
		const fields = parseDto(uploadGreetingFieldsDto, audio.fields);
		const kind: VoicemailGreetingKind = fields.kind ?? "unavailable";
		const active = fields.active ?? true;

		const greetingId = createEntityId();
		const objectKey = buildObjectKey(
			"greeting",
			organizationId,
			[boxId],
			greetingId,
			audio.format.extension,
		);
		// The object first, for the reason `prompts.service.ts` sets out: a file with no row is
		// inert, a row with no file plays silence at a caller.
		await writeMediaObject(this.env.PBX_MEDIA_OBJECT_ROOT, objectKey, audio.bytes);

		try {
			const written = await this.write(organizationId, async (transaction) => {
				if (active) {
					await deactivate(transaction, boxId, kind);
				}
				const inserted = await transaction
					.insert(voicemailGreeting)
					.values({
						id: greetingId,
						organizationId,
						voicemailBoxId: boxId,
						kind,
						label: fields.label ?? audio.fileName,
						objectKey,
						durationMs: audio.durationMs ?? null,
						active,
					})
					.returning();
				return inserted[0] as unknown as Record<string, unknown>;
			});

			return {
				data: written.row,
				warnings: [
					...written.compiled.warnings.map(toWireDiagnostic),
					...audio.warnings.map((message) => ({
						severity: "warning" as const,
						code: "media-format",
						message,
					})),
				],
			};
		} catch (cause) {
			await this.unlink(objectKey);
			throw cause;
		}
	}

	/**
	 * Makes an existing greeting the active one for its kind.
	 *
	 * The kind comes off the ROW, never off the request: a greeting occupies the slot it was
	 * recorded for, and letting a caller nominate a different one would activate a spoken NAME as
	 * an unavailable greeting. See `voicemail-greetings.dto.ts`.
	 */
	async activate(
		session: AppSession,
		boxId: string,
		greetingId: string,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = requireActiveOrganizationId(session);
		const written = await this.write(organizationId, async (transaction) => {
			await requireBox(transaction, boxId);
			const row = await requireGreeting(transaction, boxId, greetingId);
			await deactivate(transaction, boxId, row.kind);
			const updated = await transaction
				.update(voicemailGreeting)
				.set({ active: true })
				.where(eq(voicemailGreeting.id, greetingId))
				.returning();
			return updated[0] as unknown as Record<string, unknown>;
		});
		return {
			data: written.row,
			warnings: written.compiled.warnings.map(toWireDiagnostic),
		};
	}

	/**
	 * Clears the active greeting for a kind without deleting the recording.
	 *
	 * The counterpart to {@link activate}, and the reason `temporary` is usable at all: coming back
	 * from holiday means deactivating the temporary greeting, at which point
	 * `VOICEMAIL_LEAVE_GREETING_PRECEDENCE` falls through to `unavailable` and the permanent
	 * recording is heard again — without having had to delete and re-upload anything.
	 */
	async deactivate(
		session: AppSession,
		boxId: string,
		greetingId: string,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = requireActiveOrganizationId(session);
		const written = await this.write(organizationId, async (transaction) => {
			await requireBox(transaction, boxId);
			await requireGreeting(transaction, boxId, greetingId);
			const updated = await transaction
				.update(voicemailGreeting)
				.set({ active: false })
				.where(eq(voicemailGreeting.id, greetingId))
				.returning();
			return updated[0] as unknown as Record<string, unknown>;
		});
		return {
			data: written.row,
			warnings: written.compiled.warnings.map(toWireDiagnostic),
		};
	}

	/** Edits the label. Not a routing input, but it recompiles anyway — see {@link write}. */
	async update(
		session: AppSession,
		boxId: string,
		greetingId: string,
		patch: UpdateGreeting,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const organizationId = requireActiveOrganizationId(session);
		const written = await this.write(organizationId, async (transaction) => {
			await requireBox(transaction, boxId);
			await requireGreeting(transaction, boxId, greetingId);
			const updated = await transaction
				.update(voicemailGreeting)
				.set(patch)
				.where(eq(voicemailGreeting.id, greetingId))
				.returning();
			return updated[0] as unknown as Record<string, unknown>;
		});
		return {
			data: written.row,
			warnings: written.compiled.warnings.map(toWireDiagnostic),
		};
	}

	/** Deletes a greeting: the row inside the transaction, the object after the commit. */
	async remove(
		session: AppSession,
		boxId: string,
		greetingId: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const organizationId = requireActiveOrganizationId(session);
		const written = await this.write(organizationId, async (transaction) => {
			await requireBox(transaction, boxId);
			const row = await requireGreeting(transaction, boxId, greetingId);
			await transaction.delete(voicemailGreeting).where(eq(voicemailGreeting.id, greetingId));
			return { id: greetingId, objectKey: row.objectKey } as unknown as Record<string, unknown>;
		});

		await this.unlink(String(written.row.objectKey));
		return {
			data: { id: greetingId },
			warnings: written.compiled.warnings.map(toWireDiagnostic),
		};
	}

	// -------------------------------------------------------------------------------------------
	// Playback
	// -------------------------------------------------------------------------------------------

	/** Mints a short-lived preview link. The row is read first; see `prompts.service.ts`. */
	async mintPlaybackLink(
		session: AppSession,
		boxId: string,
		greetingId: string,
	): Promise<{ readonly data: MediaPlaybackLink }> {
		const organizationId = requireActiveOrganizationId(session);
		const secret = this.env.PBX_VOICEMAIL_URL_SECRET;
		if (secret === undefined) {
			throw new MediaSigningUnavailableException();
		}

		await this.database.withTenantScope(organizationId, async (transaction) => {
			await requireBox(transaction, boxId);
			await requireGreeting(transaction, boxId, greetingId);
		});

		const ttl = this.env.PBX_VOICEMAIL_URL_TTL_SECONDS;
		const expiresAt = Math.floor(Date.now() / 1000) + ttl;
		return {
			data: {
				url: mediaPathFor(
					"greeting",
					mintMediaToken("greeting", greetingId, organizationId, expiresAt, secret),
				),
				expiresAt: new Date(expiresAt * 1000).toISOString(),
				expiresInSeconds: ttl,
			},
		};
	}

	/** Verifies a token and opens the greeting behind it, honouring one `Range`. */
	async openSignedMedia(token: string, rangeHeader: string | undefined): Promise<MediaResponse> {
		const secret = this.env.PBX_VOICEMAIL_URL_SECRET;
		if (secret === undefined) {
			throw new MediaLinkInvalidException();
		}
		const verified = verifyMediaToken("greeting", token, {
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
				.select({
					id: voicemailGreeting.id,
					label: voicemailGreeting.label,
					kind: voicemailGreeting.kind,
					objectKey: voicemailGreeting.objectKey,
				})
				.from(voicemailGreeting)
				.where(eq(voicemailGreeting.id, payload.r))
				.limit(1);
			return found[0];
		});
		if (row === undefined) {
			throw new MediaLinkInvalidException();
		}

		return await openStoredObject(this.env.PBX_MEDIA_OBJECT_ROOT, row.objectKey, {
			fileName: downloadFileName(row.label ?? row.kind, row.objectKey),
			rangeHeader,
			subject: { kind: "voicemail-greeting", id: row.id },
		});
	}

	// -------------------------------------------------------------------------------------------
	// The write seam
	// -------------------------------------------------------------------------------------------

	/**
	 * One tenant transaction: the caller's statements, then compile-on-write, then the publish.
	 *
	 * This is `pbx.repository.ts`'s write path, reproduced for the one collection whose writes are
	 * not single-row. The three properties `compile-on-write.ts` documents all still hold, because
	 * they are properties of the ORDERING rather than of the repository:
	 *
	 * - the snapshot the compiler sees includes the uncommitted write (same connection, same
	 *   transaction), so the question answered is "would this be sound AFTER the change";
	 * - an unsound artifact cannot be saved, because `compileOnWrite` throws inside the transaction
	 *   and Postgres rolls the rows back;
	 * - the cache is written only after the commit.
	 *
	 * `RoutingCompileFailure` is an Effect `TaggedError` rather than an `HttpException`, and nothing
	 * here runs it through `runEffect`, so it is translated explicitly — otherwise a compile failure
	 * would surface as an opaque 500 instead of the 422 with diagnostics the rest of the area
	 * answers with.
	 *
	 * Every write recompiles, including a label edit that changes nothing routing reads. That is
	 * deliberate and it is what the repository does too: `isArtifactFresh` compares content hashes,
	 * so a recompile that produced the same `snapshotHash` costs one compile and no KV round trip.
	 * Deciding per-column which edits matter would be a second, hand-maintained copy of what the
	 * hash already answers.
	 */
	private async write(
		organizationId: string,
		work: (transaction: PbxDatabaseTransaction) => Promise<Record<string, unknown>>,
	): Promise<{ readonly row: Record<string, unknown>; readonly compiled: CompiledWrite }> {
		const result = await this.database
			.withTenantScope(organizationId, async (transaction) => {
				const row = await work(transaction);
				const compiled = await compileOnWrite(transaction, organizationId);
				return { row, compiled };
			})
			.catch((cause: unknown) => {
				if (hasHttpTranslation(cause)) {
					throw cause.toHttpException();
				}
				throw cause;
			});

		// Fire-and-forget by design (the mutation already committed), but a bare `void` promise
		// turns NATS's CONNECTION_DRAINING during shutdown into an unhandled rejection that kills
		// the process — the publish must observe its own failure. The rule `pbx.module.ts` states.
		this.publisher
			.publish(result.compiled.cacheKey, result.compiled.artifact)
			.catch((cause: unknown) => {
				logger.error(
					{ err: cause },
					`routing cache publish failed for ${result.compiled.cacheKey}`,
				);
			});

		return result;
	}

	private async unlink(objectKey: string): Promise<void> {
		await deleteMediaObject(this.env.PBX_MEDIA_OBJECT_ROOT, objectKey).catch((cause: unknown) => {
			logger.error({ objectKey, cause }, "could not unlink a greeting's audio");
		});
	}
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Whether a thrown value is one of the area's typed failures, which know their own status. */
function hasHttpTranslation(cause: unknown): cause is { toHttpException: () => Error } {
	return (
		typeof cause === "object" &&
		cause !== null &&
		typeof (cause as { toHttpException?: unknown }).toHttpException === "function"
	);
}

/** The box, or a 404. RLS has already scoped the read, so absent and invisible are one case. */
async function requireBox(transaction: PbxDatabaseTransaction, boxId: string): Promise<void> {
	const found = await transaction
		.select({ id: voicemailBox.id })
		.from(voicemailBox)
		.where(eq(voicemailBox.id, boxId))
		.limit(1);
	if (found[0] === undefined) {
		throw new VoicemailNotFoundException("voicemail-box", boxId);
	}
}

/** The greeting, proved to be ON this box. The pairing rule `voicemail-messages.service.ts` states. */
async function requireGreeting(
	transaction: PbxDatabaseTransaction,
	boxId: string,
	greetingId: string,
): Promise<{ readonly kind: VoicemailGreetingKind; readonly objectKey: string }> {
	const found = await transaction
		.select({ kind: voicemailGreeting.kind, objectKey: voicemailGreeting.objectKey })
		.from(voicemailGreeting)
		.where(and(eq(voicemailGreeting.id, greetingId), eq(voicemailGreeting.voicemailBoxId, boxId)))
		.limit(1);
	const row = found[0];
	if (row === undefined) {
		throw new MediaNotFoundException("voicemail-greeting", greetingId);
	}
	return row;
}

/**
 * Clears the incumbent active greeting for one kind, if there is one.
 *
 * Unconditional rather than "only when one exists": the `where active` clause makes the statement a
 * no-op when there is nothing to clear, and a `select` first would be a round trip to learn
 * something the `update` already knows.
 */
async function deactivate(
	transaction: PbxDatabaseTransaction,
	boxId: string,
	kind: VoicemailGreetingKind,
): Promise<void> {
	await transaction
		.update(voicemailGreeting)
		.set({ active: false })
		.where(
			and(
				eq(voicemailGreeting.voicemailBoxId, boxId),
				eq(voicemailGreeting.kind, kind),
				eq(voicemailGreeting.active, true),
			),
		);
}
