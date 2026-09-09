import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import {
	assignExtensionUserDto,
	ExtensionUsersController,
} from "../../src/pbx/extensions/extension-users.controller";
import { ExtensionUsersService } from "../../src/pbx/extensions/extension-users.service";
import type { AuthPlatform } from "../../src/auth/auth.platform";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

const session = {
	session: { activeOrganizationId: "019fd3c2-1111-76be-a6b3-b0f1914e39b6" },
	user: { id: "019fd3c2-2222-76be-a6b3-b0f1914e39b6" },
} as AppSession;

describe("extension user assignment", () => {
	it("refuses a nonmember before any PBX write", async () => {
		let membershipChecked = false;
		const query = {
			from: () => query,
			where: () => query,
			limit: async () => {
				membershipChecked = true;
				return [];
			},
		};
		const platform = { database: { adminDb: { select: () => query } } } as unknown as AuthPlatform;
		const service = new ExtensionUsersService(
			undefined as unknown as PbxRepositoryRuntime,
			platform,
		);
		try {
			await service.create(session, "extension", { userId: session.user.id, role: "primary" });
			throw new Error("expected refusal");
		} catch (error) {
			expect(error).to.be.instanceOf(BadRequestException);
		}
		expect(membershipChecked).to.equal(true);
	});

	it("protects all assignment routes with the dedicated permission", () => {
		expect(
			Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA, ExtensionUsersController),
		).to.deep.equal(["extensions.assign"]);
	});

	it("rejects tenant or parent overrides and unknown assignment roles", () => {
		expect(
			assignExtensionUserDto.safeParse({ userId: session.user.id, organizationId: "other" })
				.success,
		).to.equal(false);
		expect(
			assignExtensionUserDto.safeParse({ userId: session.user.id, extensionId: "other" }).success,
		).to.equal(false);
		expect(
			assignExtensionUserDto.safeParse({ userId: session.user.id, role: "owner" }).success,
		).to.equal(false);
	});
});
