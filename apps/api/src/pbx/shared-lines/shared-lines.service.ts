import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { SHARED_LINE_APPEARANCE_RESOURCE, SHARED_LINE_RESOURCE } from "./shared-lines.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class SharedLinesService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, SHARED_LINE_RESOURCE);
	}
}

@Injectable()
export class SharedLineAppearancesService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, SHARED_LINE_APPEARANCE_RESOURCE);
	}
}
