import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DATABASE_ALREADY_EXISTS, Database } from "../../src/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[workspaces/createWorkspace]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a workspace", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: {
				name: "My Workspace",
			},
		};

		const db = {
			workspace: {
				create: sandbox.stub().resolves({ ref: "123" }),
			},
		} as unknown as Database;

		const { createCreateWorkspace } = await import("../../src/workspaces/createCreateWorkspace");

		// Act
		await createCreateWorkspace(db)(call, (_, response) => {
			// Assert
			expect(response).to.deep.equal({ ref: "123" });
		});
	});

	it("should throw an error if the workspace already exists", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);
		const call = {
			metadata,
			request: {
				name: "My Workspace",
			},
		};

		const db = {
			workspace: {
				create: sandbox.stub().throws({ code: DATABASE_ALREADY_EXISTS }),
			},
		} as unknown as Database;

		const { createCreateWorkspace } = await import("../../src/workspaces/createCreateWorkspace");

		// Act
		await createCreateWorkspace(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: grpc.status.ALREADY_EXISTS,
				message: "The resource already exists",
			});
		});
	});

	it("should throw if a validation error occurs", async function () {
		// Arrange
		const call = {
			request: {
				name: "",
			},
		};

		// Doesn't matter because it will not be called
		const db = {} as unknown as Database;

		const { createCreateWorkspace } = await import("../../src/workspaces/createCreateWorkspace");

		// Act
		await createCreateWorkspace(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: grpc.status.INVALID_ARGUMENT,
				message:
					// eslint-disable-next-line prettier/prettier
					'The name is required at "name"',
			});
		});
	});
});
