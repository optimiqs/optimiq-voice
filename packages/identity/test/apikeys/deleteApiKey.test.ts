import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { Database } from "../../src/db";
import { TEST_TOKEN } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@identity[apikeys/deleteApiKey]", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should delete an ApiKey", async function () {
    // Arrange
    const metadata = new grpc.Metadata();
    metadata.set("token", TEST_TOKEN);

    const call = {
      metadata,
      request: {
        ref: "123"
      }
    };

    const res = {
      ref: "123"
    };

    const db = {
      apiKey: {
        delete: sandbox.stub().resolves(res)
      }
    } as unknown as Database;

    const { createDeleteApiKey } =
      await import("../../src/apikeys/createDeleteApiKey");

    // Act
    await createDeleteApiKey(db)(call, (error, response) => {
      // Assert
      expect(response).to.have.property("ref", "123");
    });
  });
});
