import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DatabaseErrorCode } from "@optimiq-voice/common";
import { TEST_TOKEN } from "../utils";
import type { Database } from "../../src/core/db";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@secrets/updateSecret", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should update a secret", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: {
				ref: "123",
				name: "My new secret name",
				secret: "123456",
			},
		};

		const db = {
			secret: {
				update: sandbox.stub().resolves({ ref: "123" }),
				findUnique: sandbox.stub().resolves({ accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p" }),
			},
		} as unknown as Database;

		const { updateSecret } = await import("../../src/secrets/updateSecret");

		// Act
		const response = await new Promise((resolve, reject) => {
			updateSecret(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(response).to.deep.equal({ ref: "123" });
	});

	it("should throw an error if the secret does not exist", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: {
				ref: "123",
				name: "My new secret name",
				secret: "123456",
			},
		};

		const db = {
			secret: {
				update: sandbox.stub().throws({ code: DatabaseErrorCode.RECORD_NOT_FOUND }),
				findUnique: sandbox.stub().resolves(null),
			},
		} as unknown as Database;

		const { updateSecret } = await import("../../src/secrets/updateSecret");

		// Act
		const response = new Promise((resolve, reject) => {
			updateSecret(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		await expect(response).to.be.rejectedWith(`The requested resource was not found`);
	});
});
