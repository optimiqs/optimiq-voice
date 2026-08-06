import { Inject, Injectable } from "@nestjs/common";
import { PbxChildResourceService, PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { QUEUE_AGENT_RESOURCE, QUEUE_RESOURCE, QUEUE_TIER_RESOURCE } from "./queues.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class QueuesService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, QUEUE_RESOURCE);
	}
}

@Injectable()
export class QueueAgentsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, QUEUE_AGENT_RESOURCE);
	}
}

@Injectable()
export class QueueTiersService extends PbxChildResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, QUEUE_TIER_RESOURCE);
	}
}
