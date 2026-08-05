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

describe("@secrets/listSecrets", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should return a list of secrets", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				pageSize: 10,
				pageToken: "1",
			},
		};

		const secrets = [
			{
				ref: "123",
				name: "My Secret",
				secret: "123456",
				organizationId: TEST_ORGANIZATION_ID,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];

		const tenantDb = {
			secret: {
				findMany: sandbox.stub().resolves(secrets),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { listSecrets } = await import("../../src/secrets/listSecrets");

		// Act
		const response = await new Promise((resolve, reject) => {
			listSecrets(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(db.forOrganization).to.have.been.calledOnceWithExactly(TEST_ORGANIZATION_ID);
		expect(tenantDb.secret.findMany).to.have.been.calledWithMatch({
			where: { organizationId: TEST_ORGANIZATION_ID },
		});
		expect(response).has.property("items").to.be.an("array").to.have.lengthOf(1);
		// When items.length < pageSize, we're on the last page, so nextPageToken should be empty string
		expect(response).has.property("nextPageToken").to.equal("");
	});

	it("should return nextPageToken when page is full", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				pageSize: 2, // Request 2 items
				pageToken: "",
			},
		};

		// Return exactly 2 items (full page)
		const secrets = [
			{
				ref: "secret-1",
				name: "Secret 1",
				secret: "value1",
				organizationId: TEST_ORGANIZATION_ID,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				ref: "secret-2",
				name: "Secret 2",
				secret: "value2",
				organizationId: TEST_ORGANIZATION_ID,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];

		const db = {
			forOrganization: sandbox.stub().returns({
				secret: {
					findMany: sandbox.stub().resolves(secrets),
				},
			}),
		} as unknown as Database;

		const { listSecrets } = await import("../../src/secrets/listSecrets");

		// Act
		const response = await new Promise((resolve, reject) => {
			listSecrets(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(response).has.property("items").to.be.an("array").to.have.lengthOf(2);
		// When items.length === pageSize, there might be more pages, so return nextPageToken
		expect(response).has.property("nextPageToken").to.be.a("string").to.equal("secret-2");
	});

	it("should return an empty array if no secrets found", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				pageSize: 10,
				pageToken: "1",
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns({
				secret: {
					findMany: sandbox.stub().resolves([]),
				},
			}),
		} as unknown as Database;

		const { listSecrets } = await import("../../src/secrets/listSecrets");

		// Act
		const response = await new Promise((resolve, reject) => {
			listSecrets(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(response).has.property("items").to.be.an("array").to.have.lengthOf(0);
		expect(response).has.property("nextPageToken").to.equal("");
	});
});
