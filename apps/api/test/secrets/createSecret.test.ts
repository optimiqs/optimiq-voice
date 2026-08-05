import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DatabaseErrorCode } from "@optimiq-voice/common";
import { TEST_TOKEN, TEST_UUID } from "../utils";
import type { Database } from "../../src/core/db";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@secrets/createSecret", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a secret", async function () {
		// Arrange
		const { createSecret } = await import("../../src/secrets/createSecret");
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const secrets = {
			secret: {
				create: sandbox.stub().resolves({ ref: TEST_UUID }),
			},
		} as unknown as Database;

		const call = {
			metadata,
			request: {
				name: "MY_SECRET",
				secret: "supersecret",
			},
		};

		const callback = sandbox.stub();

		// Act
		await createSecret(secrets)(call, callback);

		// Assert
		expect(callback).to.have.been.calledOnceWithExactly(null, {
			ref: TEST_UUID,
		});
	});

	it("should throw an error if the secret already exists", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: {
				name: "MY_SECRET",
				secret: "supersecret",
			},
		};

		const db = {
			secret: {
				create: sandbox.stub().throws({ code: DatabaseErrorCode.RECORD_ALREADY_EXISTS }),
			},
		} as unknown as Database;

		const { createSecret } = await import("../../src/secrets/createSecret");

		// Act
		await createSecret(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: grpc.status.ALREADY_EXISTS,
				message: "The resource already exists",
			});
		});
	});
});
