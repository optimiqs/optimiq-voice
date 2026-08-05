/* eslint-disable prettier/prettier */
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/core/db";
import { createTestCallMetadata, TEST_ORGANIZATION_ID, TEST_UUID } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@calls/createCall", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a call", async function () {
		// Arrange
		const { createCall } = await import("../../src/calls/createCall");
		const metadata = createTestCallMetadata();
		const publisher = {
			publishCall: sandbox.stub(),
		};
		const call = {
			metadata,
			request: {
				from: "+1234567890",
				to: "+1234567891",
				appRef: TEST_UUID,
			},
		};

		const application = {
			ref: TEST_UUID,
			name: "My Application",
			endpoint: "example.com:50051",
			organizationId: TEST_ORGANIZATION_ID,
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const tenantDb = {
			application: {
				findUnique: sandbox.stub().resolves(application),
			},
		};

		const applications = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		// Act
		await createCall(applications, publisher)(call, sandbox.stub());

		// Assert
		expect(publisher.publishCall).to.have.been.calledOnce;
		expect(applications.forOrganization).to.have.been.calledOnceWithExactly(TEST_ORGANIZATION_ID);
		expect(tenantDb.application.findUnique).to.have.been.calledOnce;
		expect(publisher.publishCall).to.have.been.calledWithMatch({
			from: "+1234567890",
			to: "+1234567891",
			appRef: TEST_UUID,
			// The published field keeps its legacy name during coexistence, but the value is the
			// organization id.
			accessKeyId: TEST_ORGANIZATION_ID,
		});
	});
});
