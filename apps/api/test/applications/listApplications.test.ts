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

describe("@applications/listApplications", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should list applications", async function () {
		// Arrange
		const metadata = createTestCallMetadata();

		const call = {
			metadata,
			request: {
				pageSize: 10,
				pageToken: "1",
			},
		};

		const applications = [
			{
				ref: "123",
				name: "My Application",
				organizationId: TEST_ORGANIZATION_ID,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];

		const tenantDb = {
			application: {
				findMany: sandbox.stub().resolves(applications),
			},
		};

		const db = {
			forOrganization: sandbox.stub().returns(tenantDb),
		} as unknown as Database;

		const { createListApplications } =
			await import("../../src/applications/createListApplications");

		// Act
		const response = await new Promise((resolve, reject) => {
			createListApplications(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(db.forOrganization).to.have.been.calledOnceWithExactly(TEST_ORGANIZATION_ID);
		expect(tenantDb.application.findMany).to.have.been.calledWithMatch({
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
		const applications = [
			{
				ref: "app-1",
				name: "Application 1",
				organizationId: TEST_ORGANIZATION_ID,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				ref: "app-2",
				name: "Application 2",
				organizationId: TEST_ORGANIZATION_ID,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];

		const db = {
			forOrganization: sandbox.stub().returns({
				application: {
					findMany: sandbox.stub().resolves(applications),
				},
			}),
		} as unknown as Database;

		const { createListApplications } =
			await import("../../src/applications/createListApplications");

		// Act
		const response = await new Promise((resolve, reject) => {
			createListApplications(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(response).has.property("items").to.be.an("array").to.have.lengthOf(2);
		// When items.length === pageSize, there might be more pages, so return nextPageToken
		expect(response).has.property("nextPageToken").to.be.a("string").to.equal("app-2");
	});

	it("should return an empty array if no applications found", async function () {
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
				application: {
					findMany: sandbox.stub().resolves([]),
				},
			}),
		} as unknown as Database;

		const { createListApplications } =
			await import("../../src/applications/createListApplications");

		// Act
		const response = await new Promise((resolve, reject) => {
			createListApplications(db)(call, (error, response) => {
				if (error) return reject(error);
				resolve(response);
			});
		});

		// Assert
		expect(response).has.property("items").to.be.an("array").to.have.lengthOf(0);
		expect(response).has.property("nextPageToken").to.equal("");
	});
});
