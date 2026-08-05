import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DATABASE_NOT_FOUND, Database } from "../../src/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[users/deleteUser]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should delete a user by id", async function () {
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
        delete: sandbox.stub().resolves()
      }
    } as unknown as Database;

    const { createDeleteUser } =
      await import("../../src/users/createDeleteUser");

    // Act
    const response = await new Promise((resolve, reject) => {
      createDeleteUser(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    expect(response).to.deep.equal({ ref: "123" });
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
        delete: sandbox.stub().throws({ code: DATABASE_NOT_FOUND })
      }
    } as unknown as Database;

    const { createDeleteUser } =
      await import("../../src/users/createDeleteUser");

    // Act
    await createDeleteUser(db)(call, (error) => {
      // Assert
      expect(error).to.deep.equal({
        code: grpc.status.NOT_FOUND,
        message: "The requested resource was not found"
      });
    });
  });
});
