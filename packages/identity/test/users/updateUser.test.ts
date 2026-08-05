import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { DATABASE_NOT_FOUND, Database } from "../../src/db";
import { TEST_TOKEN, TEST_UUID } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[users/updateUser]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should update a user", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: TEST_UUID,
        name: "John Doex"
      }
    };

    const db = {
      user: {
        update: sandbox.stub().resolves({ ref: TEST_UUID })
      }
    } as unknown as Database;

    const { createUpdateUser } =
      await import("../../src/users/createUpdateUser");

    // Act
    const response = await new Promise((resolve, reject) => {
      createUpdateUser(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    expect(response).to.deep.equal({ ref: TEST_UUID });
  });

  it("should throw an error if the user does not exist", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: TEST_UUID,
        name: "John Doex"
      }
    };

    const db = {
      user: {
        update: sandbox.stub().throws({ code: DATABASE_NOT_FOUND })
      }
    } as unknown as Database;

    const { createUpdateUser } =
      await import("../../src/users/createUpdateUser");

    // Act
    const response = new Promise((resolve, reject) => {
      createUpdateUser(db)(call, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });

    // Assert
    await expect(response).to.be.rejectedWith(
      "The requested resource was not found"
    );
  });
});
