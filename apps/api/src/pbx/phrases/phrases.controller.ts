import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Put,
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto, reorderDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import {
	createPhraseDto,
	createPhraseStepDto,
	updatePhraseDto,
	updatePhraseStepDto,
} from "./phrases.dto";
import { PhrasesService, PhraseStepsService } from "./phrases.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/phrases` and its ordered `/steps`.
 *
 * ## The grants are `recordings.*`, and no `phrases.*` was minted
 *
 * `permissions.ts` states the decision and `adminBlock.test.ts` pins it by asserting `phrases.read`
 * is NOT declared: a phrase IS a `prompt` row, so it rides `recordings.*` with the rest of the media
 * library. Building the surface does not reverse that. There is no role that plausibly curates the
 * audio library and not the sequences assembled out of it, and a `phrases.*` trio would be three
 * more names for the decision `recordings.*` already makes — the field-level granularity this
 * permission model exists to undo.
 *
 * The one thing worth noticing is that this makes `recordings.write` a ROUTING grant, which it was
 * not before the media library became a compile input. That is a widening of what the permission
 * reaches, not of who holds it, and it is the same widening `prompt` joining
 * `ROUTING_TABLE_TO_ENTITY` already made for every upload.
 *
 * ## There is no upload path here
 *
 * A phrase owns no file. `POST /phrases` is an ordinary JSON body, and the multipart reader that
 * every other row in this table is born through is nowhere near it — see `phrases.dto.ts`.
 */
@Controller("api/v1/phrases")
export class PhrasesController {
	constructor(
		@Inject(PhrasesService) private readonly phrases: PhrasesService,
		@Inject(PhraseStepsService) private readonly steps: PhraseStepsService,
	) {}

	@Get()
	@RequirePermissions("recordings.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.phrases.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("recordings.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.phrases.get(session, id);
	}

	@Post()
	@RequirePermissions("recordings.configure")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.phrases.create(session, parseDto(createPhraseDto, body));
	}

	@Patch(":id")
	@RequirePermissions("recordings.configure")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.phrases.update(session, id, parseDto(updatePhraseDto, body));
	}

	@Delete(":id")
	@RequirePermissions("recordings.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.phrases.remove(session, id);
	}

	// --- steps -----------------------------------------------------------------------------------

	@Get(":id/steps")
	@RequirePermissions("recordings.read")
	async listSteps(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.steps.list(session, id);
	}

	@Post(":id/steps")
	@RequirePermissions("recordings.configure")
	async createStep(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.steps.create(session, id, parseDto(createPhraseStepDto, body));
	}

	/**
	 * Rewrites the sequence's order in one transaction.
	 *
	 * The order is the sentence. "Your call is number" / "seven" / "in the queue" played in another
	 * order is not a slower announcement, it is a different one — the same argument a translation
	 * ruleset's pipeline makes, and the same reason this is not N PATCHes: each would publish an
	 * intermediate order to the routing cache, and the unique `(phrase, ordinal)` index would refuse
	 * most of them anyway.
	 */
	@Put(":id/steps/reorder")
	@RequirePermissions("recordings.configure")
	async reorderSteps(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.steps.reorder(session, id, parseDto(reorderDto, body).ids);
	}

	@Patch(":id/steps/:stepId")
	@RequirePermissions("recordings.configure")
	async updateStep(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("stepId", ParseUUIDPipe) stepId: string,
		@Body() body: unknown,
	) {
		return await this.steps.update(session, id, stepId, parseDto(updatePhraseStepDto, body));
	}

	@Delete(":id/steps/:stepId")
	@RequirePermissions("recordings.delete")
	async removeStep(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("stepId", ParseUUIDPipe) stepId: string,
	) {
		return await this.steps.remove(session, id, stepId);
	}
}
