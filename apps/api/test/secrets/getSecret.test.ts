import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/core/db";
import { createTestCallMetadata, TEST_ORGANIZATION_ID } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@secrets/getSecret", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should get a secret by id", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const secret = {
			ref: "123",
			organizationId: TEST_ORGANIZATION_ID,
			name: "My Secret",
			secret: "123456",
		};

		const tenantDb = {
			secret: {
				delete: sandbox.stub().resolves({ ref: secret.ref }),
				findUnique: sandbox.stub().resolves(secret),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
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
		// `withAccess` used to make a second, unscoped read of the same row before the handler ran.
		// The tenant-scoped read is now the whole of the ownership check, so there is exactly one.
		expect(tenantDb.secret.findUnique).to.have.been.calledOnce;
		expect(db.forOrganization).to.have.been.calledWithExactly(TEST_ORGANIZATION_ID);
		expect(response).have.property("ref", secret.ref);
		expect(response).have.property("name", secret.name);
		expect(response).have.property("secret", secret.secret);
	});

	it("should throw an error if the secret is not found", async function () {
		// Arrange
		// Also the foreign-tenant case: row-level security hides another tenant's row, so the
		// scoped read resolves `null` and NOT_FOUND is indistinguishable from PERMISSION_DENIED.
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns({
				secret: {
					findUnique: sandbox.stub().resolves(null),
				},
			}),
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
