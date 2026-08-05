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

const appRef = "3c459670-efa0-4404-8671-b6f36c3da11d";

describe("@applications/deleteApplication", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should delete an application", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: appRef,
			},
		};

		const res = {
			ref: appRef,
		};

		const tenantDb = {
			application: {
				delete: sandbox.stub().resolves(res),
				findUnique: sandbox.stub().resolves({
					ref: appRef,
					organizationId: TEST_ORGANIZATION_ID,
				}),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { createDeleteApplication } =
			await import("../../src/applications/createDeleteApplication");

		// Act
		await createDeleteApplication(db)(call, (_, response) => {
			// Assert
			expect(response).to.have.property("ref", appRef);
		});

		expect(db.forOrganization).to.have.been.calledWithExactly(TEST_ORGANIZATION_ID);
		expect(tenantDb.application.delete).to.have.been.calledOnceWithExactly({
			where: { ref: appRef },
		});
	});

	it("should report NOT_FOUND without deleting when the application is outside the tenant", async function () {
		// Arrange
		// Ownership is enforced by the scoped read, not by `withAccess`: another tenant's row is
		// invisible inside this transaction, so the read resolves `null` and the delete never runs.
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: appRef,
			},
		};

		const tenantDb = {
			application: {
				delete: sandbox.stub().resolves({ ref: appRef }),
				findUnique: sandbox.stub().resolves(null),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { createDeleteApplication } =
			await import("../../src/applications/createDeleteApplication");

		// Act
		const error = await new Promise((resolve) => {
			createDeleteApplication(db)(call, (error) => resolve(error));
		});

		// Assert
		expect(error).to.deep.equal({
			code: grpc.status.NOT_FOUND,
			message: "The requested resource was not found",
		});
		expect(tenantDb.application.delete).to.have.not.been.called;
	});
});
