import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { datesMapper } from "@optimiq-voice/common";
import { Database } from "../../src/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[workspaces/getWorkspace]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should get a workspace by id", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const workspace = {
			ref: "123",
			name: "My Workspace",
			ownerRef: "123",
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves(workspace),
			},
		} as unknown as Database;

		const { createGetWorkspace } = await import("../../src/workspaces/createGetWorkspace");

		// Act
		const response = await new Promise((resolve, reject) => {
			createGetWorkspace(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(response).to.deep.equal(datesMapper(workspace));
	});

	it("should throw an error if workspace not found", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves(null),
			},
		} as unknown as Database;

		const { createGetWorkspace } = await import("../../src/workspaces/createGetWorkspace");

		// Act
		await createGetWorkspace(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: grpc.status.NOT_FOUND,
				message: "Workspace not found",
			});
		});
	});
});
