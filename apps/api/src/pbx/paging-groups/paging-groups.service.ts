import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { PAGING_GROUP_MEMBER_RESOURCE, PAGING_GROUP_RESOURCE } from "./paging-groups.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class PagingGroupsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, PAGING_GROUP_RESOURCE);
	}
}

@Injectable()
export class PagingGroupMembersService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, PAGING_GROUP_MEMBER_RESOURCE);
	}
}
