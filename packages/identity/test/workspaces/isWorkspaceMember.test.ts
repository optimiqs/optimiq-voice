import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/db";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[workspaces/isWorkspaceMember]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should return true if user is the owner of the workspace", async function () {
		// Arrange
		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves({ ownerRef: "123" }),
			},
			workspaceMember: {
				findFirst: sandbox.stub().resolves(),
			},
		} as unknown as Database;

		const { createIsWorkspaceMember } =
			await import("../../src/workspaces/createIsWorkspaceMember");

		// Act
		const result = await createIsWorkspaceMember(db)("123", "123");

		// Assert
		expect(result).to.be.true;
	});

	it("should return true if user is a member of the workspace", async function () {
		// Arrange
		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves(),
			},
			workspaceMember: {
				findFirst: sandbox.stub().resolves({}),
			},
		} as unknown as Database;

		const { createIsWorkspaceMember } =
			await import("../../src/workspaces/createIsWorkspaceMember");

		// Act
		const result = await createIsWorkspaceMember(db)("123", "123");

		// Assert
		expect(result).to.be.true;
	});

	it("should return false if user is not a member of the workspace", async function () {
		// Arrange
		const db = {
			workspace: {
				findUnique: sandbox.stub().resolves(),
			},
			workspaceMember: {
				findFirst: sandbox.stub().resolves(),
			},
		} as unknown as Database;

		const { createIsWorkspaceMember } =
			await import("../../src/workspaces/createIsWorkspaceMember");

		// Act
		const result = await createIsWorkspaceMember(db)("123", "123");

		// Assert
		expect(result).to.be.false;
	});
});
