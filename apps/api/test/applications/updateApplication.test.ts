import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DatabaseErrorCode } from "@optimiq-voice/common";
import { ApplicationType } from "@optimiq-voice/types";
import { createTestCallMetadata, TEST_ORGANIZATION_ID, TEST_UUID } from "../utils";
import type { Database } from "../../src/core/db";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@applications/updateApplication", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should update an application", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: TEST_UUID,
				name: "My new application name",
				endpoint: "localhost:8765",
				type: ApplicationType.EXTERNAL,
			},
		};

		const tenantDb = {
			application: {
				update: sandbox.stub().resolves({ ref: TEST_UUID }),
				findUnique: sandbox.stub().resolves({
					ref: TEST_UUID,
					organizationId: TEST_ORGANIZATION_ID,
				}),
			},
			transaction: sandbox.stub(),
			textToSpeech: {
				deleteMany: sandbox.stub().resolves(),
			},
			speechToText: {
				deleteMany: sandbox.stub().resolves(),
			},
			intelligence: {
				deleteMany: sandbox.stub().resolves(),
			},
		};

		// The handler runs the deletes and the update inside one tenant transaction, so the
		// callback has to be handed the same scoped handle.
		tenantDb.transaction.callsFake(async (callback) => callback(tenantDb));

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { createUpdateApplication } =
			await import("../../src/applications/createUpdateApplication");

		// Act
		const response = await new Promise((resolve, reject) => {
			createUpdateApplication(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(response).to.deep.equal({ ref: TEST_UUID });
		expect(db.forOrganization).to.have.been.calledWithExactly(TEST_ORGANIZATION_ID);
		expect(tenantDb.application.update).to.have.been.calledWithMatch({
			where: { ref: TEST_UUID, organizationId: TEST_ORGANIZATION_ID },
		});
	});

	it("should throw an error if the application does not exist", async function () {
		// Arrange
		// Also the foreign-tenant case: outside this tenant's scope the row is invisible, so the
		// read that precedes the write raises NOT_FOUND and nothing is updated.
		const metadata = createTestCallMetadata();

		// The request has to be otherwise valid: `validOrThrow` runs inside the handler, ahead of
		// the ownership read, where `withAccess` used to run the read first.
		const call = {
			metadata,
			request: {
				ref: TEST_UUID,
				name: "My new application name",
				endpoint: "localhost:8765",
				type: ApplicationType.EXTERNAL,
			},
		};

		const tenantDb = {
			application: {
				update: sandbox.stub().throws({ code: DatabaseErrorCode.RECORD_NOT_FOUND }),
				findUnique: sandbox.stub().resolves(null),
			},
			transaction: sandbox.stub(),
			textToSpeech: { deleteMany: sandbox.stub().resolves() },
			speechToText: { deleteMany: sandbox.stub().resolves() },
			intelligence: { deleteMany: sandbox.stub().resolves() },
		};

		tenantDb.transaction.callsFake(async (callback) => callback(tenantDb));

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { createUpdateApplication } =
			await import("../../src/applications/createUpdateApplication");

		// Act
		const response = new Promise((resolve, reject) => {
			createUpdateApplication(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		await expect(response).to.be.rejectedWith("The requested resource was not found");
		expect(tenantDb.application.update).to.have.not.been.called;
	});
});
