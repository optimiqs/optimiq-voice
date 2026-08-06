import { Inject, Injectable } from "@nestjs/common";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { PARK_LOT_RESOURCE } from "./park-lots.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class ParkLotsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, PARK_LOT_RESOURCE);
	}
}
