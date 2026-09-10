import { ownedExtensionParties } from "./self-ownership";
import type { OwnedParties } from "../../cdr/query/cdr-self-scope";
import type { CdrSelfParties } from "../../cdr/query/self-parties";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `CdrSelfParties`, implemented out of the PBX area's `extension_user` link.
 *
 * A plain class rather than an `@Injectable()`, like the other two ports `PbxCdrPortsModule` binds:
 * the whole of it is one call into `self-ownership.ts`, and a test constructs it with a fake client
 * instead of standing a module up.
 */
export class CdrSelfPartiesService implements CdrSelfParties {
	constructor(private readonly database: PbxDatabaseClient) {}

	async forUser(organizationId: string, userId: string): Promise<OwnedParties> {
		return await ownedExtensionParties(this.database, organizationId, userId);
	}
}
