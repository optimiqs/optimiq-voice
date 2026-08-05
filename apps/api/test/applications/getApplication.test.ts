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

describe("@applications/getApplication", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should get an application by id", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const application = {
			ref: "123",
			name: "My Application",
			endpoint: "example.com:50051",
			organizationId: TEST_ORGANIZATION_ID,
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const tenantDb = {
			application: {
				delete: sandbox.stub().resolves({ ref: application.ref }),
				findUnique: sandbox.stub().resolves(application),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { createGetApplication } = await import("../../src/applications/createGetApplication");

		// Act
		const response = await new Promise((resolve, reject) => {
			createGetApplication(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		// `withAccess` used to make a second, unscoped read of the same row before the handler ran.
		// The tenant-scoped read is now the whole of the ownership check, so there is exactly one.
		expect(tenantDb.application.findUnique).to.have.been.calledOnce;
		expect(db.forOrganization).to.have.been.calledWithExactly(TEST_ORGANIZATION_ID);
		expect(response).have.property("ref", application.ref);
		expect(response).have.property("name", application.name);
		expect(response).have.property("endpoint", application.endpoint);
		expect(response).have.property("organizationId", application.organizationId);
	});

	it("should throw an error if the application is not found", async function () {
		// Arrange
		// This is also the foreign-tenant case: row-level security, not a permission check, is what
		// hides another tenant's row, so the scoped read resolves `null` and the caller cannot tell
		// "not yours" from "not there". That is the point — enumeration is closed.
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: "123",
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns({
				application: {
					findUnique: sandbox.stub().resolves(null),
				},
			}),
		} as unknown as Database;

		const { createGetApplication } = await import("../../src/applications/createGetApplication");

		// Act
		await createGetApplication(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: grpc.status.NOT_FOUND,
				message: "The requested resource was not found",
			});
		});
	});
});
