import { Inject, Injectable } from "@nestjs/common";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { CONFERENCE_RESOURCE } from "./conferences.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class ConferencesService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, CONFERENCE_RESOURCE);
	}
}
