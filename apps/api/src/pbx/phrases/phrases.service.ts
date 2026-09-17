import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, ilike, prompt, sql } from "@optimiq-voice/pbx-db";
import { normalizePagination, paged } from "../shared/pagination";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PbxEntityNotFoundFailure, PbxValidationFailure } from "../shared/pbx.errors";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { PHRASE_RESOURCE, PHRASE_STEP_RESOURCE } from "./phrases.resource";
import type { ListQuery, PagedResult } from "../shared/pagination";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * Phrases: the ordered-sequence half of the media library.
 *
 * ## The two seams, and which one each method uses
 *
 * The same split `prompts.service.ts` sets out, for the same reason and over the same table:
 *
 * - **Writes go through the repository.** They get the eight-column reference guard, the typed
 *   404/409 failures the area answers with, the tenant transaction and — unlike the library when
 *   that header was written — compile-on-write. `prompt` and `phrase_step` are BOTH routing inputs
 *   now (`ROUTING_TABLE_TO_ENTITY` in `packages/routing/src/cache.ts`), because which prompt ids are
 *   sequences is a compiled fact. So creating a phrase, adding a step or reordering one republishes
 *   the artifact, and a nested step that slipped past the check below would come back as a compile
 *   rollback rather than a stored row.
 * - **Reads go direct.** Every read here carries `kind = 'phrase'`, and `PbxResource` has no
 *   vocabulary for a discriminator. See `phrases.resource.ts` for why it is not being given one.
 *
 * ## `kind` is stamped here, not accepted
 *
 * `create` writes `kind: "phrase"` and leaves `object_key` null, which is the exact pair
 * `prompt_object_key_kind_check` permits. Neither is a DTO field — see `phrases.dto.ts`.
 */
@Injectable()
export class PhrasesService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {
		super(runtime, PHRASE_RESOURCE);
	}

	/**
	 * One page of the tenant's phrases.
	 *
	 * Direct rather than through the repository because of the one predicate that separates a phrase
	 * from a file. Ordered by name then id, the same order the descriptor declares, so a later move
	 * back onto the generic path is a deletion rather than a behaviour change.
	 */
	override async list(
		session: AppSession,
		query: ListQuery,
	): Promise<PagedResult<Record<string, unknown>>> {
		const organizationId = this.organizationId(session);
		const pagination = normalizePagination(query);

		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const clauses = [eq(prompt.kind, "phrase")];
			if (query.search !== undefined) {
				// `%` and `_` are `ilike` wildcards; a user searching for "queue_position" means the
				// literal. The same escape `prompts.service.ts` applies, for the same reason.
				const escaped = query.search.replace(/[\\%_]/gu, (match) => `\\${match}`);
				clauses.push(ilike(prompt.name, `%${escaped}%`));
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

	/**
	 * One phrase.
	 *
	 * A library prompt's id here is a 404 and not a redirect. The two live in one table and a caller
	 * who has one id has effectively all of them, so `/phrases/:id` answering for a file would make
	 * the URL's noun decoration — the same "the URL means what it says" check `removeMohFile` makes
	 * about a class and its files.
	 */
	override async get(
		session: AppSession,
		id: string,
	): Promise<{ readonly data: Record<string, unknown> }> {
		const organizationId = this.organizationId(session);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			return { data: await requirePhrase(transaction, id) };
		});
	}

	/** Creates the `prompt` row that IS the phrase. The steps arrive afterwards, one POST each. */
	override async create(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		return await super.create(session, { ...values, kind: "phrase", objectKey: null });
	}

	/**
	 * Renames a phrase.
	 *
	 * Proves the row is a phrase FIRST, so patching a library entry through this URL is the same 404
	 * `get` gives rather than a metadata edit that happens to work. Without it the two surfaces would
	 * differ on whether the noun in the path is load-bearing.
	 */
	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		await this.requireOwnPhrase(session, id);
		return await super.update(session, id, values);
	}

	/**
	 * Deletes a phrase and, by cascade, its steps.
	 *
	 * `phrase_step.phrase_id` is `on delete cascade`, which is the one cascade in this schema that is
	 * obviously right: a step is not a thing that outlives its sequence. What is refused instead is
	 * deleting a phrase something still PLAYS — the eight `*_prompt_id` columns are all
	 * `on delete set null`, so the database would take it and quietly return an IVR to its default
	 * announcement. The descriptor names all eight, so that is a 409 naming them.
	 */
	override async remove(
		session: AppSession,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		await this.requireOwnPhrase(session, id);
		return await super.remove(session, id);
	}

	private async requireOwnPhrase(session: AppSession, id: string): Promise<void> {
		const organizationId = this.organizationId(session);
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await requirePhrase(transaction, id);
		});
	}
}

