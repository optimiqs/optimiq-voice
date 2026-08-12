import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { TRANSLATION_RULE_RESOURCE, TRANSLATION_RULESET_RESOURCE } from "./translations.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class TranslationRulesetsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, TRANSLATION_RULESET_RESOURCE);
	}
}

@Injectable()
export class TranslationRulesService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, TRANSLATION_RULE_RESOURCE);
	}
}
