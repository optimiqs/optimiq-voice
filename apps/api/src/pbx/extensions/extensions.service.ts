import { Inject, Injectable } from "@nestjs/common";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { EXTENSION_RESOURCE } from "./extensions.resource";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";

/** Extensions CRUD. All logic is in the base class; this binds it to the resource descriptor. */
@Injectable()
export class ExtensionsService extends PbxResourceService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime) {
		super(runtime, EXTENSION_RESOURCE);
	}
}
