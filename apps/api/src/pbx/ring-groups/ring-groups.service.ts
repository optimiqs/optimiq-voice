import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { RING_GROUP_DESTINATION_RESOURCE, RING_GROUP_RESOURCE } from "./ring-groups.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class RingGroupsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, RING_GROUP_RESOURCE);
	}
}

@Injectable()
export class RingGroupDestinationsService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, RING_GROUP_DESTINATION_RESOURCE);
	}
}