/**
 * The steps of one phrase.
 *
 * Every path here proves two things the generic child machinery cannot, because both are about a
 * row's `kind` and the descriptor has no vocabulary for one:
 *
 * 1. **The parent is a phrase.** `parentTable` is `prompt`, so the generic guard proves the parent
 *    row exists in the tenant and stops there — which would make `/prompts/<a-wav-file>/steps` a
 *    working endpoint that attaches steps to a file.
 * 2. **The step's target is not a phrase.** Nesting is refused rather than bounded; the argument is
 *    in `phrases-schema.ts`. Refused HERE, at write time, with the field named, rather than left for
 *    the compiler: `invalid-phrase` is an error, so compile-on-write would roll the write back
 *    anyway — but it would arrive as a rollback diagnostic on a save the user has already made,
 *    instead of a 400 attached to the picker they just used.
 */
@Injectable()
export class PhraseStepsService extends PbxChildResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {
		super(runtime, PHRASE_STEP_RESOURCE);
	}

	override async list(
		session: AppSession,
		parentId: string,
	): Promise<{ readonly data: readonly Record<string, unknown>[] }> {
		await this.check(session, parentId);
		return await super.list(session, parentId);
	}

	override async create(
		session: AppSession,
		parentId: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		await this.check(session, parentId, values.promptId);
		return await super.create(session, parentId, values);
	}

	override async update(
		session: AppSession,
		parentId: string,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		await this.check(session, parentId, values.promptId);
		return await super.update(session, parentId, id, values);
	}

	override async remove(
		session: AppSession,
		parentId: string,
		id: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		await this.check(session, parentId);
		return await super.remove(session, parentId, id);
	}

	override async reorder(
		session: AppSession,
		parentId: string,
		ids: readonly string[],
	): Promise<MutationEnvelope<readonly Record<string, unknown>[]>> {
		await this.check(session, parentId);
		return await super.reorder(session, parentId, ids);
	}

	/**
	 * The parent is a phrase, and the target — when the body names one — is not.
	 *
	 * One transaction for both, so a step write costs one extra round trip rather than two. An absent
	 * `promptId` is a PATCH that is not moving the target, and there is nothing to check.
	 */
	private async check(session: AppSession, parentId: string, promptId?: unknown): Promise<void> {
		const organizationId = this.organizationId(session);
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await requirePhrase(transaction, parentId);
			if (typeof promptId === "string") {
				await requireStepTarget(transaction, promptId);
			}
		});
	}
}

/**
 * The `prompt` row with this id and `kind = 'phrase'`, or the area's 404.
 *
 * RLS has already scoped the read, so "absent", "another tenant's" and "a library file" are three
 * ways of saying the same thing to a caller and are answered identically. Exported rather than
 * private because both services need it and a second copy is a second chance to forget the `kind`.
 */
export async function requirePhrase(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<Record<string, unknown>> {
	const found = await transaction
		.select()
		.from(prompt)
		.where(and(eq(prompt.id, id), eq(prompt.kind, "phrase")))
		.limit(1);
	const row = found[0];
	if (row === undefined) {
		throw new PbxEntityNotFoundFailure({ kind: "phrase", id }).toHttpException();
	}
	return row as unknown as Record<string, unknown>;
}

/**
 * The prompt a step may play: present in the tenant, and not itself a phrase.
 *
 * The two failures are deliberately different. A missing id is the area's 404 — the row is not
 * there, and that is the same answer every other dangling reference gets. A phrase is a 400 naming
 * `promptId`, because the row IS there and the caller may well be looking at it in a picker; telling
 * them it does not exist would send them hunting for a row they can see.
 */
export async function requireStepTarget(
	transaction: PbxDatabaseTransaction,
	promptId: string,
): Promise<void> {
	const found = await transaction
		.select({ kind: prompt.kind, name: prompt.name })
		.from(prompt)
		.where(eq(prompt.id, promptId))
		.limit(1);
	const row = found[0];
	if (row === undefined) {
		throw new PbxEntityNotFoundFailure({ kind: "prompt", id: promptId }).toHttpException();
	}
	if (row.kind === "phrase") {
		throw new PbxValidationFailure({
			field: "promptId",
			detail: `"${row.name}" is itself a phrase, and phrases do not nest. List its steps directly instead.`,
		}).toHttpException();
	}
}
