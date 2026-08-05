import { status } from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DATABASE_ALREADY_EXISTS, Database } from "../../src/db";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const AVATAR_URL = "https://example.com/avatar.jpg";

describe("@identity[users/createUser]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a user", async function () {
		// Arrange
		const call = {
			request: {
				name: "John Doe",
				email: "john@example.com",
				password: "12345678",
				avatar: AVATAR_URL,
			},
		};

		const db = {
			user: {
				create: sandbox.stub().resolves({ ref: "123" }),
			},
		} as unknown as Database;

		const { createCreateUser } = await import("../../src/users/createCreateUser");

		// Act
		await createCreateUser(db)(call, (error, response) => {
			// Assert
			expect(response).to.deep.equal({ ref: "123" });
		});
	});

	it("should throw an error if user already exists", async function () {
		// Arrange
		const call = {
			request: {
				name: "John Doe",
				email: "john@example.com",
				password: "12345678",
				avatar: AVATAR_URL,
			},
		};

		const db = {
			user: {
				create: sandbox.stub().throws({ code: DATABASE_ALREADY_EXISTS }),
			},
		} as unknown as Database;

		const { createCreateUser } = await import("../../src/users/createCreateUser");

		// Act
		await createCreateUser(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: status.ALREADY_EXISTS,
				message: "The resource already exists",
			});
		});
	});

	it("should throw if a validation error occurs", async function () {
		// Arrange
		const call = {
			request: {
				name: "John Doe",
				email: "malformed-email",
				password: "12345678",
				avatar: AVATAR_URL,
			},
		};

		// Doesn't matter because it will not be called
		const db = {} as unknown as Database;

		const { createCreateUser } = await import("../../src/users/createCreateUser");

		// Act
		await createCreateUser(db)(call, (error) => {
			// Assert
			expect(error).to.deep.equal({
				code: status.INVALID_ARGUMENT,
				// eslint-disable-next-line prettier/prettier
				message: 'Invalid email at "email"',
			});
		});
	});
});
