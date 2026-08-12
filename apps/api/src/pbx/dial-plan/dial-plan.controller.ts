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
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import {
	createAudioStreamDto,
	createDestinationAliasDto,
	createDialByNameDirectoryDto,
	createSpeedDialDto,
	updateAudioStreamDto,
	updateDestinationAliasDto,
	updateDialByNameDirectoryDto,
	updateSpeedDialDto,
} from "./dial-plan.dto";
import {
	AudioStreamsService,
	DestinationAliasesService,
	DialByNameDirectoriesService,
	SpeedDialsService,
} from "./dial-plan.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * The four dial-plan building blocks, each on its own path and all four on one permission family.
 *
 * Four controllers in one file rather than four files, because they are four copies of the same five
 * handlers differing only in their DTO — the same argument `pbx-resource.ts` makes for the shared
 * repository, one layer up. The permission strings are repeated on every handler rather than hoisted,
 * because `permissionEnforcement.test.ts` reads them as literals and because a guard a reader has to
 * look up is a guard a reader skips.
 */

@Controller("api/v1/destination-aliases")
export class DestinationAliasesController {
	constructor(
		@Inject(DestinationAliasesService)
		private readonly destinationAliases: DestinationAliasesService,
	) {}

	@Get()
	@RequirePermissions("dial-plan.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.destinationAliases.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("dial-plan.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.destinationAliases.get(session, id);
	}

	@Post()
	@RequirePermissions("dial-plan.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.destinationAliases.create(session, parseDto(createDestinationAliasDto, body));
	}

	@Patch(":id")
	@RequirePermissions("dial-plan.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.destinationAliases.update(
			session,
			id,
			parseDto(updateDestinationAliasDto, body),
		);
	}

	@Delete(":id")
	@RequirePermissions("dial-plan.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.destinationAliases.remove(session, id);
	}
}

@Controller("api/v1/audio-streams")
export class AudioStreamsController {
	constructor(@Inject(AudioStreamsService) private readonly audioStreams: AudioStreamsService) {}

	@Get()
	@RequirePermissions("dial-plan.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.audioStreams.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("dial-plan.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.audioStreams.get(session, id);
	}

	@Post()
	@RequirePermissions("dial-plan.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.audioStreams.create(session, parseDto(createAudioStreamDto, body));
	}

	@Patch(":id")
	@RequirePermissions("dial-plan.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.audioStreams.update(session, id, parseDto(updateAudioStreamDto, body));
	}

	@Delete(":id")
	@RequirePermissions("dial-plan.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.audioStreams.remove(session, id);
	}
}

@Controller("api/v1/directories")
export class DirectoriesController {
	constructor(
		@Inject(DialByNameDirectoriesService)
		private readonly directories: DialByNameDirectoriesService,
	) {}

	@Get()
	@RequirePermissions("dial-plan.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.directories.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("dial-plan.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.directories.get(session, id);
	}

	@Post()
	@RequirePermissions("dial-plan.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.directories.create(session, parseDto(createDialByNameDirectoryDto, body));
	}

	@Patch(":id")
	@RequirePermissions("dial-plan.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.directories.update(session, id, parseDto(updateDialByNameDirectoryDto, body));
	}

	@Delete(":id")
	@RequirePermissions("dial-plan.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.directories.remove(session, id);
	}
}

@Controller("api/v1/speed-dials")
export class SpeedDialsController {
	constructor(@Inject(SpeedDialsService) private readonly speedDials: SpeedDialsService) {}

	@Get()
	@RequirePermissions("dial-plan.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.speedDials.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("dial-plan.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.speedDials.get(session, id);
	}

	@Post()
	@RequirePermissions("dial-plan.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.speedDials.create(session, parseDto(createSpeedDialDto, body));
	}

	@Patch(":id")
	@RequirePermissions("dial-plan.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.speedDials.update(session, id, parseDto(updateSpeedDialDto, body));
	}

	@Delete(":id")
	@RequirePermissions("dial-plan.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.speedDials.remove(session, id);
	}
}
