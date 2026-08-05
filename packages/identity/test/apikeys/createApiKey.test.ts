import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Role } from "@optimiq-voice/types";
import { DATABASE_ALREADY_EXISTS, Database } from "../../src/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[apikeys/createApiKey]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a new ApiKey", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: {
				workspaceRef: "123",
				role: Role.WORKSPACE_ADMIN,
				expiresAt: new Date().getMilliseconds(),
			},
		};

		const res = {
			ref: "123",
			accessKeyId: "accessKeyId",
			accessKeySecret: "accessKeySecret",
		};

		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves({ ref: "123" }),
			},
			apiKey: {
				create: sandbox.stub().resolves(res),
			},
		} as unknown as Database;

		const { createCreateApiKey } = await import("../../src/apikeys/createCreateApiKey");

		// Act
		await createCreateApiKey(db)(call, (_, response) => {
			// Assert
			expect(response).has.property("ref").to.be.equal("123");
			expect(response).has.property("accessKeyId").to.be.equal("accessKeyId");
			expect(response).has.property("accessKeySecret").to.be.equal("accessKeySecret");
		});
	});

	it("should throw an error if the ApiKey already exists", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);
		const call = {
			metadata,
			request: {
				workspaceRef: "123",
				role: Role.WORKSPACE_ADMIN,
				expiresAt: new Date().getMilliseconds(),
			},
		};

		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves({ ref: "123" }),
			},
			apiKey: {
				create: sandbox.stub().throws({ code: DATABASE_ALREADY_EXISTS }),
			},
		} as unknown as Database;

		const { createCreateApiKey } = await import("../../src/apikeys/createCreateApiKey");

		// Act
		await createCreateApiKey(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: grpc.status.ALREADY_EXISTS,
				message: "The resource already exists",
			});
		});
	});
});
