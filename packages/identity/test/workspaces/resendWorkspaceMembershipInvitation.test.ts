import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/db";
import { IdentityConfig } from "../../src/exchanges/types";
import { createScopedMetadata, TEST_PRIVATE_KEY } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[workspace/resendWorkspaceMembershipInvitation]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should resend a workspace membership invitation", async function () {
		// Arrange
		// Scoped by the tenancy interceptor (identity-removal Step 3 item 2), not by the caller.
		const metadata = createScopedMetadata();
		const userRef = "635c0cd8-8125-483d-b467-05c53ce2cd31";

		const call = {
			metadata,
			request: {
				userRef,
			},
		};

		const identityConfig = {
			smtpConfig: {
				host: "smtp.example.com",
				port: 587,
				secure: true,
				sender: "Optimiq Voice <info@optimiq-voice.local>",
				auth: {},
			},
			privateKey: TEST_PRIVATE_KEY,
		} as IdentityConfig;

		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves({
					ref: "123",
					ownerRef: userRef,
					members: [
						{
							userRef,
							role: "ADMIN",
						},
					],
				}),
			},
			workspaceMember: {
				findFirst: sandbox.stub().resolves({
					user: {
						email: "john@example.com",
						password: "123456",
					},
					workspace: {
						name: "Test Workspace",
					},
				}),
			},
		} as unknown as Database;

		const sendInvite = sandbox.stub().resolves();

		// Act
		const { createResendWorkspaceMembershipInvitation } =
			await import("../../src/workspaces/createResendWorkspaceMembershipInvitation");

		const callback = sandbox.stub();

		await createResendWorkspaceMembershipInvitation(db, identityConfig, sendInvite)(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWith(null, {
			userRef,
		});
	});

	it("should return PERMISSION_DENIED if user is not an admin", async function () {
		// Arrange
		// Scoped by the tenancy interceptor (identity-removal Step 3 item 2), not by the caller.
		const metadata = createScopedMetadata();
		const userRef = "635c0cd8-8125-483d-b467-05c53ce2cd31";

		const call = {
			metadata,
			request: {
				workspaceRef: "123",
				userRef,
			},
		};

		const identity = {} as IdentityConfig;

		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves({
					ownerRef: "another-user",
					members: [
						{
							userRef,
							role: "USER",
						},
					],
				}),
			},
		} as unknown as Database;

		const sendInvite = sandbox.stub().resolves();

		// Act
		const { createResendWorkspaceMembershipInvitation } =
			await import("../../src/workspaces/createResendWorkspaceMembershipInvitation");

		createResendWorkspaceMembershipInvitation(
			db,
			identity,
			sendInvite,
		)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: grpc.status.PERMISSION_DENIED,
				message: "Only admins and owners can resend workspace invitations",
			});
		});
	});
});
