import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { member } from "@optimiq-voice/db/schema";
import { and, eq, extension, extensionUser } from "@optimiq-voice/pbx-db";
import { AUTH_PLATFORM } from "../../auth/auth.tokens";
import { PbxChildResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import type { AuthPlatform } from "../../auth/auth.platform";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

@Injectable()
export class ExtensionUsersService extends PbxChildResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform,
	) {
		super(runtime, {
			kind: "extension-user",
			tableName: "extension_user",
			table: extensionUser,
			searchColumns: [],
			orderBy: [extensionUser.id],
			destinations: [],
			destinationType: null,
			parentColumn: extensionUser.extensionId,
			parentKind: "extension",
			parentTable: extension,
		});
	}

	override async create(session: AppSession, parentId: string, values: Record<string, unknown>) {
		const organizationId = this.organizationId(session);
		const [membership] = await this.platform.database.adminDb
			.select({ id: member.id })
			.from(member)
			.where(
				and(eq(member.organizationId, organizationId), eq(member.userId, String(values.userId))),
			)
			.limit(1);
		if (!membership)
			throw new BadRequestException("The selected user is not a member of this organization.");
		return await super.create(session, parentId, values);
	}
}
