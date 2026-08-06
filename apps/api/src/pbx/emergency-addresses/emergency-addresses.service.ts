import { Inject, Injectable } from "@nestjs/common";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { EMERGENCY_ADDRESS_RESOURCE } from "./emergency-addresses.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

@Injectable()
export class EmergencyAddressesService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, EMERGENCY_ADDRESS_RESOURCE);
	}
}
