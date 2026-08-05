import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { datesMapper } from "@optimiq-voice/common";
import { Database } from "../../src/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[users/getUser]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should get a user by id", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: "123"
      }
    };

    const user = {
      ref: "123",
      email: "john@example.com",
      name: "John Doe",
      avatar: "https://example.com/avatar.jpg",
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const db = {
      user: {
        findUnique: sandbox.stub().resolves(user)
      }
    } as unknown as Database;

    const { createGetUser } = await import("../../src/users/createGetUser");

    // Act
    const response = await new Promise((resolve, reject) => {
      createGetUser(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    expect(response).to.deep.equal(datesMapper(user));
  });

  it("should throw an error if user not found", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: "123"
      }
    };

    const db = {
      user: {
        findUnique: sandbox.stub().resolves(null)
      }
    } as unknown as Database;

    const { createGetUser } = await import("../../src/users/createGetUser");

    // Act
    await createGetUser(db)(call, (error) => {
      // Assert
      expect(error).to.deep.equal({
        code: grpc.status.NOT_FOUND,
        message: "User not found: 123"
      });
    });
  });
});
