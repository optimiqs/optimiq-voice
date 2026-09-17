import { Inject, Injectable } from "@nestjs/common";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import {
	AUDIO_STREAM_RESOURCE,
	DESTINATION_ALIAS_RESOURCE,
	DIAL_BY_NAME_DIRECTORY_RESOURCE,
	SPEED_DIAL_RESOURCE,
} from "./dial-plan.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

/**
 * Four services for four tables, one permission family.
 *
 * The collapse is in the permission registry, not here: the CRUD layer is per table because the
 * shapes differ, and only the grants are shared. See `dial-plan.resource.ts`.
 */
@Injectable()
export class DestinationAliasesService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, DESTINATION_ALIAS_RESOURCE);
	}
}

@Injectable()
export class AudioStreamsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, AUDIO_STREAM_RESOURCE);
	}
}

@Injectable()
export class DialByNameDirectoriesService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, DIAL_BY_NAME_DIRECTORY_RESOURCE);
	}
}

@Injectable()
export class SpeedDialsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, SPEED_DIAL_RESOURCE);
	}
}
