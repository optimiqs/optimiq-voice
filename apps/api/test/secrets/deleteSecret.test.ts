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

describe("@secrets/deleteSecret", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should delete a secret", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const res = {
			ref: "123",
		};

		const tenantDb = {
			secret: {
				delete: sandbox.stub().resolves(res),
				findUnique: sandbox.stub().resolves({
					ref: "123",
					organizationId: TEST_ORGANIZATION_ID,
				}),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { deleteSecret } = await import("../../src/secrets/deleteSecret");

		// Act
		await deleteSecret(db)(call, (_, response) => {
			// Assert
			expect(response).to.have.property("ref", "123");
		});

		expect(db.forOrganization).to.have.been.calledWithExactly(TEST_ORGANIZATION_ID);
		expect(tenantDb.secret.delete).to.have.been.calledOnceWithExactly({ where: { ref: "123" } });
	});

	it("should report NOT_FOUND without deleting when the secret is outside the tenant", async function () {
		// Arrange
		// The read is what enforces ownership now: another tenant's secret is invisible inside this
		// transaction, so the handler raises NOT_FOUND rather than deleting someone else's row.
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const tenantDb = {
			secret: {
				delete: sandbox.stub().resolves({ ref: "123" }),
				findUnique: sandbox.stub().resolves(null),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { deleteSecret } = await import("../../src/secrets/deleteSecret");

		// Act
		const error = await new Promise((resolve) => {
			deleteSecret(db)(call, (error) => resolve(error));
		});

		// Assert
		expect(error).to.deep.equal({
			code: grpc.status.NOT_FOUND,
			message: "The requested resource was not found",
		});
		expect(tenantDb.secret.delete).to.have.not.been.called;
	});
});
