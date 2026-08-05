import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DatabaseErrorCode } from "@optimiq-voice/common";
import { createTestCallMetadata, TEST_ORGANIZATION_ID } from "../utils";
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
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: "123",
				name: "My new secret name",
				secret: "123456",
			},
		};

		const tenantDb = {
			secret: {
				update: sandbox.stub().resolves({ ref: "123" }),
				findUnique: sandbox.stub().resolves({
					ref: "123",
					organizationId: TEST_ORGANIZATION_ID,
				}),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
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
		expect(db.forOrganization).to.have.been.calledWithExactly(TEST_ORGANIZATION_ID);
		expect(tenantDb.secret.update).to.have.been.calledWithMatch({ where: { ref: "123" } });
	});

	it("should throw an error if the secret does not exist", async function () {
		// Arrange
		// Also the foreign-tenant case: the scoped read that precedes the write finds nothing, so
		// nothing is written.
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				ref: "123",
				name: "My new secret name",
				secret: "123456",
			},
		};

		const tenantDb = {
			secret: {
				update: sandbox.stub().throws({ code: DatabaseErrorCode.RECORD_NOT_FOUND }),
				findUnique: sandbox.stub().resolves(null),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
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
		expect(tenantDb.secret.update).to.have.not.been.called;
	});
});
