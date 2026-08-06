import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { TIME_CONDITION_RESOURCE, TIME_CONDITION_RULE_RESOURCE } from "./time-conditions.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class TimeConditionsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, TIME_CONDITION_RESOURCE);
	}
}

@Injectable()
export class TimeConditionRulesService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, TIME_CONDITION_RULE_RESOURCE);
	}
}
