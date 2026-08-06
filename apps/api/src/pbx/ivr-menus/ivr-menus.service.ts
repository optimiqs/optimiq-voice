import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { IVR_MENU_OPTION_RESOURCE, IVR_MENU_RESOURCE } from "./ivr-menus.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class IvrMenusService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, IVR_MENU_RESOURCE);
	}
}

@Injectable()
export class IvrMenuOptionsService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, IVR_MENU_OPTION_RESOURCE);
	}
}
