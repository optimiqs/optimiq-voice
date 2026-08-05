import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Role } from "@optimiq-voice/types";
import { Database } from "../../src/db";
import { IdentityConfig } from "../../src/exchanges/types";
import { TEST_PRIVATE_KEY, TEST_TOKEN, TEST_UUID } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const workspaceName = "Test Workspace";
const workspaceOwner = "635c0cd8-8125-483d-b467-05c53ce2cd31";
const inviteRequest = {
	workspaceRef: "1",
	email: "john@example.com",
	name: "John Doe",
	role: Role.WORKSPACE_ADMIN,
	password: "12345678",
};

describe("@identity[workspace/inviteUserToWorkspace]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should invite a user to a workspace", async function () {
		// Arrange
		const sendInvite = sandbox.stub();
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: inviteRequest,
		};

		const identityConfig = {
			smtpConfig: {
				host: "smtp.example.com",
				port: 587,
				secure: false,
				sender: "Optimiq Voice <info@optimiq-voice.local>",
				auth: {},
			},
			privateKey: TEST_PRIVATE_KEY,
		} as IdentityConfig;

		const db = {
			user: {
				findUnique: sandbox.stub().resolves(),
				create: sandbox.stub().resolves({ ref: TEST_UUID }),
			},
			workspaceMember: {
				create: sandbox.stub().resolves({ workspace: { name: workspaceName } }),
				findFirst: sandbox.stub().resolves(),
			},
			workspace: {
				findUnique: sandbox.stub().resolves({
					ref: TEST_UUID,
					accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
					ownerRef: workspaceOwner,
					members: [],
				}),
			},
		} as unknown as Database;

		const { createInviteUserToWorkspace } =
			await import("../../src/workspaces/createInviteUserToWorkspace");

		// Act
		await createInviteUserToWorkspace(db, identityConfig, sendInvite)(call, () => {});

		// Assert
		expect(sendInvite).to.have.been.calledOnce;
		// expect(db.user.create).to.have.been.calledOnce;
		// expect(db.workspaceMember.create).to.have.been.calledOnce;
	});

	it("should return an error if the user is already a member", async function () {
		// Arrange
		const sendInvite = sandbox.stub();
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: inviteRequest,
		};

		const identityConfig = {
			smtpConfig: {
				host: "smtp.example.com",
				port: 587,
				secure: false,
				sender: "Optimiq Voice <info@optimiq-voice.local>",
				auth: {},
			},
			privateKey: TEST_PRIVATE_KEY,
		} as IdentityConfig;

		const db = {
			user: {
				findUnique: sandbox.stub().resolves({ ref: TEST_TOKEN }),
				create: sandbox.stub().resolves(),
			},
			workspaceMember: {
				create: sandbox.stub().resolves({ workspace: { name: workspaceName } }),
				findFirst: sandbox.stub().resolves({ ref: TEST_TOKEN }),
			},
			workspace: {
				findUnique: sandbox.stub().resolves({
					ref: TEST_TOKEN,
					accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
					ownerRef: workspaceOwner,
					members: [],
				}),
			},
		} as unknown as Database;

		const { createInviteUserToWorkspace } =
			await import("../../src/workspaces/createInviteUserToWorkspace");

		// Act
		const callback = sandbox.stub();
		await createInviteUserToWorkspace(db, identityConfig, sendInvite)(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWith({
			code: grpc.status.ALREADY_EXISTS,
			message: "User is already a member of this workspace",
		});
		expect(sendInvite).to.not.have.been.called;
		expect(db.user.create).to.not.have.been.not.called;
		expect(db.workspaceMember.create).to.not.have.been.called;
	});

	it("should return an error if the inviter is not an admin", async function () {
		// Arrange
		const sendInvite = sandbox.stub();
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const identityConfig = {} as IdentityConfig;

		const call = {
			metadata,
			request: inviteRequest,
		};

		const db = {
			user: {
				findUnique: sandbox.stub().resolves(),
				create: sandbox.stub().resolves({ ref: TEST_UUID }),
			},
			workspaceMember: {
				create: sandbox.stub().resolves({ workspace: { name: workspaceName } }),
				findFirst: sandbox.stub().resolves(),
			},
			workspace: {
				findUnique: sandbox.stub().resolves({
					ref: TEST_UUID,
					accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
					ownerRef: "another-user-id",
					members: [],
				}),
			},
		} as unknown as Database;

		const { createInviteUserToWorkspace } =
			await import("../../src/workspaces/createInviteUserToWorkspace");

		// Act
		const callback = sandbox.stub();
		await createInviteUserToWorkspace(db, identityConfig, sendInvite)(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWith({
			code: grpc.status.PERMISSION_DENIED,
			message: "Only admins or owners can invite users to a workspace",
		});
		expect(sendInvite).to.not.have.been.called;
		expect(db.user.create).to.not.have.been.not.called;
		expect(db.workspaceMember.create).to.not.have.been.called;
	});
});
