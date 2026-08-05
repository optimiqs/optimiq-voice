import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/core/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@secrets/getSecret", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should get a secret by id", async function () {
		// Arrange
		const metadata = new grpc.Metadata();
		metadata.set("token", TEST_TOKEN);

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const secret = {
			ref: "123",
			accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
			name: "My Secret",
			secret: "123456",
		};

		const db = {
			secret: {
				delete: sandbox.stub().resolves({ ref: secret.ref }),
				findUnique: sandbox.stub().resolves(secret),
			},
		} as unknown as Database;

		const { getSecret } = await import("../../src/secrets/getSecret");

		// Act
		const response = await new Promise((resolve, reject) => {
			getSecret(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(db.secret.findUnique).to.have.been.calledTwice;
		expect(response).have.property("ref", secret.ref);
		expect(response).have.property("name", secret.name);
		expect(response).have.property("secret", secret.secret);
	});

	it("should throw an error if the secret is not found", async function () {
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
			secret: {
				findUnique: sandbox.stub().resolves(null),
			},
		} as unknown as Database;

		const { getSecret } = await import("../../src/secrets/getSecret");

		// Act
		await getSecret(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: grpc.status.NOT_FOUND,
				message: `The requested resource was not found`,
			});
		});
	});
});
